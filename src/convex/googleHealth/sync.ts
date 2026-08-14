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
import { normalizeGooglePoint } from './normalize';
import { getMetricDefinition, type MetricDefinition } from './registry';
import { syncTriggerValidator } from './validators';

const FIRST_ROLLUP_DATE = '2000-01-01';
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const MAX_CURSOR_LOOKAHEAD = 100;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SYNCABLE_STATUSES = new Set(['backfilling', 'active', 'delayed']);

const pageCountsValidator = v.object({
	fetched: v.number(),
	inserted: v.number(),
	updated: v.number(),
	skipped: v.number()
});

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
	runId: v.id('googleHealthSyncRuns')
});

type PageCounts = {
	fetched: number;
	inserted: number;
	updated: number;
	skipped: number;
};

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
};

function safeErrorCode(code: string): string {
	return /^[a-z0-9_.-]{1,80}$/.test(code) ? code : 'sync_error';
}

function isValidDate(value: string): boolean {
	if (!ISO_DATE.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
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
	if (
		work.mode !== 'incremental' ||
		work.windowStart === undefined ||
		work.windowEnd === undefined
	) {
		return undefined;
	}
	if (definition.recordKind === 'reference') return undefined;
	return {
		kind: definition.recordKind === 'daily' ? 'civil' : 'physical',
		recordKind: definition.recordKind,
		start: work.windowStart,
		end: work.windowEnd
	};
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
		) {
			return null;
		}
		const connection = await ctx.db.get('googleHealthConnections', cursor.connectionId);
		if (
			!connection ||
			connection.generation !== args.generation ||
			!SYNCABLE_STATUSES.has(connection.status)
		) {
			return null;
		}
		const now = Date.now();
		await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
			status: 'running',
			updatedAt: now
		});
		const runId = await ctx.db.insert('googleHealthSyncRuns', {
			connectionId: connection._id,
			userId: connection.userId,
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
			runId
		};
	}
});

async function completeRun(
	ctx: MutationCtx,
	runId: Id<'googleHealthSyncRuns'>,
	counts: PageCounts,
	status: 'succeeded' | 'failed',
	errorCode?: string
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
			? {}
			: {
					errorCode: safeErrorCode(errorCode),
					errorMessage: 'Google Health synchronization failed'
				})
	});
}

export const completeCursorPage = internalMutation({
	args: {
		cursorId: v.id('googleHealthSyncCursors'),
		generation: v.number(),
		trigger: syncTriggerValidator,
		runId: v.id('googleHealthSyncRuns'),
		counts: pageCountsValidator,
		nextPageToken: v.optional(v.string()),
		nextWindowStart: v.optional(v.string()),
		nextWindowEnd: v.optional(v.string())
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
			cursor.status !== 'running' ||
			cursor.generation !== args.generation ||
			connection.generation !== args.generation ||
			!SYNCABLE_STATUSES.has(connection.status)
		) {
			return false;
		}
		const hasPage = args.nextPageToken !== undefined;
		const hasWindow = args.nextWindowStart !== undefined || args.nextWindowEnd !== undefined;
		if (hasPage === hasWindow || (hasWindow && (!args.nextWindowStart || !args.nextWindowEnd))) {
			throw new Error('exactly one cursor continuation is required');
		}
		await completeRun(ctx, args.runId, args.counts, 'succeeded');
		await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
			status: 'queued',
			pageToken: args.nextPageToken,
			windowStart: args.nextWindowStart ?? cursor.windowStart,
			windowEnd: args.nextWindowEnd ?? cursor.windowEnd,
			attempt: 0,
			updatedAt: Date.now()
		});
		await ctx.db.patch('googleHealthConnections', connection._id, {
			status: cursor.mode === 'backfill' ? 'backfilling' : 'active',
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
		const cursor = await ctx.db.get('googleHealthSyncCursors', args.cursorId);
		const connection = cursor
			? await ctx.db.get('googleHealthConnections', cursor.connectionId)
			: null;
		if (
			!cursor ||
			!connection ||
			cursor.status !== 'running' ||
			cursor.generation !== args.generation ||
			connection.generation !== args.generation ||
			!SYNCABLE_STATUSES.has(connection.status)
		) {
			return false;
		}
		await completeRun(ctx, args.runId, args.counts, 'succeeded');
		const now = Date.now();
		await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
			status: 'complete',
			pageToken: undefined,
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
		const backfillComplete =
			cursor.mode === 'incremental' || completed >= connection.backfillTotalTypes;
		await ctx.db.patch('googleHealthConnections', connection._id, {
			status: backfillComplete ? 'active' : 'backfilling',
			backfillCompletedTypes: completed,
			lastAttemptAt: now,
			lastSuccessfulSyncAt: now,
			lastErrorCode: undefined,
			lastErrorMessage: undefined,
			nextRetryAt: undefined
		});
		if (next) {
			await ctx.scheduler.runAfter(0, internal.googleHealth.sync.runCursor, {
				cursorId: next._id,
				generation: args.generation,
				trigger: 'oauth'
			});
		}
		return true;
	}
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
			cursor.status !== 'running' ||
			cursor.generation !== args.generation ||
			connection.generation !== args.generation ||
			!SYNCABLE_STATUSES.has(connection.status) ||
			!Number.isFinite(args.delayMs) ||
			args.delayMs < 0 ||
			args.delayMs > RETRY_MAX_MS * 1.2
		) {
			return false;
		}
		const errorCode = safeErrorCode(args.errorCode);
		const nextRetryAt = Date.now() + args.delayMs;
		await completeRun(
			ctx,
			args.runId,
			{ fetched: 0, inserted: 0, updated: 0, skipped: 0 },
			'failed',
			errorCode
		);
		await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
			status: 'retry',
			attempt: cursor.attempt + 1,
			updatedAt: Date.now()
		});
		await ctx.db.patch('googleHealthConnections', connection._id, {
			status: 'delayed',
			lastAttemptAt: Date.now(),
			lastErrorCode: errorCode,
			lastErrorMessage: 'Google Health is temporarily unavailable',
			nextRetryAt
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
			cursor.status !== 'running' ||
			cursor.generation !== args.generation ||
			connection.generation !== args.generation ||
			!SYNCABLE_STATUSES.has(connection.status)
		) {
			return false;
		}
		const errorCode = safeErrorCode(args.errorCode);
		await completeRun(
			ctx,
			args.runId,
			{ fetched: 0, inserted: 0, updated: 0, skipped: 0 },
			'failed',
			errorCode
		);
		await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
			status: 'retry',
			updatedAt: Date.now()
		});
		await ctx.db.patch('googleHealthConnections', connection._id, {
			status: args.actionRequired ? 'action_required' : 'delayed',
			lastAttemptAt: Date.now(),
			lastErrorCode: errorCode,
			lastErrorMessage: args.actionRequired
				? 'Google Health access needs to be renewed'
				: 'Google Health synchronization failed',
			nextRetryAt: undefined
		});
		return true;
	}
});

async function guardedReplaceEnvelope(
	ctx: ActionCtx,
	work: CursorWork,
	expectedEnvelope: EncryptedTokenEnvelope,
	replacementEnvelope: EncryptedTokenEnvelope
): Promise<boolean> {
	return await ctx.runMutation(internal.googleHealth.model.replaceTokenEnvelope, {
		connectionId: work.connectionId,
		expectedGeneration: work.generation,
		expectedEnvelope,
		replacementEnvelope
	});
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
		try {
			const connection = await ctx.runQuery(internal.googleHealth.model.getConnectionForSync, {
				connectionId: work.connectionId
			});
			if (
				connection === null ||
				connection.generation !== work.generation ||
				!SYNCABLE_STATUSES.has(connection.status)
			) {
				return null;
			}
			if (connection.tokenEnvelope === null) {
				await ctx.runMutation(internal.googleHealth.sync.failCursor, {
					cursorId: work.cursorId,
					generation: work.generation,
					runId: work.runId,
					errorCode: 'missing_token_envelope',
					actionRequired: true
				});
				return null;
			}
			const definition = getMetricDefinition(work.dataType);
			if (definition === null || !connection.grantedScopes.includes(definition.scope)) {
				await ctx.runMutation(internal.googleHealth.sync.failCursor, {
					cursorId: work.cursorId,
					generation: work.generation,
					runId: work.runId,
					errorCode: 'scope_not_granted',
					actionRequired: true
				});
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
				const replaced = await guardedReplaceEnvelope(ctx, work, currentEnvelope, rotated.envelope);
				if (!replaced) return null;
				currentEnvelope = rotated.envelope;
			}
			const tokens = await refreshAccessToken({
				refreshToken: rotated.refreshToken,
				clientId: env.GOOGLE_HEALTH_CLIENT_ID,
				clientSecret: env.GOOGLE_HEALTH_CLIENT_SECRET,
				grantedScopes: connection.grantedScopes
			});
			if (tokens.refreshToken !== undefined) {
				const replacementEnvelope = await encryptRefreshToken(
					tokens.refreshToken,
					work.userId,
					keyring.activeKey,
					keyring.activeVersion
				);
				const replaced = await guardedReplaceEnvelope(
					ctx,
					work,
					currentEnvelope,
					replacementEnvelope
				);
				if (!replaced) return null;
			}

			const pageSize = pageSizeFor(definition.dataType);
			let rollupRange: { start: string; end: string } | undefined;
			if (definition.readMode === 'dailyRollUp') {
				const terminal = currentExclusiveCivilDate();
				const start = work.windowStart ?? FIRST_ROLLUP_DATE;
				if (!isValidDate(start) || start >= terminal) {
					await ctx.runMutation(internal.googleHealth.sync.finishDataType, {
						cursorId: work.cursorId,
						generation: work.generation,
						runId: work.runId,
						counts: { fetched: 0, inserted: 0, updated: 0, skipped: 0 }
					});
					return null;
				}
				rollupRange = { start, end: minDate(work.windowEnd ?? addDays(start, 14), terminal) };
			}
			const filter = timeFilterFor(work, definition);
			if (definition.readMode === 'rollUp') {
				throw new GoogleHealthError('unsupported_read_mode', null, false);
			}
			const page = await fetchGoogleHealthDataPage({
				accessToken: tokens.accessToken,
				dataType: definition.dataType,
				readMode: definition.readMode === 'dailyRollUp' ? 'dailyRollUp' : definition.readMode,
				pageSize,
				pageToken: work.pageToken,
				filter,
				range: rollupRange
			});
			const points = page.points.map((raw) => normalizeGooglePoint(definition, raw));
			const coveredRange =
				work.mode === 'incremental' &&
				definition.readMode === 'reconcile' &&
				page.nextPageToken === undefined &&
				filter !== undefined
					? filter.kind === 'civil'
						? {
								kind: 'civil' as const,
								startDate: filter.start,
								endDateExclusive: filter.end
							}
						: {
								kind: 'physical' as const,
								startMs: Date.parse(filter.start),
								endMsExclusive: Date.parse(filter.end)
							}
					: undefined;
			const applied = await ctx.runMutation(internal.googleHealth.records.applyReconciledPage, {
				connectionId: work.connectionId,
				expectedGeneration: work.generation,
				dataType: work.dataType,
				points,
				syncId: work.syncId,
				...(page.nextPageToken === undefined ? {} : { nextPageToken: page.nextPageToken }),
				...(coveredRange === undefined ? {} : { coveredRange })
			});
			const counts: PageCounts = {
				fetched: points.length,
				inserted: applied.inserted,
				updated: applied.updated,
				skipped: applied.skipped
			};
			if (page.nextPageToken !== undefined) {
				await ctx.runMutation(internal.googleHealth.sync.completeCursorPage, {
					cursorId: work.cursorId,
					generation: work.generation,
					trigger: args.trigger,
					runId: work.runId,
					counts,
					nextPageToken: page.nextPageToken
				});
				return null;
			}
			if (rollupRange !== undefined) {
				const terminal = currentExclusiveCivilDate();
				if (rollupRange.end < terminal) {
					await ctx.runMutation(internal.googleHealth.sync.completeCursorPage, {
						cursorId: work.cursorId,
						generation: work.generation,
						trigger: args.trigger,
						runId: work.runId,
						counts,
						nextWindowStart: rollupRange.end,
						nextWindowEnd: minDate(addDays(rollupRange.end, 14), terminal)
					});
					return null;
				}
			}
			await ctx.runMutation(internal.googleHealth.sync.finishDataType, {
				cursorId: work.cursorId,
				generation: work.generation,
				runId: work.runId,
				counts
			});
			return null;
		} catch (error) {
			if (error instanceof GoogleHealthError && error.retryable) {
				await ctx.runMutation(internal.googleHealth.sync.scheduleCursorRetry, {
					cursorId: work.cursorId,
					generation: work.generation,
					runId: work.runId,
					errorCode: error.code,
					delayMs: computeRetryDelayMs(work.attempt)
				});
				return null;
			}
			await ctx.runMutation(internal.googleHealth.sync.failCursor, {
				cursorId: work.cursorId,
				generation: work.generation,
				runId: work.runId,
				errorCode: error instanceof GoogleHealthError ? error.code : 'sync_error',
				actionRequired: error instanceof GoogleHealthError && error.code === 'invalid_grant'
			});
			return null;
		}
	}
});
