import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { getMetricDefinition } from './registry';
import { normalizedHealthPointValidator } from './validators';

const MAX_PAGE_POINTS = 1000;
const CLEANUP_PAGE_SIZE = 256;
const SUMMARY_ROW_LIMIT = 10_001;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const coveredRangeValidator = v.union(
	v.object({
		kind: v.literal('physical'),
		startMs: v.number(),
		endMsExclusive: v.number()
	}),
	v.object({
		kind: v.literal('civil'),
		startDate: v.string(),
		endDateExclusive: v.string()
	})
);

type CoveredRange =
	| { kind: 'physical'; startMs: number; endMsExclusive: number }
	| { kind: 'civil'; startDate: string; endDateExclusive: string };

type SummaryRecord = Pick<
	Doc<'healthDataPoints'>,
	'recordTimestamp' | 'primaryValue' | 'startTime' | 'endTime'
>;

function assertCoveredRange(range: CoveredRange): void {
	if (range.kind === 'physical') {
		if (
			!Number.isFinite(range.startMs) ||
			!Number.isFinite(range.endMsExclusive) ||
			range.startMs >= range.endMsExclusive
		) {
			throw new Error('invalid physical covered range');
		}
		return;
	}
	if (
		!ISO_DATE.test(range.startDate) ||
		!ISO_DATE.test(range.endDateExclusive) ||
		range.startDate >= range.endDateExclusive
	) {
		throw new Error('invalid civil covered range');
	}
}

export function summarizeHealthRows(
	rows: readonly SummaryRecord[],
	exactLatest?: SummaryRecord
): {
	count: number;
	latestValue?: number;
	latestTimestamp?: number;
	sum?: number;
	average?: number;
	min?: number;
	max?: number;
	durationSeconds?: number;
} {
	let latest: SummaryRecord | undefined;
	let durationSeconds = 0;
	const values: number[] = [];
	for (const row of rows) {
		if (latest === undefined || row.recordTimestamp > latest.recordTimestamp) latest = row;
		if (row.primaryValue !== undefined && Number.isFinite(row.primaryValue)) {
			values.push(row.primaryValue);
		}
		if (row.startTime !== undefined && row.endTime !== undefined && row.endTime >= row.startTime) {
			durationSeconds += (row.endTime - row.startTime) / 1000;
		}
	}

	const boundedOut = rows.length >= SUMMARY_ROW_LIMIT;
	const latestRecord = exactLatest ?? latest;
	const latestValue = latestRecord?.primaryValue;
	const latestTimestamp = latestRecord?.recordTimestamp;
	if (boundedOut || values.length === 0) {
		return {
			count: rows.length,
			...(latestValue === undefined ? {} : { latestValue }),
			...(latestTimestamp === undefined ? {} : { latestTimestamp }),
			...(durationSeconds === 0 ? {} : { durationSeconds })
		};
	}

	const sum = values.reduce((total, value) => total + value, 0);
	return {
		count: rows.length,
		...(latestValue === undefined ? {} : { latestValue }),
		...(latestTimestamp === undefined ? {} : { latestTimestamp }),
		sum,
		average: sum / values.length,
		min: Math.min(...values),
		max: Math.max(...values),
		...(durationSeconds === 0 ? {} : { durationSeconds })
	};
}

async function rebuildSummary(
	ctx: MutationCtx,
	args: {
		connectionId: Doc<'googleHealthConnections'>['_id'];
		userId: string;
		dataType: string;
		localDate: string;
	}
): Promise<void> {
	const definition = getMetricDefinition(args.dataType);
	if (definition === null) throw new Error('unsupported Google Health data type');
	const rows = await ctx.db
		.query('healthDataPoints')
		.withIndex('by_userId_and_dataType_and_localDate', (q) =>
			q.eq('userId', args.userId).eq('dataType', args.dataType).eq('localDate', args.localDate)
		)
		.take(SUMMARY_ROW_LIMIT);
	const exactLatest =
		rows.length < SUMMARY_ROW_LIMIT
			? undefined
			: await ctx.db
					.query('healthDataPoints')
					.withIndex('by_userId_and_dataType_and_localDate_and_recordTimestamp', (q) =>
						q
							.eq('userId', args.userId)
							.eq('dataType', args.dataType)
							.eq('localDate', args.localDate)
					)
					.order('desc')
					.first();
	const existing = await ctx.db
		.query('healthDailySummaries')
		.withIndex('by_userId_and_dataType_and_localDate', (q) =>
			q.eq('userId', args.userId).eq('dataType', args.dataType).eq('localDate', args.localDate)
		)
		.unique();
	if (rows.length === 0) {
		if (existing) await ctx.db.delete('healthDailySummaries', existing._id);
		return;
	}

	const replacement = {
		connectionId: args.connectionId,
		userId: args.userId,
		dataType: args.dataType,
		category: definition.category,
		localDate: args.localDate,
		...summarizeHealthRows(rows, exactLatest ?? undefined),
		computedAt: Date.now()
	};
	if (existing) {
		await ctx.db.replace('healthDailySummaries', existing._id, replacement);
	} else {
		await ctx.db.insert('healthDailySummaries', replacement);
	}
}

export const applyReconciledPage = internalMutation({
	args: {
		connectionId: v.id('googleHealthConnections'),
		expectedGeneration: v.number(),
		dataType: v.string(),
		points: v.array(normalizedHealthPointValidator),
		syncId: v.string(),
		nextPageToken: v.optional(v.string()),
		coveredRange: v.optional(coveredRangeValidator)
	},
	returns: v.object({ inserted: v.number(), updated: v.number(), skipped: v.number() }),
	handler: async (ctx, args) => {
		if (args.points.length > MAX_PAGE_POINTS)
			throw new Error('Google Health page exceeds point cap');
		if (args.syncId.length === 0 || args.syncId.length > 512) throw new Error('invalid sync id');
		if (args.coveredRange !== undefined) {
			if (args.nextPageToken !== undefined) {
				throw new Error('covered range requires a final page');
			}
			assertCoveredRange(args.coveredRange);
		}
		const definition = getMetricDefinition(args.dataType);
		if (definition === null) throw new Error('unsupported Google Health data type');
		const connection = await ctx.db.get('googleHealthConnections', args.connectionId);
		if (
			!connection ||
			connection.generation !== args.expectedGeneration ||
			!['backfilling', 'active', 'delayed'].includes(connection.status)
		) {
			throw new Error('stale Google Health page');
		}

		let inserted = 0;
		let updated = 0;
		let skipped = 0;
		const affectedDates = new Set<string>();
		for (const point of args.points) {
			if (point.dataType !== args.dataType || point.category !== definition.category) {
				throw new Error('Google Health point does not match cursor data type');
			}
			const existing = await ctx.db
				.query('healthDataPoints')
				.withIndex('by_userId_and_recordKey', (q) =>
					q.eq('userId', connection.userId).eq('recordKey', point.recordKey)
				)
				.unique();
			affectedDates.add(point.localDate);
			if (existing === null) {
				await ctx.db.insert('healthDataPoints', {
					connectionId: connection._id,
					userId: connection.userId,
					...point,
					lastSeenSyncId: args.syncId
				});
				inserted += 1;
				continue;
			}
			if (existing.connectionId !== connection._id || existing.dataType !== args.dataType) {
				throw new Error('Google Health record key ownership conflict');
			}
			if (existing.payloadDigest === point.payloadDigest) {
				if (existing.lastSeenSyncId !== args.syncId) {
					await ctx.db.patch('healthDataPoints', existing._id, { lastSeenSyncId: args.syncId });
				}
				skipped += 1;
				continue;
			}
			affectedDates.add(existing.localDate);
			await ctx.db.replace('healthDataPoints', existing._id, {
				connectionId: connection._id,
				userId: connection.userId,
				...point,
				lastSeenSyncId: args.syncId
			});
			updated += 1;
		}

		for (const localDate of affectedDates) {
			await rebuildSummary(ctx, {
				connectionId: connection._id,
				userId: connection.userId,
				dataType: args.dataType,
				localDate
			});
		}
		if (args.coveredRange !== undefined) {
			await ctx.scheduler.runAfter(0, internal.googleHealth.records.cleanupCoveredRange, {
				connectionId: connection._id,
				expectedGeneration: args.expectedGeneration,
				dataType: args.dataType,
				syncId: args.syncId,
				coveredRange: args.coveredRange,
				paginationOpts: { numItems: CLEANUP_PAGE_SIZE, cursor: null }
			});
		}
		return { inserted, updated, skipped };
	}
});

export const cleanupCoveredRange = internalMutation({
	args: {
		connectionId: v.id('googleHealthConnections'),
		expectedGeneration: v.number(),
		dataType: v.string(),
		syncId: v.string(),
		coveredRange: coveredRangeValidator,
		paginationOpts: paginationOptsValidator
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		assertCoveredRange(args.coveredRange);
		const connection = await ctx.db.get('googleHealthConnections', args.connectionId);
		if (
			!connection ||
			connection.generation !== args.expectedGeneration ||
			!['backfilling', 'active', 'delayed'].includes(connection.status)
		) {
			return null;
		}
		const coveredRange = args.coveredRange;
		const result =
			coveredRange.kind === 'physical'
				? await ctx.db
						.query('healthDataPoints')
						.withIndex('by_userId_and_dataType_and_recordTimestamp', (q) =>
							q
								.eq('userId', connection.userId)
								.eq('dataType', args.dataType)
								.gte('recordTimestamp', coveredRange.startMs)
								.lt('recordTimestamp', coveredRange.endMsExclusive)
						)
						.paginate(args.paginationOpts)
				: await ctx.db
						.query('healthDataPoints')
						.withIndex('by_userId_and_dataType_and_localDate', (q) =>
							q
								.eq('userId', connection.userId)
								.eq('dataType', args.dataType)
								.gte('localDate', coveredRange.startDate)
								.lt('localDate', coveredRange.endDateExclusive)
						)
						.paginate(args.paginationOpts);
		const affectedDates = new Set<string>();
		for (const row of result.page) {
			if (row.connectionId !== connection._id || row.lastSeenSyncId === args.syncId) continue;
			affectedDates.add(row.localDate);
			await ctx.db.delete('healthDataPoints', row._id);
		}
		for (const localDate of affectedDates) {
			await rebuildSummary(ctx, {
				connectionId: connection._id,
				userId: connection.userId,
				dataType: args.dataType,
				localDate
			});
		}
		if (!result.isDone) {
			await ctx.scheduler.runAfter(0, internal.googleHealth.records.cleanupCoveredRange, {
				connectionId: connection._id,
				expectedGeneration: args.expectedGeneration,
				dataType: args.dataType,
				syncId: args.syncId,
				coveredRange: args.coveredRange,
				paginationOpts: { numItems: CLEANUP_PAGE_SIZE, cursor: result.continueCursor }
			});
		}
		return null;
	}
});
