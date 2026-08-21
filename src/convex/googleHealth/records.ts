import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { canonicalJson, canonicalPhysicalCoverageKey, sha256Base64Url } from './normalize';
import { getMetricDefinition } from './registry';
import {
	normalizedHealthPointValidator,
	pageCountsValidator,
	syncTriggerValidator,
	type NormalizedHealthPoint
} from './validators';

const MAX_MUTATION_POINTS = 16;
const CLEANUP_PAGE_SIZE = 64;
const SUMMARY_PAGE_SIZE = 128;
const SUMMARY_DEPENDENCY_PAGE_SIZE = 32;
const RUN_LEASE_MS = 5 * 60 * 1000;

const coveredRangeValidator = v.union(
	v.object({ kind: v.literal('physical'), startKey: v.string(), endKeyExclusive: v.string() }),
	v.object({ kind: v.literal('civil'), startDate: v.string(), endDateExclusive: v.string() })
);

const cleanupCompletionValidator = v.object({
	trigger: syncTriggerValidator,
	counts: pageCountsValidator,
	nextPageToken: v.optional(v.string()),
	nextWindowStart: v.optional(v.string()),
	nextWindowEnd: v.optional(v.string()),
	finish: v.boolean(),
	hadMalformed: v.boolean()
});

type CoveredRange =
	| { kind: 'physical'; startKey: string; endKeyExclusive: string }
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
			canonicalPhysicalCoverageKey(range.startKey) !== range.startKey ||
			canonicalPhysicalCoverageKey(range.endKeyExclusive) !== range.endKeyExclusive ||
			range.startKey >= range.endKeyExclusive
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
		...(point.physicalCoverageKey === undefined
			? {}
			: { physicalCoverageKey: point.physicalCoverageKey }),
		...(point.civilCoverageTime === undefined
			? {}
			: { civilCoverageTime: point.civilCoverageTime }),
		seenEpoch
	};
}

async function renewOwnedLease(
	ctx: MutationCtx,
	args: {
		connectionId: Id<'googleHealthConnections'>;
		cursorId: Id<'googleHealthSyncCursors'>;
		runId: Id<'googleHealthSyncRuns'>;
		generation: number;
	}
): Promise<boolean> {
	const [connection, cursor, run] = await Promise.all([
		ctx.db.get('googleHealthConnections', args.connectionId),
		ctx.db.get('googleHealthSyncCursors', args.cursorId),
		ctx.db.get('googleHealthSyncRuns', args.runId)
	]);
	if (
		!connection ||
		!cursor ||
		!run ||
		run.status !== 'running' ||
		run.cursorId !== cursor._id ||
		run.connectionId !== connection._id ||
		run.generation !== args.generation ||
		cursor.status !== 'running' ||
		cursor.generation !== args.generation ||
		cursor.activeRunId !== run._id ||
		connection.generation !== args.generation ||
		connection.activeSyncCursorId !== cursor._id ||
		connection.activeSyncRunId !== run._id ||
		cursor.leaseVersion === undefined ||
		cursor.leaseVersion !== connection.syncLeaseVersion
	)
		return false;
	const leaseVersion = cursor.leaseVersion + 1;
	const leaseExpiresAt = Date.now() + RUN_LEASE_MS;
	await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
		leaseVersion,
		leaseExpiresAt,
		updatedAt: Date.now()
	});
	await ctx.db.patch('googleHealthConnections', connection._id, {
		syncLeaseVersion: leaseVersion,
		syncLeaseExpiresAt: leaseExpiresAt
	});
	await ctx.scheduler.runAfter(RUN_LEASE_MS, internal.googleHealth.sync.recoverStaleRun, {
		cursorId: cursor._id,
		generation: args.generation,
		runId: run._id,
		leaseVersion,
		leaseExpiresAt
	});
	return true;
}

async function renewDependentConnectionLease(
	ctx: MutationCtx,
	rebuild: Doc<'healthSummaryRebuilds'>
): Promise<boolean> {
	const connection = await ctx.db.get('googleHealthConnections', rebuild.connectionId);
	if (
		!connection ||
		connection.activeSyncCursorId === undefined ||
		connection.activeSyncRunId === undefined
	)
		return false;
	const run = await ctx.db.get('googleHealthSyncRuns', connection.activeSyncRunId);
	if (run?.generation === undefined) return false;
	const dependency = await ctx.db
		.query('healthSummaryDependencies')
		.withIndex('by_runId_and_dataType_and_localDate', (q) =>
			q.eq('runId', run._id).eq('dataType', rebuild.dataType).eq('localDate', rebuild.localDate)
		)
		.unique();
	if (
		!dependency ||
		dependency.connectionId !== connection._id ||
		dependency.cursorId !== connection.activeSyncCursorId ||
		dependency.rebuildId !== rebuild._id ||
		dependency.targetVersion > rebuild.version
	)
		return false;
	return await renewOwnedLease(ctx, {
		connectionId: connection._id,
		cursorId: connection.activeSyncCursorId,
		runId: connection.activeSyncRunId,
		generation: run.generation
	});
}

async function enqueueSummary(
	ctx: MutationCtx,
	args: {
		connectionId: Id<'googleHealthConnections'>;
		userId: string;
		dataType: string;
		category: Doc<'healthDataPointContributions'>['category'];
		localDate: string;
		cursorId?: Id<'googleHealthSyncCursors'>;
		runId?: Id<'googleHealthSyncRuns'>;
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
		workingVersion: undefined,
		paginationCursor: undefined,
		dependencyCursor: undefined,
		dependencyDrainVersion: undefined,
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
	let rebuildId: Id<'healthSummaryRebuilds'>;
	let shouldSchedule = false;
	if (!existing) {
		rebuildId = await ctx.db.insert('healthSummaryRebuilds', reset);
		shouldSchedule = true;
	} else {
		rebuildId = existing._id;
		if (existing.status === 'complete') {
			await ctx.db.patch('healthSummaryRebuilds', existing._id, reset);
			shouldSchedule = true;
		} else {
			// The existing worker owns the one durable chain. A version bump makes it
			// restart from the beginning without fanning out scheduler jobs.
			await ctx.db.patch('healthSummaryRebuilds', existing._id, {
				version,
				updatedAt: Date.now()
			});
		}
	}
	if ((args.cursorId === undefined) !== (args.runId === undefined))
		throw new Error('summary dependency ownership must be provided together');
	if (args.cursorId !== undefined && args.runId !== undefined) {
		const cursorId = args.cursorId;
		const runId = args.runId;
		const dependency = await ctx.db
			.query('healthSummaryDependencies')
			.withIndex('by_runId_and_dataType_and_localDate', (q) =>
				q.eq('runId', runId).eq('dataType', args.dataType).eq('localDate', args.localDate)
			)
			.unique();
		const value = {
			connectionId: args.connectionId,
			cursorId,
			runId,
			rebuildId,
			userId: args.userId,
			dataType: args.dataType,
			localDate: args.localDate,
			targetVersion: version
		};
		if (dependency) await ctx.db.replace('healthSummaryDependencies', dependency._id, value);
		else await ctx.db.insert('healthSummaryDependencies', value);
	}
	if (shouldSchedule)
		await ctx.scheduler.runAfter(0, internal.googleHealth.records.rebuildSummaryBatch, {
			rebuildId
		});
}

export async function deleteNamedGooglePoint(
	ctx: MutationCtx,
	args: {
		connection: Doc<'googleHealthConnections'>;
		dataType: string;
		googleDataPointNames: readonly string[];
	}
): Promise<boolean> {
	let blockedThroughEpoch = args.connection.reconciliationEpoch ?? 0;
	if (
		args.connection.activeSyncCursorId !== undefined &&
		args.connection.activeSyncRunId !== undefined
	) {
		const activeCursor = await ctx.db.get(
			'googleHealthSyncCursors',
			args.connection.activeSyncCursorId
		);
		if (
			activeCursor !== null &&
			activeCursor.connectionId === args.connection._id &&
			activeCursor.generation === args.connection.generation &&
			activeCursor.activeRunId === args.connection.activeSyncRunId
		) {
			blockedThroughEpoch = Math.max(
				blockedThroughEpoch,
				activeCursor.activeEpoch ?? activeCursor.reconciliationEpoch ?? 0
			);
		}
	}
	const contributions = new Map<
		Id<'healthDataPointContributions'>,
		Doc<'healthDataPointContributions'>
	>();
	const tombstonedRecordKeys = new Set<string>();
	let matched = false;
	for (const googleDataPointName of new Set(args.googleDataPointNames)) {
		const recordKey = sha256Base64Url(
			`${args.dataType}\n${canonicalJson({ kind: 'named', name: googleDataPointName })}`
		);
		const tombstone = await ctx.db
			.query('googleHealthRecordTombstones')
			.withIndex('by_connectionId_and_generation_and_recordKey', (q) =>
				q
					.eq('connectionId', args.connection._id)
					.eq('generation', args.connection.generation)
					.eq('recordKey', recordKey)
			)
			.unique();
		if (tombstone !== null) {
			matched = true;
			tombstonedRecordKeys.add(recordKey);
			if (tombstone.blockedThroughEpoch < blockedThroughEpoch) {
				await ctx.db.patch('googleHealthRecordTombstones', tombstone._id, {
					blockedThroughEpoch,
					updatedAt: Date.now()
				});
			}
		}
		const contribution = await ctx.db
			.query('healthDataPointContributions')
			.withIndex('by_userId_and_recordKey', (q) =>
				q.eq('userId', args.connection.userId).eq('recordKey', recordKey)
			)
			.unique();
		if (
			!contribution ||
			contribution.connectionId !== args.connection._id ||
			contribution.dataType !== args.dataType
		) {
			continue;
		}
		matched = true;
		contributions.set(contribution._id, contribution);
	}
	const deletedPointIds = new Set<Id<'healthDataPoints'>>();
	for (const contribution of contributions.values()) {
		if (!tombstonedRecordKeys.has(contribution.recordKey)) {
			await ctx.db.insert('googleHealthRecordTombstones', {
				connectionId: args.connection._id,
				userId: args.connection.userId,
				generation: args.connection.generation,
				dataType: args.dataType,
				recordKey: contribution.recordKey,
				blockedThroughEpoch,
				updatedAt: Date.now()
			});
			tombstonedRecordKeys.add(contribution.recordKey);
		}
		if (!deletedPointIds.has(contribution.dataPointId)) {
			const point = await ctx.db.get('healthDataPoints', contribution.dataPointId);
			if (
				point !== null &&
				point.connectionId === args.connection._id &&
				point.userId === args.connection.userId &&
				point.dataType === args.dataType &&
				point.recordKey === contribution.recordKey
			) {
				await ctx.db.delete('healthDataPoints', point._id);
				deletedPointIds.add(point._id);
			}
		}
		await ctx.db.delete('healthDataPointContributions', contribution._id);
		await enqueueSummary(ctx, {
			connectionId: args.connection._id,
			userId: args.connection.userId,
			dataType: contribution.dataType,
			category: contribution.category,
			localDate: contribution.localDate
		});
	}
	return matched;
}

export async function clearNamedGooglePointTombstones(
	ctx: MutationCtx,
	args: {
		connection: Doc<'googleHealthConnections'>;
		dataType: string;
		googleDataPointNames: readonly string[];
	}
): Promise<void> {
	for (const googleDataPointName of new Set(args.googleDataPointNames)) {
		const recordKey = sha256Base64Url(
			`${args.dataType}\n${canonicalJson({ kind: 'named', name: googleDataPointName })}`
		);
		const tombstone = await ctx.db
			.query('googleHealthRecordTombstones')
			.withIndex('by_connectionId_and_generation_and_recordKey', (q) =>
				q
					.eq('connectionId', args.connection._id)
					.eq('generation', args.connection.generation)
					.eq('recordKey', recordKey)
			)
			.unique();
		if (tombstone !== null) await ctx.db.delete('googleHealthRecordTombstones', tombstone._id);
	}
}

export const rebuildSummaryBatch = internalMutation({
	args: { rebuildId: v.id('healthSummaryRebuilds') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const rebuild = await ctx.db.get('healthSummaryRebuilds', args.rebuildId);
		if (!rebuild || rebuild.status === 'complete') return null;
		const restarting = rebuild.status === 'queued' || rebuild.workingVersion !== rebuild.version;
		const workingVersion = rebuild.version;
		await renewDependentConnectionLease(ctx, rebuild);
		if (!restarting && rebuild.dependencyDrainVersion === workingVersion) {
			const dependencyPage = await ctx.db
				.query('healthSummaryDependencies')
				.withIndex('by_rebuildId_and_targetVersion', (q) =>
					q.eq('rebuildId', rebuild._id).lte('targetVersion', workingVersion)
				)
				.paginate({
					numItems: SUMMARY_DEPENDENCY_PAGE_SIZE,
					cursor: rebuild.dependencyCursor ?? null
				});
			const runs = new Set<Id<'googleHealthSyncRuns'>>();
			for (const dependency of dependencyPage.page) {
				runs.add(dependency.runId);
				await ctx.db.delete('healthSummaryDependencies', dependency._id);
			}
			for (const runId of runs)
				await ctx.scheduler.runAfter(0, internal.googleHealth.sync.tryFinalizeRun, { runId });
			if (!dependencyPage.isDone) {
				await ctx.db.patch('healthSummaryRebuilds', rebuild._id, {
					dependencyCursor: dependencyPage.continueCursor,
					updatedAt: Date.now()
				});
				await ctx.scheduler.runAfter(0, internal.googleHealth.records.rebuildSummaryBatch, args);
				return null;
			}
			await ctx.db.patch('healthSummaryRebuilds', rebuild._id, {
				status: 'complete',
				dependencyCursor: undefined,
				dependencyDrainVersion: undefined,
				updatedAt: Date.now()
			});
			return null;
		}
		const paginationCursor = restarting ? null : (rebuild.paginationCursor ?? null);
		const page = await ctx.db
			.query('healthDataPointContributions')
			.withIndex('by_userId_and_dataType_and_localDate', (q) =>
				q
					.eq('userId', rebuild.userId)
					.eq('dataType', rebuild.dataType)
					.eq('localDate', rebuild.localDate)
			)
			.paginate({ numItems: SUMMARY_PAGE_SIZE, cursor: paginationCursor });
		let count = restarting ? 0 : rebuild.count;
		let valueCount = restarting ? 0 : rebuild.valueCount;
		let sum = restarting ? 0 : rebuild.sum;
		let min = restarting ? undefined : rebuild.min;
		let max = restarting ? undefined : rebuild.max;
		let latestTimestamp = restarting ? undefined : rebuild.latestTimestamp;
		let latestValue = restarting ? undefined : rebuild.latestValue;
		let durationSeconds = restarting ? 0 : rebuild.durationSeconds;
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
				workingVersion,
				paginationCursor: page.continueCursor,
				dependencyCursor: undefined,
				dependencyDrainVersion: undefined,
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
			status: 'running',
			workingVersion,
			paginationCursor: undefined,
			dependencyCursor: undefined,
			dependencyDrainVersion: workingVersion,
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
				cursor.activeEpoch !== seenEpoch ||
				connection.activeSyncCursorId !== cursor._id ||
				connection.activeSyncRunId !== args.runId
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
			const tombstone = await ctx.db
				.query('googleHealthRecordTombstones')
				.withIndex('by_connectionId_and_generation_and_recordKey', (q) =>
					q
						.eq('connectionId', connection._id)
						.eq('generation', args.expectedGeneration)
						.eq('recordKey', point.recordKey)
				)
				.unique();
			if (tombstone !== null) {
				if (seenEpoch <= tombstone.blockedThroughEpoch) {
					skipped += 1;
					continue;
				}
				await ctx.db.delete('googleHealthRecordTombstones', tombstone._id);
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
				localDate,
				...(args.cursorId === undefined ? {} : { cursorId: args.cursorId, runId: args.runId })
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
		const connection = await ctx.db.get('googleHealthConnections', args.connectionId);
		if (
			!cursor ||
			!connection ||
			cursor.connectionId !== args.connectionId ||
			cursor.generation !== args.expectedGeneration ||
			cursor.status !== 'running' ||
			cursor.activeRunId !== args.runId ||
			cursor.activeEpoch !== args.cleanupEpoch ||
			connection.activeSyncCursorId !== cursor._id ||
			connection.activeSyncRunId !== args.runId
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
			connection.activeSyncCursorId !== cursor._id ||
			connection.activeSyncRunId !== run._id ||
			run.status !== 'running'
		)
			return null;
		if (
			run.cursorId !== cursor._id ||
			run.connectionId !== connection._id ||
			run.generation !== args.expectedGeneration
		)
			return null;
		const range = args.coveredRange;
		const page =
			range.kind === 'physical'
				? await ctx.db
						.query('healthDataPointContributions')
						.withIndex('by_connectionId_and_dataType_and_physicalCoverageKey', (q) =>
							q
								.eq('connectionId', connection._id)
								.eq('dataType', args.dataType)
								.gte('physicalCoverageKey', range.startKey)
								.lt('physicalCoverageKey', range.endKeyExclusive)
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
				localDate,
				cursorId: cursor._id,
				runId: run._id
			});
		}
		if (deleted > 0)
			await ctx.db.patch('googleHealthSyncRuns', run._id, { deleted: run.deleted + deleted });
		if (
			!(await renewOwnedLease(ctx, {
				connectionId: connection._id,
				cursorId: cursor._id,
				runId: run._id,
				generation: args.expectedGeneration
			}))
		)
			return null;
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
