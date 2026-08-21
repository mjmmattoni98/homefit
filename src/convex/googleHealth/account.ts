import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import {
	action,
	internalMutation,
	mutation,
	type ActionCtx,
	type MutationCtx
} from '../_generated/server';
import { requireUserId } from '../helpers';
import type { EncryptedTokenEnvelope } from './crypto';
import { canonicalPhysicalCoverageKey } from './normalize';
import { METRIC_DEFINITIONS, type MetricDefinition } from './registry';
import { scheduleCursorWithWatchdog } from './sync';
import { syncTriggerValidator, type SyncTrigger } from './validators';

const RECONCILIATION_OVERLAP_DAYS = 7;

const tokenEnvelopeValidator = v.object({
	encryptedRefreshToken: v.string(),
	tokenNonce: v.string(),
	tokenTag: v.string(),
	tokenKeyVersion: v.string()
});

type ReconciliationWindow = { start: string; end: string } | null;

function addUtcDays(timestamp: number, days: number): number {
	return timestamp + days * 24 * 60 * 60 * 1000;
}

function physicalTimestamp(timestamp: number): string {
	const canonical = canonicalPhysicalCoverageKey(new Date(timestamp).toISOString());
	if (canonical === undefined) throw new Error('Unable to construct reconciliation window');
	return canonical;
}

function civilTimestamp(timestamp: number): string {
	return `${new Date(timestamp).toISOString().slice(0, 19)}.000000000`;
}

function civilDate(timestamp: number): string {
	return new Date(timestamp).toISOString().slice(0, 10);
}

function reconciliationWindow(
	definition: MetricDefinition,
	anchorMs: number
): ReconciliationWindow {
	if (!Number.isFinite(anchorMs)) throw new Error('Invalid reconciliation anchor');
	if (definition.recordKind === 'daily' || definition.readMode === 'dailyRollUp') {
		return {
			start: civilDate(addUtcDays(anchorMs, -(RECONCILIATION_OVERLAP_DAYS - 1))),
			end: civilDate(addUtcDays(anchorMs, 1))
		};
	}
	const startMs = addUtcDays(anchorMs, -RECONCILIATION_OVERLAP_DAYS);
	if (definition.filterStrategies.physical !== undefined) {
		return { start: physicalTimestamp(startMs), end: physicalTimestamp(anchorMs) };
	}
	if (definition.filterStrategies.civil !== undefined) {
		return { start: civilTimestamp(startMs), end: civilTimestamp(anchorMs) };
	}
	return null;
}

function mergeWindow(
	left: { start: string; end: string },
	right: { start: string; end: string }
): { start: string; end: string } {
	return {
		start: left.start < right.start ? left.start : right.start,
		end: left.end > right.end ? left.end : right.end
	};
}

async function failStaleCursorRun(
	ctx: MutationCtx,
	cursor: Doc<'googleHealthSyncCursors'>,
	connection: Doc<'googleHealthConnections'>,
	now: number
): Promise<void> {
	if (cursor.activeRunId !== undefined) {
		const run = await ctx.db.get('googleHealthSyncRuns', cursor.activeRunId);
		if (run?.status === 'running') {
			await ctx.db.patch('googleHealthSyncRuns', run._id, {
				status: 'failed',
				finishedAt: now,
				errorCode: 'stale_generation',
				errorMessage: 'Google Health connection generation changed'
			});
		}
	}
	if (connection.activeSyncCursorId === cursor._id) {
		await ctx.db.patch('googleHealthConnections', connection._id, {
			activeSyncCursorId: undefined,
			activeSyncRunId: undefined,
			syncLeaseExpiresAt: undefined,
			syncLeaseVersion: (connection.syncLeaseVersion ?? 0) + 1
		});
	}
}

async function queueMetric(
	ctx: MutationCtx,
	args: {
		connection: Doc<'googleHealthConnections'>;
		definition: MetricDefinition;
		trigger: SyncTrigger;
		anchorMs: number;
	}
): Promise<Id<'googleHealthSyncCursors'>> {
	const existing = await ctx.db
		.query('googleHealthSyncCursors')
		.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
			q
				.eq('connectionId', args.connection._id)
				.eq('dataType', args.definition.dataType)
				.eq('mode', 'incremental')
		)
		.unique();
	const requested = reconciliationWindow(args.definition, args.anchorMs);
	const now = Date.now();
	const syncId = `${args.trigger}:${args.connection.generation}:${args.definition.dataType}:${now}`;
	if (existing === null) {
		return await ctx.db.insert('googleHealthSyncCursors', {
			connectionId: args.connection._id,
			userId: args.connection.userId,
			dataType: args.definition.dataType,
			mode: 'incremental',
			status: 'queued',
			...(requested === null ? {} : { windowStart: requested.start, windowEnd: requested.end }),
			queuedTrigger: args.trigger,
			syncId,
			attempt: 0,
			generation: args.connection.generation,
			updatedAt: now
		});
	}
	if (existing.generation !== args.connection.generation) {
		await failStaleCursorRun(ctx, existing, args.connection, now);
		await ctx.db.patch('googleHealthSyncCursors', existing._id, {
			status: 'queued',
			pageToken: undefined,
			windowStart: requested?.start,
			windowEnd: requested?.end,
			pendingWindowStart: undefined,
			pendingWindowEnd: undefined,
			pendingUnbounded: undefined,
			queuedTrigger: args.trigger,
			pendingTrigger: undefined,
			activeRunId: undefined,
			activeEpoch: undefined,
			leaseExpiresAt: undefined,
			leaseVersion: undefined,
			dispatchPending: false,
			hadMalformed: false,
			syncId,
			attempt: 0,
			generation: args.connection.generation,
			updatedAt: now
		});
		return existing._id;
	}
	const revivesUnscheduledRetry =
		existing.status === 'retry' &&
		existing.dispatchPending !== true &&
		args.connection.nextRetryAt === undefined;
	const mustDefer =
		existing.status === 'running' ||
		(existing.status === 'retry' && !revivesUnscheduledRetry) ||
		(!revivesUnscheduledRetry &&
			(existing.pageToken !== undefined || existing.activeEpoch !== undefined));
	if (mustDefer) {
		if (requested === null || existing.pendingUnbounded === true) {
			await ctx.db.patch('googleHealthSyncCursors', existing._id, {
				pendingWindowStart: undefined,
				pendingWindowEnd: undefined,
				pendingUnbounded: true,
				pendingTrigger: args.trigger,
				updatedAt: now
			});
		} else {
			const pending =
				existing.pendingWindowStart === undefined || existing.pendingWindowEnd === undefined
					? requested
					: mergeWindow(
							{
								start: existing.pendingWindowStart,
								end: existing.pendingWindowEnd
							},
							requested
						);
			await ctx.db.patch('googleHealthSyncCursors', existing._id, {
				pendingWindowStart: pending.start,
				pendingWindowEnd: pending.end,
				pendingUnbounded: undefined,
				pendingTrigger: args.trigger,
				updatedAt: now
			});
		}
		return existing._id;
	}
	const existingWindow =
		existing.status === 'queued' &&
		existing.windowStart !== undefined &&
		existing.windowEnd !== undefined
			? { start: existing.windowStart, end: existing.windowEnd }
			: null;
	const queuedWindow =
		requested === null
			? null
			: existingWindow === null
				? requested
				: mergeWindow(existingWindow, requested);
	const queuedTrigger =
		existing.dispatchPending === true ? (existing.queuedTrigger ?? args.trigger) : args.trigger;
	await ctx.db.patch('googleHealthSyncCursors', existing._id, {
		status: 'queued',
		pageToken: undefined,
		windowStart: queuedWindow?.start,
		windowEnd: queuedWindow?.end,
		pendingWindowStart: undefined,
		pendingWindowEnd: undefined,
		pendingUnbounded: undefined,
		queuedTrigger,
		pendingTrigger: undefined,
		activeRunId: undefined,
		activeEpoch: undefined,
		leaseExpiresAt: undefined,
		leaseVersion: undefined,
		dispatchPending: revivesUnscheduledRetry ? false : existing.dispatchPending,
		syncId: existing.dispatchPending === true ? existing.syncId : syncId,
		attempt: 0,
		updatedAt: now
	});
	return existing._id;
}

async function queueConnection(
	ctx: MutationCtx,
	args: {
		connection: Doc<'googleHealthConnections'>;
		trigger: SyncTrigger;
		anchorMs: number;
	}
): Promise<{ queued: number; dispatched: boolean }> {
	const scopes = new Set(args.connection.grantedScopes);
	const definitions = METRIC_DEFINITIONS.filter((definition) => scopes.has(definition.scope));
	for (const definition of definitions) {
		await queueMetric(ctx, { ...args, definition });
	}
	const currentConnection = await ctx.db.get('googleHealthConnections', args.connection._id);
	if (
		currentConnection === null ||
		currentConnection.generation !== args.connection.generation ||
		currentConnection.activeSyncRunId !== undefined
	) {
		return { queued: definitions.length, dispatched: false };
	}
	const candidates = await ctx.db
		.query('googleHealthSyncCursors')
		.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
			q.eq('connectionId', args.connection._id)
		)
		.take(100);
	if (
		candidates.some(
			(cursor) =>
				cursor.generation === args.connection.generation &&
				(cursor.status === 'queued' || cursor.status === 'retry') &&
				cursor.dispatchPending === true
		)
	) {
		return { queued: definitions.length, dispatched: false };
	}
	const next = candidates.find(
		(cursor) =>
			cursor.generation === args.connection.generation &&
			cursor.status === 'queued' &&
			cursor.dispatchPending !== true
	);
	const dispatched =
		next === undefined
			? false
			: await scheduleCursorWithWatchdog(
					ctx,
					{
						cursorId: next._id,
						generation: args.connection.generation,
						trigger: next.mode === 'backfill' ? 'oauth' : (next.queuedTrigger ?? args.trigger)
					},
					0
				);
	return { queued: definitions.length, dispatched };
}

export const syncNow = mutation({
	args: {},
	returns: v.object({ queued: v.number() }),
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const connection = await ctx.db
			.query('googleHealthConnections')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.unique();
		if (connection === null) throw new Error('Google Health connection not found');
		if (connection.status !== 'active' && connection.status !== 'backfilling') {
			throw new Error('Google Health connection is not ready to sync');
		}
		const result = await queueConnection(ctx, {
			connection,
			trigger: 'manual',
			anchorMs: Date.now()
		});
		return { queued: result.queued };
	}
});

export const queueConnectionReconciliation = internalMutation({
	args: {
		connectionId: v.id('googleHealthConnections'),
		generation: v.number(),
		trigger: syncTriggerValidator,
		anchorMs: v.number()
	},
	returns: v.object({ queued: v.number(), dispatched: v.boolean() }),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get('googleHealthConnections', args.connectionId);
		if (
			connection === null ||
			connection.generation !== args.generation ||
			!['active', 'backfilling', 'delayed'].includes(connection.status)
		) {
			return { queued: 0, dispatched: false };
		}
		return await queueConnection(ctx, {
			connection,
			trigger: args.trigger,
			anchorMs: args.anchorMs
		});
	}
});

function storedTokenEnvelope(
	connection: Doc<'googleHealthConnections'>
): EncryptedTokenEnvelope | null {
	const { encryptedRefreshToken, tokenNonce, tokenTag, tokenKeyVersion } = connection;
	return encryptedRefreshToken === undefined ||
		tokenNonce === undefined ||
		tokenTag === undefined ||
		tokenKeyVersion === undefined
		? null
		: { encryptedRefreshToken, tokenNonce, tokenTag, tokenKeyVersion };
}

async function invalidateActiveWork(
	ctx: MutationCtx,
	connection: Doc<'googleHealthConnections'>,
	now: number
): Promise<void> {
	const activeRun =
		connection.activeSyncRunId === undefined
			? null
			: await ctx.db.get('googleHealthSyncRuns', connection.activeSyncRunId);
	if (
		activeRun !== null &&
		activeRun.status === 'running' &&
		activeRun.connectionId === connection._id &&
		activeRun.generation === connection.generation
	) {
		await ctx.db.patch('googleHealthSyncRuns', activeRun._id, {
			status: 'failed',
			finishedAt: now,
			errorCode: 'stale_generation',
			errorMessage: 'Google Health connection generation changed'
		});
	}
	const activeCursor =
		connection.activeSyncCursorId === undefined
			? null
			: await ctx.db.get('googleHealthSyncCursors', connection.activeSyncCursorId);
	if (
		activeCursor !== null &&
		activeCursor.connectionId === connection._id &&
		activeCursor.generation === connection.generation
	) {
		await ctx.db.patch('googleHealthSyncCursors', activeCursor._id, {
			status: activeCursor.status === 'running' ? 'retry' : activeCursor.status,
			activeRunId: undefined,
			activeEpoch: undefined,
			leaseExpiresAt: undefined,
			leaseVersion: undefined,
			dispatchVersion: (activeCursor.dispatchVersion ?? 0) + 1,
			dispatchPending: false,
			updatedAt: now
		});
	}
}

export const transitionToDisconnected = internalMutation({
	args: { userId: v.string() },
	returns: v.object({
		status: v.literal('disconnected'),
		tokenEnvelope: v.union(tokenEnvelopeValidator, v.null())
	}),
	handler: async (
		ctx,
		args
	): Promise<{ status: 'disconnected'; tokenEnvelope: EncryptedTokenEnvelope | null }> => {
		const connection = await ctx.db
			.query('googleHealthConnections')
			.withIndex('by_userId', (q) => q.eq('userId', args.userId))
			.unique();
		if (connection === null) throw new Error('Google Health connection not found');
		if (connection.status === 'deleting')
			throw new Error('Google Health data deletion is in progress');
		if (connection.status === 'disconnected') {
			return { status: 'disconnected', tokenEnvelope: null };
		}
		const now = Date.now();
		const tokenEnvelope = storedTokenEnvelope(connection);
		await invalidateActiveWork(ctx, connection, now);
		await ctx.db.patch('googleHealthConnections', connection._id, {
			status: 'disconnected',
			generation: connection.generation + 1,
			encryptedRefreshToken: undefined,
			tokenNonce: undefined,
			tokenTag: undefined,
			tokenKeyVersion: undefined,
			activeSyncCursorId: undefined,
			activeSyncRunId: undefined,
			syncLeaseExpiresAt: undefined,
			syncLeaseVersion: (connection.syncLeaseVersion ?? 0) + 1,
			lastErrorCode: undefined,
			lastErrorMessage: undefined,
			nextRetryAt: undefined,
			disconnectedAt: now
		});
		return { status: 'disconnected', tokenEnvelope };
	}
});

async function bestEffortRevoke(
	ctx: ActionCtx,
	userId: string,
	tokenEnvelope: EncryptedTokenEnvelope | null
): Promise<void> {
	if (tokenEnvelope === null) return;
	try {
		await ctx.runAction(internal.googleHealth.accountNode.revokeToken, {
			userId,
			...tokenEnvelope
		});
	} catch {
		// Local invalidation is authoritative; remote revocation is best effort.
	}
}

export const disconnect = action({
	args: {},
	returns: v.object({ status: v.literal('disconnected') }),
	handler: async (ctx): Promise<{ status: 'disconnected' }> => {
		const userId = await requireUserId(ctx);
		const transition: {
			status: 'disconnected';
			tokenEnvelope: EncryptedTokenEnvelope | null;
		} = await ctx.runMutation(internal.googleHealth.account.transitionToDisconnected, { userId });
		await bestEffortRevoke(ctx, userId, transition.tokenEnvelope);
		return { status: transition.status };
	}
});

async function scheduleDeleteBatch(
	ctx: MutationCtx,
	connectionId: Id<'googleHealthConnections'>,
	generation: number
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.googleHealth.account.deleteGoogleDataBatch, {
		connectionId,
		generation
	});
}

export const beginDeleteImportedData = internalMutation({
	args: { userId: v.string() },
	returns: v.object({
		status: v.literal('deleting'),
		tokenEnvelope: v.union(tokenEnvelopeValidator, v.null())
	}),
	handler: async (
		ctx,
		args
	): Promise<{ status: 'deleting'; tokenEnvelope: EncryptedTokenEnvelope | null }> => {
		const connection = await ctx.db
			.query('googleHealthConnections')
			.withIndex('by_userId', (q) => q.eq('userId', args.userId))
			.unique();
		if (connection === null) throw new Error('Google Health connection not found');
		if (connection.status === 'deleting') {
			return { status: 'deleting', tokenEnvelope: null };
		}
		const now = Date.now();
		const generation = connection.generation + 1;
		const tokenEnvelope = storedTokenEnvelope(connection);
		await invalidateActiveWork(ctx, connection, now);
		await ctx.db.patch('googleHealthConnections', connection._id, {
			status: 'deleting',
			generation,
			encryptedRefreshToken: undefined,
			tokenNonce: undefined,
			tokenTag: undefined,
			tokenKeyVersion: undefined,
			activeSyncCursorId: undefined,
			activeSyncRunId: undefined,
			syncLeaseExpiresAt: undefined,
			syncLeaseVersion: (connection.syncLeaseVersion ?? 0) + 1,
			lastErrorCode: undefined,
			lastErrorMessage: undefined,
			nextRetryAt: undefined,
			disconnectedAt: now
		});
		await scheduleDeleteBatch(ctx, connection._id, generation);
		return { status: 'deleting', tokenEnvelope };
	}
});

async function continueDeletion(
	ctx: MutationCtx,
	connectionId: Id<'googleHealthConnections'>,
	generation: number
): Promise<boolean> {
	await scheduleDeleteBatch(ctx, connectionId, generation);
	return true;
}

export const deleteGoogleDataBatch = internalMutation({
	args: {
		connectionId: v.id('googleHealthConnections'),
		generation: v.number()
	},
	returns: v.boolean(),
	handler: async (ctx, args): Promise<boolean> => {
		const connection = await ctx.db.get('googleHealthConnections', args.connectionId);
		if (
			connection === null ||
			connection.generation !== args.generation ||
			connection.status !== 'deleting'
		) {
			return false;
		}

		const dependencies = await ctx.db
			.query('healthSummaryDependencies')
			.withIndex('by_connectionId', (q) => q.eq('connectionId', connection._id))
			.take(100);
		if (dependencies.length > 0) {
			for (const document of dependencies) await ctx.db.delete(document._id);
			return await continueDeletion(ctx, connection._id, args.generation);
		}
		const contributions = await ctx.db
			.query('healthDataPointContributions')
			.withIndex('by_connectionId_and_dataType_and_physicalCoverageKey', (q) =>
				q.eq('connectionId', connection._id)
			)
			.take(100);
		if (contributions.length > 0) {
			for (const document of contributions) await ctx.db.delete(document._id);
			return await continueDeletion(ctx, connection._id, args.generation);
		}
		const rebuilds = await ctx.db
			.query('healthSummaryRebuilds')
			.withIndex('by_connectionId', (q) => q.eq('connectionId', connection._id))
			.take(100);
		if (rebuilds.length > 0) {
			for (const document of rebuilds) await ctx.db.delete(document._id);
			return await continueDeletion(ctx, connection._id, args.generation);
		}
		// A normalized point may be close to Convex's per-document limit. One point
		// per transaction keeps adversarial payloads comfortably below read limits.
		const points = await ctx.db
			.query('healthDataPoints')
			.withIndex('by_connectionId', (q) => q.eq('connectionId', connection._id))
			.take(1);
		if (points.length > 0) {
			for (const document of points) await ctx.db.delete(document._id);
			return await continueDeletion(ctx, connection._id, args.generation);
		}
		const summaries = await ctx.db
			.query('healthDailySummaries')
			.withIndex('by_connectionId', (q) => q.eq('connectionId', connection._id))
			.take(100);
		if (summaries.length > 0) {
			for (const document of summaries) await ctx.db.delete(document._id);
			return await continueDeletion(ctx, connection._id, args.generation);
		}
		const tombstones = await ctx.db
			.query('googleHealthRecordTombstones')
			.withIndex('by_connectionId_and_generation_and_recordKey', (q) =>
				q.eq('connectionId', connection._id)
			)
			.take(100);
		if (tombstones.length > 0) {
			for (const document of tombstones) await ctx.db.delete(document._id);
			return await continueDeletion(ctx, connection._id, args.generation);
		}
		const cursors = await ctx.db
			.query('googleHealthSyncCursors')
			.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
				q.eq('connectionId', connection._id)
			)
			.take(100);
		if (cursors.length > 0) {
			for (const document of cursors) await ctx.db.delete(document._id);
			return await continueDeletion(ctx, connection._id, args.generation);
		}
		const runs = await ctx.db
			.query('googleHealthSyncRuns')
			.withIndex('by_connectionId_and_startedAt', (q) => q.eq('connectionId', connection._id))
			.take(100);
		if (runs.length > 0) {
			for (const document of runs) await ctx.db.delete(document._id);
			return await continueDeletion(ctx, connection._id, args.generation);
		}
		const oauthStates = await ctx.db
			.query('googleHealthOAuthStates')
			.withIndex('by_userId', (q) => q.eq('userId', connection.userId))
			.take(100);
		if (oauthStates.length > 0) {
			for (const document of oauthStates) await ctx.db.delete(document._id);
			return await continueDeletion(ctx, connection._id, args.generation);
		}
		await ctx.db.delete(connection._id);
		return true;
	}
});

export const deleteImportedData = action({
	args: { confirmation: v.string() },
	returns: v.object({ status: v.literal('deleting') }),
	handler: async (ctx, args): Promise<{ status: 'deleting' }> => {
		const userId = await requireUserId(ctx);
		if (args.confirmation !== 'DELETE GOOGLE DATA') {
			throw new Error('Type DELETE GOOGLE DATA to confirm');
		}
		const transition: {
			status: 'deleting';
			tokenEnvelope: EncryptedTokenEnvelope | null;
		} = await ctx.runMutation(internal.googleHealth.account.beginDeleteImportedData, { userId });
		await bestEffortRevoke(ctx, userId, transition.tokenEnvelope);
		return { status: transition.status };
	}
});
