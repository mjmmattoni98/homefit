import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	env,
	internalAction,
	internalMutation,
	type ActionCtx,
	type MutationCtx
} from '../_generated/server';
import {
	GoogleHealthError,
	fetchGoogleHealthDataPage,
	refreshAccessToken,
	type GoogleHealthTimeFilter
} from './apiClient';
import {
	createTokenKeyring,
	encryptRefreshToken,
	rotateRefreshTokenEnvelope,
	type EncryptedTokenEnvelope
} from './crypto';
import { canonicalPhysicalCoverageKey, normalizeGooglePoint } from './normalize';
import { getMetricDefinition, type MetricDefinition } from './registry';
import {
	type NormalizedHealthPoint,
	pageCountsValidator,
	syncTriggerValidator,
	type PageCounts,
	type SyncTrigger
} from './validators';

const FIRST_ROLLUP_DATE = '2000-01-01';
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const RUN_LEASE_MS = 5 * 60 * 1000;
const CONNECTION_BUSY_RETRY_MS = 5_000;
const MAX_CURSOR_LOOKAHEAD = 100;
const MAX_CHUNK_POINTS = 16;
const MAX_CHUNK_UTF8_BYTES = 1_500_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SYNCABLE_STATUSES = new Set(['backfilling', 'active', 'delayed']);

const cursorWorkValidator = v.object({
	connectionId: v.id('googleHealthConnections'),
	userId: v.string(),
	cursorId: v.id('googleHealthSyncCursors'),
	dataType: v.string(),
	mode: v.union(v.literal('backfill'), v.literal('incremental')),
	pageToken: v.optional(v.string()),
	windowStart: v.optional(v.string()),
	windowEnd: v.optional(v.string()),
	syncId: v.string(),
	attempt: v.number(),
	generation: v.number(),
	runId: v.id('googleHealthSyncRuns'),
	reconciliationEpoch: v.number(),
	leaseVersion: v.number(),
	hadMalformed: v.boolean()
});

type CursorWork = {
	connectionId: Id<'googleHealthConnections'>;
	userId: string;
	cursorId: Id<'googleHealthSyncCursors'>;
	dataType: string;
	mode: 'backfill' | 'incremental';
	pageToken?: string;
	windowStart?: string;
	windowEnd?: string;
	syncId: string;
	attempt: number;
	generation: number;
	runId: Id<'googleHealthSyncRuns'>;
	reconciliationEpoch: number;
	leaseVersion: number;
	hadMalformed: boolean;
};

type Completion = {
	trigger: SyncTrigger;
	counts: PageCounts;
	nextPageToken?: string;
	nextWindowStart?: string;
	nextWindowEnd?: string;
	finish: boolean;
	hadMalformed: boolean;
};

function safeErrorCode(code: string): string {
	return /^[a-z0-9_.-]{1,80}$/.test(code) ? code : 'sync_error';
}

function isValidDate(value: string): boolean {
	if (!ISO_DATE.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isPhysical(value: string): boolean {
	const match =
		/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
			value
		);
	return (
		match !== null &&
		isValidDate(match[1]) &&
		Number(match[2]) <= 23 &&
		Number(match[3]) <= 59 &&
		Number(match[4]) <= 59 &&
		Number(match[5] ?? 0) <= 23 &&
		Number(match[6] ?? 0) <= 59 &&
		Number.isFinite(Date.parse(value))
	);
}

function isCivil(value: string): boolean {
	const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/.exec(value);
	return (
		match !== null &&
		isValidDate(match[1]) &&
		Number(match[2] ?? 0) <= 23 &&
		Number(match[3] ?? 0) <= 59 &&
		Number(match[4] ?? 0) <= 59
	);
}

function addDays(value: string, days: number): string {
	if (!isValidDate(value) || !Number.isInteger(days)) throw new Error('invalid civil date');
	const date = new Date(`${value}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function minDate(left: string, right: string): string {
	return left < right ? left : right;
}
function currentExclusiveCivilDate(): string {
	return addDays(new Date(Date.now()).toISOString().slice(0, 10), 1);
}

export function computeRetryDelayMs(attempt: number, random: () => number = Math.random): number {
	const safeAttempt = Number.isInteger(attempt) && attempt >= 0 ? Math.min(attempt, 30) : 0;
	const base = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** safeAttempt);
	const sample = Math.min(1, Math.max(0, random()));
	return Math.floor(base * (0.8 + sample * 0.4));
}

function pageSizeFor(dataType: string): number {
	return dataType === 'sleep' || dataType === 'exercise' ? 25 : 1000;
}

function timeFilterFor(
	work: CursorWork,
	definition: MetricDefinition
): GoogleHealthTimeFilter | undefined {
	if (work.mode !== 'incremental' || work.windowStart === undefined || work.windowEnd === undefined)
		return undefined;
	const physical = definition.filterStrategies.physical;
	if (physical !== undefined && isPhysical(work.windowStart) && isPhysical(work.windowEnd)) {
		return {
			axis: 'physical',
			field: physical.field,
			comparison: physical.comparison,
			start: work.windowStart,
			...(physical.comparison === 'closedOpen' ? { end: work.windowEnd } : {})
		};
	}
	const civil = definition.filterStrategies.civil;
	if (civil !== undefined && isCivil(work.windowStart) && isCivil(work.windowEnd)) {
		return {
			axis: 'civil',
			field: civil.field,
			comparison: civil.comparison,
			start: work.windowStart,
			...(civil.comparison === 'closedOpen' ? { end: work.windowEnd } : {})
		};
	}
	// Cursor bounds from a different clock must never be coerced into a filter.
	return undefined;
}

export function chunkNormalizedPoints(
	points: readonly NormalizedHealthPoint[]
): NormalizedHealthPoint[][] {
	const chunks: NormalizedHealthPoint[][] = [];
	let current: NormalizedHealthPoint[] = [];
	let bytes = 0;
	for (const point of points) {
		const pointBytes = new TextEncoder().encode(JSON.stringify(point)).byteLength + 16;
		if (
			current.length > 0 &&
			(current.length >= MAX_CHUNK_POINTS || bytes + pointBytes > MAX_CHUNK_UTF8_BYTES)
		) {
			chunks.push(current);
			current = [];
			bytes = 0;
		}
		current.push(point);
		bytes += pointBytes;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

function runIsCurrent(
	cursor: { status: string; generation: number; activeRunId?: Id<'googleHealthSyncRuns'> },
	generation: number,
	runId: Id<'googleHealthSyncRuns'>
): boolean {
	return (
		cursor.status === 'running' && cursor.generation === generation && cursor.activeRunId === runId
	);
}

function connectionRunIsCurrent(
	connection: {
		generation: number;
		activeSyncCursorId?: Id<'googleHealthSyncCursors'>;
		activeSyncRunId?: Id<'googleHealthSyncRuns'>;
	},
	cursorId: Id<'googleHealthSyncCursors'>,
	generation: number,
	runId: Id<'googleHealthSyncRuns'>
): boolean {
	return (
		connection.generation === generation &&
		connection.activeSyncCursorId === cursorId &&
		connection.activeSyncRunId === runId
	);
}

export const markCursorRunning = internalMutation({
	args: {
		cursorId: v.id('googleHealthSyncCursors'),
		generation: v.number(),
		trigger: syncTriggerValidator
	},
	returns: v.union(cursorWorkValidator, v.null()),
	handler: async (ctx, args) => {
		const cursor = await ctx.db.get('googleHealthSyncCursors', args.cursorId);
		if (
			!cursor ||
			cursor.generation !== args.generation ||
			(cursor.status !== 'queued' && cursor.status !== 'retry')
		)
			return null;
		const connection = await ctx.db.get('googleHealthConnections', cursor.connectionId);
		if (
			!connection ||
			connection.generation !== args.generation ||
			!SYNCABLE_STATUSES.has(connection.status)
		)
			return null;
		if (connection.activeSyncRunId !== undefined) {
			await ctx.scheduler.runAfter(CONNECTION_BUSY_RETRY_MS, internal.googleHealth.sync.runCursor, {
				cursorId: cursor._id,
				generation: args.generation,
				trigger: args.trigger
			});
			return null;
		}
		const now = Date.now();
		const continuingEpoch = cursor.pageToken !== undefined && cursor.activeEpoch !== undefined;
		const reconciliationEpoch = continuingEpoch
			? (cursor.activeEpoch ?? 0)
			: (connection.reconciliationEpoch ?? 0) + 1;
		if (!continuingEpoch) {
			await ctx.db.patch('googleHealthConnections', connection._id, { reconciliationEpoch });
		}
		const runId = await ctx.db.insert('googleHealthSyncRuns', {
			connectionId: connection._id,
			userId: connection.userId,
			cursorId: cursor._id,
			generation: args.generation,
			reconciliationEpoch,
			trigger: args.trigger,
			dataType: cursor.dataType,
			...(cursor.windowStart === undefined ? {} : { rangeStart: cursor.windowStart }),
			...(cursor.windowEnd === undefined ? {} : { rangeEnd: cursor.windowEnd }),
			startedAt: now,
			pages: 0,
			fetched: 0,
			inserted: 0,
			updated: 0,
			deleted: 0,
			skipped: 0,
			status: 'running'
		});
		const leaseExpiresAt = now + RUN_LEASE_MS;
		const leaseVersion = (connection.syncLeaseVersion ?? 0) + 1;
		const hadMalformed = continuingEpoch ? (cursor.hadMalformed ?? false) : false;
		await ctx.db.patch('googleHealthConnections', connection._id, {
			activeSyncCursorId: cursor._id,
			activeSyncRunId: runId,
			syncLeaseExpiresAt: leaseExpiresAt,
			syncLeaseVersion: leaseVersion,
			...(connection.backfillCompletedTypes < connection.backfillTotalTypes
				? { status: 'backfilling' as const }
				: {})
		});
		await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
			status: 'running',
			activeRunId: runId,
			activeEpoch: reconciliationEpoch,
			reconciliationEpoch,
			leaseExpiresAt,
			leaseVersion,
			hadMalformed,
			updatedAt: now
		});
		await ctx.scheduler.runAfter(RUN_LEASE_MS, internal.googleHealth.sync.recoverStaleRun, {
			cursorId: cursor._id,
			generation: args.generation,
			runId,
			leaseExpiresAt,
			leaseVersion
		});
		return {
			connectionId: connection._id,
			userId: connection.userId,
			cursorId: cursor._id,
			dataType: cursor.dataType,
			mode: cursor.mode,
			...(cursor.pageToken === undefined ? {} : { pageToken: cursor.pageToken }),
			...(cursor.windowStart === undefined ? {} : { windowStart: cursor.windowStart }),
			...(cursor.windowEnd === undefined ? {} : { windowEnd: cursor.windowEnd }),
			syncId: cursor.syncId,
			attempt: cursor.attempt,
			generation: cursor.generation,
			runId,
			reconciliationEpoch,
			leaseVersion,
			hadMalformed
		};
	}
});

export const renewRunLease = internalMutation({
	args: {
		cursorId: v.id('googleHealthSyncCursors'),
		generation: v.number(),
		runId: v.id('googleHealthSyncRuns'),
		expectedLeaseVersion: v.number()
	},
	returns: v.union(v.object({ leaseVersion: v.number(), leaseExpiresAt: v.number() }), v.null()),
	handler: async (ctx, args) => {
		const cursor = await ctx.db.get('googleHealthSyncCursors', args.cursorId);
		const connection = cursor
			? await ctx.db.get('googleHealthConnections', cursor.connectionId)
			: null;
		const run = await ctx.db.get('googleHealthSyncRuns', args.runId);
		if (
			!cursor ||
			!connection ||
			!run ||
			run.status !== 'running' ||
			run.cursorId !== cursor._id ||
			run.connectionId !== connection._id ||
			run.generation !== args.generation ||
			!runIsCurrent(cursor, args.generation, run._id) ||
			!connectionRunIsCurrent(connection, cursor._id, args.generation, run._id) ||
			cursor.leaseVersion === undefined ||
			cursor.leaseVersion !== connection.syncLeaseVersion
		)
			return null;
		// The action may have observed an older version than a summary or cleanup
		// heartbeat. Ownership, rather than the observer's version, is the CAS.
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
		return { leaseVersion, leaseExpiresAt };
	}
});

async function completeRun(
	ctx: MutationCtx,
	runId: Id<'googleHealthSyncRuns'>,
	counts: PageCounts,
	status: 'succeeded' | 'failed',
	errorCode?: string,
	hadMalformed = false
): Promise<void> {
	const run = await ctx.db.get('googleHealthSyncRuns', runId);
	if (!run || run.status !== 'running') return;
	await ctx.db.patch('googleHealthSyncRuns', run._id, {
		finishedAt: Date.now(),
		pages: 1,
		fetched: counts.fetched,
		inserted: counts.inserted,
		updated: counts.updated,
		skipped: counts.skipped,
		status,
		...(errorCode === undefined
			? hadMalformed
				? {
						errorCode: 'warning_skipped_records',
						errorMessage: 'Some Google Health records could not be imported'
					}
				: { errorCode: undefined, errorMessage: undefined }
			: {
					errorCode: safeErrorCode(errorCode),
					errorMessage: 'Google Health synchronization failed'
				})
	});
}

async function completeCursorPageImpl(
	ctx: MutationCtx,
	args: {
		cursorId: Id<'googleHealthSyncCursors'>;
		generation: number;
		trigger: SyncTrigger;
		runId: Id<'googleHealthSyncRuns'>;
		counts: PageCounts;
		nextPageToken?: string;
		nextWindowStart?: string;
		nextWindowEnd?: string;
		hadMalformed: boolean;
	}
): Promise<boolean> {
	const cursor = await ctx.db.get('googleHealthSyncCursors', args.cursorId);
	const connection = cursor
		? await ctx.db.get('googleHealthConnections', cursor.connectionId)
		: null;
	if (
		!cursor ||
		!connection ||
		!runIsCurrent(cursor, args.generation, args.runId) ||
		!connectionRunIsCurrent(connection, cursor._id, args.generation, args.runId) ||
		!SYNCABLE_STATUSES.has(connection.status)
	)
		return false;
	const hasPage = args.nextPageToken !== undefined;
	const hasWindow = args.nextWindowStart !== undefined || args.nextWindowEnd !== undefined;
	if (hasPage === hasWindow || (hasWindow && (!args.nextWindowStart || !args.nextWindowEnd)))
		throw new Error('exactly one cursor continuation is required');
	await completeRun(ctx, args.runId, args.counts, 'succeeded', undefined, args.hadMalformed);
	await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
		status: 'queued',
		activeRunId: undefined,
		leaseExpiresAt: undefined,
		leaseVersion: undefined,
		pageToken: args.nextPageToken,
		windowStart: args.nextWindowStart ?? cursor.windowStart,
		windowEnd: args.nextWindowEnd ?? cursor.windowEnd,
		...(hasWindow ? { activeEpoch: undefined } : {}),
		hadMalformed: hasWindow ? false : args.hadMalformed,
		attempt: 0,
		updatedAt: Date.now()
	});
	const backfillPending = connection.backfillCompletedTypes < connection.backfillTotalTypes;
	await ctx.db.patch('googleHealthConnections', connection._id, {
		activeSyncCursorId: undefined,
		activeSyncRunId: undefined,
		syncLeaseExpiresAt: undefined,
		status: backfillPending ? 'backfilling' : 'active',
		lastAttemptAt: Date.now(),
		lastErrorCode: undefined,
		lastErrorMessage: undefined,
		nextRetryAt: undefined
	});
	await ctx.scheduler.runAfter(0, internal.googleHealth.sync.runCursor, {
		cursorId: cursor._id,
		generation: args.generation,
		trigger: args.trigger
	});
	return true;
}

async function finishDataTypeImpl(
	ctx: MutationCtx,
	args: {
		cursorId: Id<'googleHealthSyncCursors'>;
		generation: number;
		runId: Id<'googleHealthSyncRuns'>;
		counts: PageCounts;
		hadMalformed: boolean;
	}
): Promise<boolean> {
	const cursor = await ctx.db.get('googleHealthSyncCursors', args.cursorId);
	const connection = cursor
		? await ctx.db.get('googleHealthConnections', cursor.connectionId)
		: null;
	if (
		!cursor ||
		!connection ||
		!runIsCurrent(cursor, args.generation, args.runId) ||
		!connectionRunIsCurrent(connection, cursor._id, args.generation, args.runId) ||
		!SYNCABLE_STATUSES.has(connection.status)
	)
		return false;
	await completeRun(ctx, args.runId, args.counts, 'succeeded', undefined, args.hadMalformed);
	const now = Date.now();
	await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
		status: 'complete',
		pageToken: undefined,
		activeRunId: undefined,
		activeEpoch: undefined,
		leaseExpiresAt: undefined,
		leaseVersion: undefined,
		hadMalformed: false,
		attempt: 0,
		updatedAt: now
	});
	const completed =
		cursor.mode === 'backfill'
			? Math.min(connection.backfillTotalTypes, connection.backfillCompletedTypes + 1)
			: connection.backfillCompletedTypes;
	const nextCandidates = await ctx.db
		.query('googleHealthSyncCursors')
		.withIndex('by_userId', (q) => q.eq('userId', connection.userId))
		.take(MAX_CURSOR_LOOKAHEAD);
	const next = nextCandidates.find(
		(candidate) =>
			candidate.connectionId === connection._id &&
			candidate.generation === args.generation &&
			candidate.status === 'queued' &&
			candidate._id !== cursor._id
	);
	await ctx.db.patch('googleHealthConnections', connection._id, {
		activeSyncCursorId: undefined,
		activeSyncRunId: undefined,
		syncLeaseExpiresAt: undefined,
		status: completed >= connection.backfillTotalTypes ? 'active' : 'backfilling',
		backfillCompletedTypes: completed,
		lastAttemptAt: now,
		lastSuccessfulSyncAt: now,
		lastErrorCode: undefined,
		lastErrorMessage: undefined,
		nextRetryAt: undefined
	});
	if (next)
		await ctx.scheduler.runAfter(0, internal.googleHealth.sync.runCursor, {
			cursorId: next._id,
			generation: args.generation,
			trigger: 'oauth'
		});
	return true;
}

async function requestCompletionImpl(
	ctx: MutationCtx,
	args: {
		cursorId: Id<'googleHealthSyncCursors'>;
		generation: number;
		trigger: SyncTrigger;
		runId: Id<'googleHealthSyncRuns'>;
		counts: PageCounts;
		nextPageToken?: string;
		nextWindowStart?: string;
		nextWindowEnd?: string;
		finish: boolean;
		hadMalformed: boolean;
	}
): Promise<boolean> {
	const [cursor, run] = await Promise.all([
		ctx.db.get('googleHealthSyncCursors', args.cursorId),
		ctx.db.get('googleHealthSyncRuns', args.runId)
	]);
	const connection = cursor
		? await ctx.db.get('googleHealthConnections', cursor.connectionId)
		: null;
	if (
		!cursor ||
		!connection ||
		!run ||
		run.status !== 'running' ||
		run.cursorId !== cursor._id ||
		run.connectionId !== connection._id ||
		run.generation !== args.generation ||
		!runIsCurrent(cursor, args.generation, run._id) ||
		!connectionRunIsCurrent(connection, cursor._id, args.generation, run._id)
	)
		return false;
	const hasPage = args.nextPageToken !== undefined;
	const hasWindow = args.nextWindowStart !== undefined || args.nextWindowEnd !== undefined;
	if (
		args.finish
			? hasPage || hasWindow
			: hasPage === hasWindow || (hasWindow && (!args.nextWindowStart || !args.nextWindowEnd))
	)
		throw new Error('invalid cursor completion');
	await ctx.db.patch('googleHealthSyncRuns', run._id, {
		pages: 1,
		fetched: args.counts.fetched,
		inserted: args.counts.inserted,
		updated: args.counts.updated,
		skipped: args.counts.skipped,
		completionKind: args.finish ? 'finish' : hasPage ? 'page' : 'window',
		completionTrigger: args.trigger,
		completionNextPageToken: args.nextPageToken,
		completionNextWindowStart: args.nextWindowStart,
		completionNextWindowEnd: args.nextWindowEnd,
		completionHadMalformed: args.hadMalformed
	});
	await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
		hadMalformed: args.hadMalformed,
		updatedAt: Date.now()
	});
	await ctx.scheduler.runAfter(0, internal.googleHealth.sync.tryFinalizeRun, { runId: run._id });
	return true;
}

export const requestCompletion = internalMutation({
	args: {
		cursorId: v.id('googleHealthSyncCursors'),
		generation: v.number(),
		trigger: syncTriggerValidator,
		runId: v.id('googleHealthSyncRuns'),
		counts: pageCountsValidator,
		nextPageToken: v.optional(v.string()),
		nextWindowStart: v.optional(v.string()),
		nextWindowEnd: v.optional(v.string()),
		finish: v.boolean(),
		hadMalformed: v.boolean()
	},
	returns: v.boolean(),
	handler: requestCompletionImpl
});

export const tryFinalizeRun = internalMutation({
	args: { runId: v.id('googleHealthSyncRuns') },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get('googleHealthSyncRuns', args.runId);
		if (
			!run ||
			run.status !== 'running' ||
			run.cursorId === undefined ||
			run.generation === undefined
		)
			return false;
		if (run.completionKind === undefined || run.completionTrigger === undefined) return false;
		const dependency = await ctx.db
			.query('healthSummaryDependencies')
			.withIndex('by_runId', (q) => q.eq('runId', run._id))
			.first();
		if (dependency) return false;
		const counts = {
			fetched: run.fetched,
			inserted: run.inserted,
			updated: run.updated,
			skipped: run.skipped
		};
		if (run.completionKind === 'finish')
			return await finishDataTypeImpl(ctx, {
				cursorId: run.cursorId,
				generation: run.generation,
				runId: run._id,
				counts,
				hadMalformed: run.completionHadMalformed ?? false
			});
		return await completeCursorPageImpl(ctx, {
			cursorId: run.cursorId,
			generation: run.generation,
			trigger: run.completionTrigger,
			runId: run._id,
			counts,
			hadMalformed: run.completionHadMalformed ?? false,
			...(run.completionKind === 'page'
				? { nextPageToken: run.completionNextPageToken }
				: {
						nextWindowStart: run.completionNextWindowStart,
						nextWindowEnd: run.completionNextWindowEnd
					})
		});
	}
});

export const completeCursorPage = internalMutation({
	args: {
		cursorId: v.id('googleHealthSyncCursors'),
		generation: v.number(),
		trigger: syncTriggerValidator,
		runId: v.id('googleHealthSyncRuns'),
		counts: pageCountsValidator,
		nextPageToken: v.optional(v.string()),
		nextWindowStart: v.optional(v.string()),
		nextWindowEnd: v.optional(v.string()),
		hadMalformed: v.optional(v.boolean())
	},
	returns: v.boolean(),
	handler: async (ctx, args) =>
		await requestCompletionImpl(ctx, {
			...args,
			finish: false,
			hadMalformed: args.hadMalformed ?? false
		})
});

export const finishDataType = internalMutation({
	args: {
		cursorId: v.id('googleHealthSyncCursors'),
		generation: v.number(),
		runId: v.id('googleHealthSyncRuns'),
		counts: pageCountsValidator
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const run = await ctx.db.get('googleHealthSyncRuns', args.runId);
		return await requestCompletionImpl(ctx, {
			...args,
			trigger: run?.trigger ?? 'oauth',
			finish: true,
			hadMalformed: false
		});
	}
});

export const finalizeCleanup = internalMutation({
	args: {
		cursorId: v.id('googleHealthSyncCursors'),
		generation: v.number(),
		trigger: syncTriggerValidator,
		runId: v.id('googleHealthSyncRuns'),
		counts: pageCountsValidator,
		nextPageToken: v.optional(v.string()),
		nextWindowStart: v.optional(v.string()),
		nextWindowEnd: v.optional(v.string()),
		finish: v.boolean(),
		hadMalformed: v.boolean()
	},
	returns: v.boolean(),
	handler: requestCompletionImpl
});

export const scheduleCursorRetry = internalMutation({
	args: {
		cursorId: v.id('googleHealthSyncCursors'),
		generation: v.number(),
		runId: v.id('googleHealthSyncRuns'),
		errorCode: v.string(),
		delayMs: v.number()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const cursor = await ctx.db.get('googleHealthSyncCursors', args.cursorId);
		const connection = cursor
			? await ctx.db.get('googleHealthConnections', cursor.connectionId)
			: null;
		if (
			!cursor ||
			!connection ||
			!runIsCurrent(cursor, args.generation, args.runId) ||
			!connectionRunIsCurrent(connection, cursor._id, args.generation, args.runId) ||
			!SYNCABLE_STATUSES.has(connection.status) ||
			!Number.isFinite(args.delayMs) ||
			args.delayMs < 0 ||
			args.delayMs > RETRY_MAX_MS * 1.2
		)
			return false;
		const errorCode = safeErrorCode(args.errorCode);
		const now = Date.now();
		await completeRun(
			ctx,
			args.runId,
			{ fetched: 0, inserted: 0, updated: 0, skipped: 0 },
			'failed',
			errorCode
		);
		await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
			status: 'retry',
			activeRunId: undefined,
			leaseExpiresAt: undefined,
			leaseVersion: undefined,
			attempt: cursor.attempt + 1,
			updatedAt: now
		});
		await ctx.db.patch('googleHealthConnections', connection._id, {
			activeSyncCursorId: undefined,
			activeSyncRunId: undefined,
			syncLeaseExpiresAt: undefined,
			status: 'delayed',
			lastAttemptAt: now,
			lastErrorCode: errorCode,
			lastErrorMessage: 'Google Health is temporarily unavailable',
			nextRetryAt: now + args.delayMs
		});
		await ctx.scheduler.runAfter(args.delayMs, internal.googleHealth.sync.runCursor, {
			cursorId: cursor._id,
			generation: args.generation,
			trigger: 'retry'
		});
		return true;
	}
});

export const failCursor = internalMutation({
	args: {
		cursorId: v.id('googleHealthSyncCursors'),
		generation: v.number(),
		runId: v.id('googleHealthSyncRuns'),
		errorCode: v.string(),
		actionRequired: v.boolean()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const cursor = await ctx.db.get('googleHealthSyncCursors', args.cursorId);
		const connection = cursor
			? await ctx.db.get('googleHealthConnections', cursor.connectionId)
			: null;
		if (
			!cursor ||
			!connection ||
			!runIsCurrent(cursor, args.generation, args.runId) ||
			!connectionRunIsCurrent(connection, cursor._id, args.generation, args.runId) ||
			!SYNCABLE_STATUSES.has(connection.status)
		)
			return false;
		const errorCode = safeErrorCode(args.errorCode);
		const now = Date.now();
		await completeRun(
			ctx,
			args.runId,
			{ fetched: 0, inserted: 0, updated: 0, skipped: 0 },
			'failed',
			errorCode
		);
		await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
			status: 'retry',
			activeRunId: undefined,
			leaseExpiresAt: undefined,
			leaseVersion: undefined,
			attempt: cursor.attempt + 1,
			updatedAt: now
		});
		await ctx.db.patch('googleHealthConnections', connection._id, {
			activeSyncCursorId: undefined,
			activeSyncRunId: undefined,
			syncLeaseExpiresAt: undefined,
			status: args.actionRequired ? 'action_required' : 'delayed',
			lastAttemptAt: now,
			lastErrorCode: errorCode,
			lastErrorMessage: args.actionRequired
				? 'Google Health access needs to be renewed'
				: 'Google Health synchronization failed',
			nextRetryAt: undefined
		});
		return true;
	}
});

export const abandonRun = internalMutation({
	args: {
		cursorId: v.id('googleHealthSyncCursors'),
		generation: v.number(),
		runId: v.id('googleHealthSyncRuns'),
		errorCode: v.string()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const cursor = await ctx.db.get('googleHealthSyncCursors', args.cursorId);
		const connection = cursor
			? await ctx.db.get('googleHealthConnections', cursor.connectionId)
			: null;
		const run = await ctx.db.get('googleHealthSyncRuns', args.runId);
		if (
			!cursor ||
			!connection ||
			!run ||
			run.status !== 'running' ||
			run.cursorId !== cursor._id ||
			run.connectionId !== connection._id ||
			run.generation !== args.generation ||
			!runIsCurrent(cursor, args.generation, args.runId) ||
			connection.activeSyncCursorId !== cursor._id ||
			connection.activeSyncRunId !== run._id
		)
			return false;
		await ctx.db.patch('googleHealthSyncRuns', run._id, {
			status: 'failed',
			finishedAt: Date.now(),
			errorCode: safeErrorCode(args.errorCode),
			errorMessage: 'Google Health synchronization abandoned'
		});
		if (connection.generation !== args.generation || !SYNCABLE_STATUSES.has(connection.status)) {
			await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
				status: 'retry',
				activeRunId: undefined,
				leaseExpiresAt: undefined,
				leaseVersion: undefined,
				updatedAt: Date.now()
			});
			await ctx.db.patch('googleHealthConnections', connection._id, {
				activeSyncCursorId: undefined,
				activeSyncRunId: undefined,
				syncLeaseExpiresAt: undefined
			});
			return false;
		}
		await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
			status: 'queued',
			activeRunId: undefined,
			leaseExpiresAt: undefined,
			leaseVersion: undefined,
			updatedAt: Date.now()
		});
		await ctx.db.patch('googleHealthConnections', connection._id, {
			activeSyncCursorId: undefined,
			activeSyncRunId: undefined,
			syncLeaseExpiresAt: undefined
		});
		await ctx.scheduler.runAfter(0, internal.googleHealth.sync.runCursor, {
			cursorId: cursor._id,
			generation: args.generation,
			trigger: 'retry'
		});
		return true;
	}
});

export const recoverStaleRun = internalMutation({
	args: {
		cursorId: v.id('googleHealthSyncCursors'),
		generation: v.number(),
		runId: v.id('googleHealthSyncRuns'),
		leaseExpiresAt: v.number(),
		leaseVersion: v.number()
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const cursor = await ctx.db.get('googleHealthSyncCursors', args.cursorId);
		const connection = cursor
			? await ctx.db.get('googleHealthConnections', cursor.connectionId)
			: null;
		const run = await ctx.db.get('googleHealthSyncRuns', args.runId);
		if (
			!cursor ||
			!connection ||
			!run ||
			run.status !== 'running' ||
			run.cursorId !== cursor._id ||
			run.connectionId !== connection._id ||
			run.generation !== args.generation ||
			!runIsCurrent(cursor, args.generation, args.runId) ||
			cursor.leaseExpiresAt !== args.leaseExpiresAt ||
			cursor.leaseVersion !== args.leaseVersion ||
			connection.activeSyncCursorId !== cursor._id ||
			connection.activeSyncRunId !== run._id ||
			connection.syncLeaseExpiresAt !== args.leaseExpiresAt ||
			connection.syncLeaseVersion !== args.leaseVersion ||
			Date.now() < args.leaseExpiresAt
		)
			return false;
		const canRequeue =
			connection !== null &&
			connection.generation === args.generation &&
			SYNCABLE_STATUSES.has(connection.status);
		await ctx.db.patch('googleHealthSyncRuns', run._id, {
			status: 'failed',
			finishedAt: Date.now(),
			errorCode: 'stale_run_lease',
			errorMessage: 'Google Health synchronization lease expired'
		});
		await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
			status: canRequeue ? 'queued' : 'retry',
			activeRunId: undefined,
			leaseExpiresAt: undefined,
			leaseVersion: undefined,
			updatedAt: Date.now()
		});
		await ctx.db.patch('googleHealthConnections', connection._id, {
			activeSyncCursorId: undefined,
			activeSyncRunId: undefined,
			syncLeaseExpiresAt: undefined
		});
		if (canRequeue) {
			await ctx.scheduler.runAfter(0, internal.googleHealth.sync.runCursor, {
				cursorId: cursor._id,
				generation: args.generation,
				trigger: 'retry'
			});
		}
		return true;
	}
});

async function guardedReplaceEnvelope(
	ctx: ActionCtx,
	work: CursorWork,
	expectedEnvelope: EncryptedTokenEnvelope,
	replacementEnvelope: EncryptedTokenEnvelope,
	replacementGrantedScopes?: readonly string[]
): Promise<boolean> {
	return await ctx.runMutation(internal.googleHealth.model.replaceTokenEnvelope, {
		connectionId: work.connectionId,
		expectedGeneration: work.generation,
		expectedEnvelope,
		replacementEnvelope,
		...(replacementGrantedScopes === undefined
			? {}
			: { replacementGrantedScopes: [...replacementGrantedScopes] })
	});
}

function completionFor(
	pageToken: string | undefined,
	rollupRange: { start: string; end: string } | undefined,
	counts: PageCounts,
	trigger: SyncTrigger,
	hadMalformed: boolean
): Completion {
	if (pageToken !== undefined)
		return { trigger, counts, nextPageToken: pageToken, finish: false, hadMalformed };
	if (rollupRange !== undefined) {
		const terminal = currentExclusiveCivilDate();
		if (rollupRange.end < terminal)
			return {
				trigger,
				counts,
				nextWindowStart: rollupRange.end,
				nextWindowEnd: minDate(addDays(rollupRange.end, 14), terminal),
				finish: false,
				hadMalformed
			};
	}
	return { trigger, counts, finish: true, hadMalformed };
}

export const runCursor = internalAction({
	args: {
		cursorId: v.id('googleHealthSyncCursors'),
		generation: v.number(),
		trigger: syncTriggerValidator
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const work: CursorWork | null = await ctx.runMutation(
			internal.googleHealth.sync.markCursorRunning,
			args
		);
		if (work === null) return null;
		let leaseVersion = work.leaseVersion;
		const abandon = async (code: string) => {
			await ctx.runMutation(internal.googleHealth.sync.abandonRun, {
				cursorId: work.cursorId,
				generation: work.generation,
				runId: work.runId,
				errorCode: code
			});
		};
		const renew = async (): Promise<boolean> => {
			const renewed = await ctx.runMutation(internal.googleHealth.sync.renewRunLease, {
				cursorId: work.cursorId,
				generation: work.generation,
				runId: work.runId,
				expectedLeaseVersion: leaseVersion
			});
			if (renewed === null) {
				await abandon('lease_cas_lost');
				return false;
			}
			leaseVersion = renewed.leaseVersion;
			return true;
		};
		try {
			const connection = await ctx.runQuery(internal.googleHealth.model.getConnectionForSync, {
				connectionId: work.connectionId
			});
			if (
				connection === null ||
				connection.generation !== work.generation ||
				!SYNCABLE_STATUSES.has(connection.status)
			) {
				await abandon('stale_connection');
				return null;
			}
			if (connection.tokenEnvelope === null) {
				const failed = await ctx.runMutation(internal.googleHealth.sync.failCursor, {
					cursorId: work.cursorId,
					generation: work.generation,
					runId: work.runId,
					errorCode: 'missing_token_envelope',
					actionRequired: true
				});
				if (!failed) await abandon('failure_cas_lost');
				return null;
			}
			const definition = getMetricDefinition(work.dataType);
			if (definition === null || !connection.grantedScopes.includes(definition.scope)) {
				const failed = await ctx.runMutation(internal.googleHealth.sync.failCursor, {
					cursorId: work.cursorId,
					generation: work.generation,
					runId: work.runId,
					errorCode: 'scope_not_granted',
					actionRequired: true
				});
				if (!failed) await abandon('failure_cas_lost');
				return null;
			}
			const keyring = createTokenKeyring(
				env.GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY,
				env.GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION,
				env.GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS
			);
			let currentEnvelope = connection.tokenEnvelope;
			const rotated = await rotateRefreshTokenEnvelope(currentEnvelope, work.userId, keyring);
			if (rotated.reencrypted) {
				if (!(await guardedReplaceEnvelope(ctx, work, currentEnvelope, rotated.envelope))) {
					await abandon('token_cas_lost');
					return null;
				}
				currentEnvelope = rotated.envelope;
			}
			const tokens = await refreshAccessToken({
				refreshToken: rotated.refreshToken,
				clientId: env.GOOGLE_HEALTH_CLIENT_ID,
				clientSecret: env.GOOGLE_HEALTH_CLIENT_SECRET,
				grantedScopes: connection.grantedScopes
			});
			const replacementEnvelope =
				tokens.refreshToken === undefined
					? currentEnvelope
					: await encryptRefreshToken(
							tokens.refreshToken,
							work.userId,
							keyring.activeKey,
							keyring.activeVersion
						);
			if (
				!(await guardedReplaceEnvelope(
					ctx,
					work,
					currentEnvelope,
					replacementEnvelope,
					tokens.grantedScopes
				))
			) {
				await abandon('token_cas_lost');
				return null;
			}
			if (!tokens.grantedScopes.includes(definition.scope)) {
				const failed = await ctx.runMutation(internal.googleHealth.sync.failCursor, {
					cursorId: work.cursorId,
					generation: work.generation,
					runId: work.runId,
					errorCode: 'scope_not_granted',
					actionRequired: true
				});
				if (!failed) await abandon('failure_cas_lost');
				return null;
			}

			let rollupRange: { start: string; end: string } | undefined;
			if (definition.readMode === 'dailyRollUp') {
				const terminal = currentExclusiveCivilDate();
				const start = work.windowStart ?? FIRST_ROLLUP_DATE;
				if (!isValidDate(start) || start >= terminal) {
					const finished = await ctx.runMutation(internal.googleHealth.sync.finishDataType, {
						cursorId: work.cursorId,
						generation: work.generation,
						runId: work.runId,
						counts: { fetched: 0, inserted: 0, updated: 0, skipped: 0 }
					});
					if (!finished) await abandon('cursor_cas_lost');
					return null;
				}
				rollupRange = { start, end: minDate(work.windowEnd ?? addDays(start, 14), terminal) };
			}
			if (definition.readMode === 'rollUp')
				throw new GoogleHealthError('unsupported_read_mode', null, false);
			const filter = timeFilterFor(work, definition);
			const page = await fetchGoogleHealthDataPage({
				accessToken: tokens.accessToken,
				dataType: definition.dataType,
				readMode: definition.readMode === 'dailyRollUp' ? 'dailyRollUp' : definition.readMode,
				pageSize: pageSizeFor(definition.dataType),
				pageToken: work.pageToken,
				filter,
				range: rollupRange
			});
			const points: NormalizedHealthPoint[] = [];
			let malformed = 0;
			for (const raw of page.points) {
				try {
					points.push(normalizeGooglePoint(definition, raw));
				} catch {
					malformed += 1;
				}
			}
			let inserted = 0;
			let updated = 0;
			let skipped = malformed;
			const chunks = chunkNormalizedPoints(points);
			for (const chunk of chunks) {
				const applied = await ctx.runMutation(internal.googleHealth.records.applyReconciledPage, {
					connectionId: work.connectionId,
					expectedGeneration: work.generation,
					cursorId: work.cursorId,
					runId: work.runId,
					dataType: work.dataType,
					points: chunk,
					syncId: work.syncId,
					seenEpoch: work.reconciliationEpoch
				});
				inserted += applied.inserted;
				updated += applied.updated;
				skipped += applied.skipped;
				if (!(await renew())) return null;
			}
			if (chunks.length === 0 && !(await renew())) return null;
			const counts: PageCounts = { fetched: page.points.length, inserted, updated, skipped };
			const hadMalformed = work.hadMalformed || malformed > 0;
			const completion = completionFor(
				page.nextPageToken,
				rollupRange,
				counts,
				args.trigger,
				hadMalformed
			);
			let coveredRange:
				| { kind: 'physical'; startKey: string; endKeyExclusive: string }
				| { kind: 'civil'; startDate: string; endDateExclusive: string }
				| undefined;
			if (!hadMalformed && page.nextPageToken === undefined && rollupRange !== undefined) {
				coveredRange = {
					kind: 'civil',
					startDate: rollupRange.start,
					endDateExclusive: rollupRange.end
				};
			} else if (
				!hadMalformed &&
				page.nextPageToken === undefined &&
				work.mode === 'incremental' &&
				definition.readMode === 'reconcile' &&
				filter?.comparison === 'closedOpen' &&
				filter.end !== undefined
			) {
				if (filter.axis === 'physical') {
					const startKey = canonicalPhysicalCoverageKey(filter.start);
					const endKeyExclusive = canonicalPhysicalCoverageKey(filter.end);
					if (startKey !== undefined && endKeyExclusive !== undefined)
						coveredRange = { kind: 'physical', startKey, endKeyExclusive };
				} else {
					coveredRange = {
						kind: 'civil',
						startDate: filter.start,
						endDateExclusive: filter.end
					};
				}
			}
			if (coveredRange !== undefined) {
				const started = await ctx.runMutation(internal.googleHealth.records.beginCleanup, {
					connectionId: work.connectionId,
					cursorId: work.cursorId,
					runId: work.runId,
					expectedGeneration: work.generation,
					dataType: work.dataType,
					cleanupEpoch: work.reconciliationEpoch,
					coveredRange,
					completion
				});
				if (!started) await abandon('cleanup_cas_lost');
				return null;
			}
			const finalized = await ctx.runMutation(internal.googleHealth.sync.requestCompletion, {
				cursorId: work.cursorId,
				generation: work.generation,
				runId: work.runId,
				...completion
			});
			if (!finalized) await abandon('cursor_cas_lost');
			return null;
		} catch (error) {
			if (error instanceof GoogleHealthError && error.retryable) {
				const scheduled = await ctx.runMutation(internal.googleHealth.sync.scheduleCursorRetry, {
					cursorId: work.cursorId,
					generation: work.generation,
					runId: work.runId,
					errorCode: error.code,
					delayMs: computeRetryDelayMs(work.attempt)
				});
				if (!scheduled) await abandon('retry_cas_lost');
				return null;
			}
			const failed = await ctx.runMutation(internal.googleHealth.sync.failCursor, {
				cursorId: work.cursorId,
				generation: work.generation,
				runId: work.runId,
				errorCode: error instanceof GoogleHealthError ? error.code : 'sync_error',
				actionRequired: error instanceof GoogleHealthError && error.code === 'invalid_grant'
			});
			if (!failed) await abandon('failure_cas_lost');
			return null;
		}
	}
});
