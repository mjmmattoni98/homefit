import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { getMetricDefinition } from './registry';
import {
	normalizedHealthPointValidator,
	syncTriggerValidator,
	type NormalizedHealthPoint
} from './validators';

const MAX_MUTATION_POINTS = 16;
const CLEANUP_PAGE_SIZE = 64;
const SUMMARY_PAGE_SIZE = 128;

const coveredRangeValidator = v.union(
	v.object({ kind: v.literal('physical'), startMs: v.number(), endMsExclusive: v.number() }),
	v.object({ kind: v.literal('civil'), startDate: v.string(), endDateExclusive: v.string() })
);

const pageCountsValidator = v.object({
	fetched: v.number(),
	inserted: v.number(),
	updated: v.number(),
	skipped: v.number()
});

const cleanupCompletionValidator = v.object({
	trigger: syncTriggerValidator,
	counts: pageCountsValidator,
	nextPageToken: v.optional(v.string()),
	nextWindowStart: v.optional(v.string()),
	nextWindowEnd: v.optional(v.string()),
	finish: v.boolean()
});

type CoveredRange =
	| { kind: 'physical'; startMs: number; endMsExclusive: number }
	| { kind: 'civil'; startDate: string; endDateExclusive: string };

function isValidCivil(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/.exec(
		value
	);
	if (match === null) return false;
	const [year, month, day, hours, minutes, seconds] = match
		.slice(1)
		.map((part) => Number(part ?? 0));
	const date = new Date(0);
	date.setUTCHours(0, 0, 0, 0);
	date.setUTCFullYear(year, month - 1, day);
	return (
		year >= 1 &&
		year <= 9999 &&
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day &&
		hours <= 23 &&
		minutes <= 59 &&
		seconds <= 59
	);
}

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
		!isValidCivil(range.startDate) ||
		!isValidCivil(range.endDateExclusive) ||
		range.startDate >= range.endDateExclusive
	) {
		throw new Error('invalid civil covered range');
	}
}

function contributionFor(
	connection: Doc<'googleHealthConnections'>,
	dataPointId: Id<'healthDataPoints'>,
	point: Doc<'healthDataPoints'> | NormalizedHealthPoint,
	seenEpoch: number
) {
	const durationSeconds =
		point.startTime !== undefined && point.endTime !== undefined && point.endTime >= point.startTime
			? (point.endTime - point.startTime) / 1000
			: undefined;
	return {
		connectionId: connection._id,
		dataPointId,
		userId: connection.userId,
		recordKey: point.recordKey,
		dataType: point.dataType,
		category: point.category,
		localDate: point.localDate,
		recordTimestamp: point.recordTimestamp,
		...(point.primaryValue === undefined ? {} : { primaryValue: point.primaryValue }),
		...(durationSeconds === undefined ? {} : { durationSeconds }),
		...(point.physicalCoverageTime === undefined
			? {}
			: { physicalCoverageTime: point.physicalCoverageTime }),
		...(point.civilCoverageTime === undefined
			? {}
			: { civilCoverageTime: point.civilCoverageTime }),
		seenEpoch
	};
}

async function enqueueSummary(
	ctx: MutationCtx,
	args: {
		connectionId: Id<'googleHealthConnections'>;
		userId: string;
		dataType: string;
		category: Doc<'healthDataPointContributions'>['category'];
		localDate: string;
	}
): Promise<void> {
	const existing = await ctx.db
		.query('healthSummaryRebuilds')
		.withIndex('by_userId_and_dataType_and_localDate', (q) =>
			q.eq('userId', args.userId).eq('dataType', args.dataType).eq('localDate', args.localDate)
		)
		.unique();
	const version = (existing?.version ?? 0) + 1;
	const reset = {
		connectionId: args.connectionId,
		userId: args.userId,
		dataType: args.dataType,
		category: args.category,
		localDate: args.localDate,
		version,
		status: 'queued' as const,
		paginationCursor: undefined,
		count: 0,
		valueCount: 0,
		sum: 0,
		min: undefined,
		max: undefined,
		latestValue: undefined,
		latestTimestamp: undefined,
		durationSeconds: 0,
		updatedAt: Date.now()
	};
	const rebuildId = existing
		? (await ctx.db.patch('healthSummaryRebuilds', existing._id, reset), existing._id)
		: await ctx.db.insert('healthSummaryRebuilds', reset);
	await ctx.scheduler.runAfter(0, internal.googleHealth.records.rebuildSummaryBatch, {
		rebuildId,
		version
	});
}

export const rebuildSummaryBatch = internalMutation({
	args: { rebuildId: v.id('healthSummaryRebuilds'), version: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const rebuild = await ctx.db.get('healthSummaryRebuilds', args.rebuildId);
		if (!rebuild || rebuild.version !== args.version || rebuild.status === 'complete') return null;
		const page = await ctx.db
			.query('healthDataPointContributions')
			.withIndex('by_userId_and_dataType_and_localDate', (q) =>
				q
					.eq('userId', rebuild.userId)
					.eq('dataType', rebuild.dataType)
					.eq('localDate', rebuild.localDate)
			)
			.paginate({ numItems: SUMMARY_PAGE_SIZE, cursor: rebuild.paginationCursor ?? null });
		let count = rebuild.count;
		let valueCount = rebuild.valueCount;
		let sum = rebuild.sum;
		let min = rebuild.min;
		let max = rebuild.max;
		let latestTimestamp = rebuild.latestTimestamp;
		let latestValue = rebuild.latestValue;
		let durationSeconds = rebuild.durationSeconds;
		for (const row of page.page) {
			count += 1;
			if (row.primaryValue !== undefined) {
				valueCount += 1;
				sum += row.primaryValue;
				min = min === undefined ? row.primaryValue : Math.min(min, row.primaryValue);
				max = max === undefined ? row.primaryValue : Math.max(max, row.primaryValue);
			}
			if (latestTimestamp === undefined || row.recordTimestamp > latestTimestamp) {
				latestTimestamp = row.recordTimestamp;
				latestValue = row.primaryValue;
			}
			durationSeconds += row.durationSeconds ?? 0;
		}
		if (!page.isDone) {
			await ctx.db.patch('healthSummaryRebuilds', rebuild._id, {
				status: 'running',
				paginationCursor: page.continueCursor,
				count,
				valueCount,
				sum,
				min,
				max,
				latestValue,
				latestTimestamp,
				durationSeconds,
				updatedAt: Date.now()
			});
			await ctx.scheduler.runAfter(0, internal.googleHealth.records.rebuildSummaryBatch, args);
			return null;
		}

		const existing = await ctx.db
			.query('healthDailySummaries')
			.withIndex('by_userId_and_dataType_and_localDate', (q) =>
				q
					.eq('userId', rebuild.userId)
					.eq('dataType', rebuild.dataType)
					.eq('localDate', rebuild.localDate)
			)
			.unique();
		if (count === 0) {
			if (existing) await ctx.db.delete('healthDailySummaries', existing._id);
		} else {
			const summary = {
				connectionId: rebuild.connectionId,
				userId: rebuild.userId,
				dataType: rebuild.dataType,
				category: rebuild.category,
				localDate: rebuild.localDate,
				count,
				...(latestValue === undefined ? {} : { latestValue }),
				...(latestTimestamp === undefined ? {} : { latestTimestamp }),
				...(valueCount === 0 ? {} : { sum, average: sum / valueCount, min, max }),
				...(durationSeconds === 0 ? {} : { durationSeconds }),
				computedAt: Date.now()
			};
			if (existing) await ctx.db.replace('healthDailySummaries', existing._id, summary);
			else await ctx.db.insert('healthDailySummaries', summary);
		}
		await ctx.db.patch('healthSummaryRebuilds', rebuild._id, {
			status: 'complete',
			paginationCursor: undefined,
			count,
			valueCount,
			sum,
			min,
			max,
			latestValue,
			latestTimestamp,
			durationSeconds,
			updatedAt: Date.now()
		});
		return null;
	}
});

export const applyReconciledPage = internalMutation({
	args: {
		connectionId: v.id('googleHealthConnections'),
		expectedGeneration: v.number(),
		dataType: v.string(),
		points: v.array(normalizedHealthPointValidator),
		syncId: v.string(),
		seenEpoch: v.optional(v.number()),
		cursorId: v.optional(v.id('googleHealthSyncCursors')),
		runId: v.optional(v.id('googleHealthSyncRuns'))
	},
	returns: v.object({ inserted: v.number(), updated: v.number(), skipped: v.number() }),
	handler: async (ctx, args) => {
		if (args.points.length > MAX_MUTATION_POINTS)
			throw new Error('Google Health chunk exceeds cap');
		if (args.syncId.length === 0 || args.syncId.length > 512) throw new Error('invalid sync id');
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
		const seenEpoch = args.seenEpoch ?? 0;
		if (!Number.isSafeInteger(seenEpoch) || seenEpoch < 0) throw new Error('invalid seen epoch');
		if ((args.cursorId === undefined) !== (args.runId === undefined)) {
			throw new Error('cursor and run ownership must be provided together');
		}
		if (args.cursorId !== undefined && args.runId !== undefined) {
			const cursor = await ctx.db.get('googleHealthSyncCursors', args.cursorId);
			if (
				!cursor ||
				cursor.connectionId !== connection._id ||
				cursor.generation !== args.expectedGeneration ||
				cursor.status !== 'running' ||
				cursor.activeRunId !== args.runId ||
				cursor.activeEpoch !== seenEpoch
			) {
				throw new Error('stale Google Health chunk');
			}
		}
		let inserted = 0;
		let updated = 0;
		let skipped = 0;
		const affected = new Set<string>();
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
			let dataPointId: Id<'healthDataPoints'>;
			if (existing === null) {
				dataPointId = await ctx.db.insert('healthDataPoints', {
					connectionId: connection._id,
					userId: connection.userId,
					...point,
					lastSeenSyncId: args.syncId,
					seenEpoch
				});
				inserted += 1;
			} else {
				if (existing.connectionId !== connection._id || existing.dataType !== args.dataType) {
					throw new Error('Google Health record key ownership conflict');
				}
				dataPointId = existing._id;
				if ((existing.seenEpoch ?? 0) > seenEpoch) {
					skipped += 1;
					continue;
				}
				affected.add(existing.localDate);
				if (existing.payloadDigest === point.payloadDigest) {
					await ctx.db.patch('healthDataPoints', existing._id, {
						lastSeenSyncId: args.syncId,
						seenEpoch
					});
					skipped += 1;
				} else {
					await ctx.db.replace('healthDataPoints', existing._id, {
						connectionId: connection._id,
						userId: connection.userId,
						...point,
						lastSeenSyncId: args.syncId,
						seenEpoch
					});
					updated += 1;
				}
			}
			const contribution = await ctx.db
				.query('healthDataPointContributions')
				.withIndex('by_userId_and_recordKey', (q) =>
					q.eq('userId', connection.userId).eq('recordKey', point.recordKey)
				)
				.unique();
			const replacement = contributionFor(connection, dataPointId, point, seenEpoch);
			if (contribution)
				await ctx.db.replace('healthDataPointContributions', contribution._id, replacement);
			else await ctx.db.insert('healthDataPointContributions', replacement);
			affected.add(point.localDate);
		}
		for (const localDate of affected) {
			await enqueueSummary(ctx, {
				connectionId: connection._id,
				userId: connection.userId,
				dataType: args.dataType,
				category: definition.category,
				localDate
			});
		}
		return { inserted, updated, skipped };
	}
});

export const beginCleanup = internalMutation({
	args: {
		connectionId: v.id('googleHealthConnections'),
		cursorId: v.id('googleHealthSyncCursors'),
		runId: v.id('googleHealthSyncRuns'),
		expectedGeneration: v.number(),
		dataType: v.string(),
		cleanupEpoch: v.number(),
		coveredRange: coveredRangeValidator,
		completion: cleanupCompletionValidator
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		assertCoveredRange(args.coveredRange);
		if (!Number.isSafeInteger(args.cleanupEpoch) || args.cleanupEpoch < 1) {
			throw new Error('invalid cleanup epoch');
		}
		const cursor = await ctx.db.get('googleHealthSyncCursors', args.cursorId);
		if (
			!cursor ||
			cursor.connectionId !== args.connectionId ||
			cursor.generation !== args.expectedGeneration ||
			cursor.status !== 'running' ||
			cursor.activeRunId !== args.runId ||
			cursor.activeEpoch !== args.cleanupEpoch
		)
			return false;
		await ctx.scheduler.runAfter(0, internal.googleHealth.records.cleanupCoveredRange, {
			...args,
			paginationOpts: { numItems: CLEANUP_PAGE_SIZE, cursor: null }
		});
		return true;
	}
});

export const cleanupCoveredRange = internalMutation({
	args: {
		connectionId: v.id('googleHealthConnections'),
		cursorId: v.id('googleHealthSyncCursors'),
		runId: v.id('googleHealthSyncRuns'),
		expectedGeneration: v.number(),
		dataType: v.string(),
		cleanupEpoch: v.number(),
		coveredRange: coveredRangeValidator,
		completion: cleanupCompletionValidator,
		paginationOpts: paginationOptsValidator
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		assertCoveredRange(args.coveredRange);
		if (!Number.isSafeInteger(args.cleanupEpoch) || args.cleanupEpoch < 1) return null;
		const [connection, cursor, run] = await Promise.all([
			ctx.db.get('googleHealthConnections', args.connectionId),
			ctx.db.get('googleHealthSyncCursors', args.cursorId),
			ctx.db.get('googleHealthSyncRuns', args.runId)
		]);
		if (
			!connection ||
			!cursor ||
			!run ||
			connection.generation !== args.expectedGeneration ||
			cursor.connectionId !== connection._id ||
			cursor.generation !== args.expectedGeneration ||
			cursor.status !== 'running' ||
			cursor.activeRunId !== run._id ||
			cursor.activeEpoch !== args.cleanupEpoch ||
			run.status !== 'running'
		)
			return null;
		const range = args.coveredRange;
		const page =
			range.kind === 'physical'
				? await ctx.db
						.query('healthDataPointContributions')
						.withIndex('by_connectionId_and_dataType_and_physicalCoverageTime', (q) =>
							q
								.eq('connectionId', connection._id)
								.eq('dataType', args.dataType)
								.gte('physicalCoverageTime', range.startMs)
								.lt('physicalCoverageTime', range.endMsExclusive)
						)
						.paginate(args.paginationOpts)
				: await ctx.db
						.query('healthDataPointContributions')
						.withIndex('by_connectionId_and_dataType_and_civilCoverageTime', (q) =>
							q
								.eq('connectionId', connection._id)
								.eq('dataType', args.dataType)
								.gte('civilCoverageTime', range.startDate)
								.lt('civilCoverageTime', range.endDateExclusive)
						)
						.paginate(args.paginationOpts);
		let deleted = 0;
		const affected = new Set<string>();
		for (const row of page.page) {
			if (row.seenEpoch >= args.cleanupEpoch) continue;
			affected.add(row.localDate);
			await ctx.db.delete('healthDataPoints', row.dataPointId);
			await ctx.db.delete('healthDataPointContributions', row._id);
			deleted += 1;
		}
		for (const localDate of affected) {
			await enqueueSummary(ctx, {
				connectionId: connection._id,
				userId: connection.userId,
				dataType: args.dataType,
				category: getMetricDefinition(args.dataType)?.category ?? 'other',
				localDate
			});
		}
		if (deleted > 0)
			await ctx.db.patch('googleHealthSyncRuns', run._id, { deleted: run.deleted + deleted });
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.googleHealth.records.cleanupCoveredRange, {
				...args,
				paginationOpts: { numItems: CLEANUP_PAGE_SIZE, cursor: page.continueCursor }
			});
			return null;
		}
		await ctx.scheduler.runAfter(0, internal.googleHealth.sync.finalizeCleanup, {
			cursorId: cursor._id,
			generation: args.expectedGeneration,
			runId: run._id,
			...args.completion
		});
		return null;
	}
});
