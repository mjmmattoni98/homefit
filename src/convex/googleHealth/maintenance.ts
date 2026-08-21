import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, TableNames } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';

const CONNECTION_BATCH_SIZE = 50;
const CLEANUP_BATCH_SIZE = 100;
// Delivery rows may contain a 256 KiB raw body or 99 normalized notifications.
// Keep their read batch comfortably below Convex's 16 MiB transaction limit.
const DELIVERY_CLEANUP_BATCH_SIZE = 24;
const DAY_MS = 24 * 60 * 60 * 1000;
const SUCCEEDED_RUN_RETENTION_MS = 30 * DAY_MS;
const FAILED_RUN_RETENTION_MS = 90 * DAY_MS;
const WEBHOOK_BACKLOG_HORIZON_MS = 7 * DAY_MS;
// Keep terminal delivery digests for eight days: Google's seven-day retry
// horizon plus a full day of clock/retry safety before deduplication expires.
const TERMINAL_DELIVERY_RETENTION_MS = 8 * DAY_MS;
const STALE_TOMBSTONE_RETENTION_MS = 8 * DAY_MS;

const RECONCILIATION_STATUSES = ['active', 'backfilling', 'delayed'] as const;

const reconciliationCursorValidator = v.object({
	statusIndex: v.number(),
	afterUserId: v.optional(v.string())
});

type ReconciliationCursor = {
	statusIndex: number;
	afterUserId?: string;
};

const cleanupPhaseValidator = v.union(
	v.literal('expired_oauth'),
	v.literal('succeeded_runs'),
	v.literal('failed_runs'),
	v.literal('stale_queued_deliveries'),
	v.literal('stale_verifying_deliveries'),
	v.literal('stale_retry_deliveries'),
	v.literal('stale_applying_deliveries'),
	v.literal('terminal_complete_deliveries'),
	v.literal('terminal_rejected_deliveries'),
	v.literal('stale_tombstones')
);

const cleanupCursorValidator = v.object({
	phase: cleanupPhaseValidator,
	paginationCursor: v.optional(v.string())
});

type CleanupPhase =
	| 'expired_oauth'
	| 'succeeded_runs'
	| 'failed_runs'
	| 'stale_queued_deliveries'
	| 'stale_verifying_deliveries'
	| 'stale_retry_deliveries'
	| 'stale_applying_deliveries'
	| 'terminal_complete_deliveries'
	| 'terminal_rejected_deliveries'
	| 'stale_tombstones';

type CleanupCursor = {
	phase: CleanupPhase;
	paginationCursor?: string;
};

const CLEANUP_PHASES: readonly CleanupPhase[] = [
	'expired_oauth',
	'succeeded_runs',
	'failed_runs',
	'stale_queued_deliveries',
	'stale_verifying_deliveries',
	'stale_retry_deliveries',
	'stale_applying_deliveries',
	'terminal_complete_deliveries',
	'terminal_rejected_deliveries',
	'stale_tombstones'
];

function validAnchor(anchorMs: number | undefined): number {
	const anchor = anchorMs ?? Date.now();
	if (!Number.isFinite(anchor)) throw new Error('Invalid maintenance anchor');
	return anchor;
}

function validReconciliationCursor(cursor: ReconciliationCursor | undefined): ReconciliationCursor {
	const value = cursor ?? { statusIndex: 0 };
	if (
		!Number.isInteger(value.statusIndex) ||
		value.statusIndex < 0 ||
		value.statusIndex >= RECONCILIATION_STATUSES.length
	) {
		throw new Error('Invalid reconciliation cursor');
	}
	return value;
}

async function scheduleReconciliationContinuation(
	ctx: MutationCtx,
	cursor: ReconciliationCursor,
	anchorMs: number
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.googleHealth.maintenance.scheduleDailyReconciliation, {
		cursor,
		anchorMs
	});
}

export const scheduleDailyReconciliation = internalMutation({
	args: {
		cursor: v.optional(reconciliationCursorValidator),
		anchorMs: v.optional(v.number())
	},
	returns: v.object({
		scheduled: v.number(),
		continuationCursor: v.optional(reconciliationCursorValidator)
	}),
	handler: async (
		ctx,
		args
	): Promise<{ scheduled: number; continuationCursor?: ReconciliationCursor }> => {
		const anchorMs = validAnchor(args.anchorMs);
		let cursor = validReconciliationCursor(args.cursor);
		let scheduled = 0;
		while (cursor.statusIndex < RECONCILIATION_STATUSES.length) {
			const status = RECONCILIATION_STATUSES[cursor.statusIndex];
			const remaining = CONNECTION_BATCH_SIZE - scheduled;
			if (remaining === 0) {
				await scheduleReconciliationContinuation(ctx, cursor, anchorMs);
				return { scheduled, continuationCursor: cursor };
			}
			const connections = await ctx.db
				.query('googleHealthConnections')
				.withIndex('by_status_and_userId', (q) => {
					const statusQuery = q.eq('status', status);
					return cursor.afterUserId === undefined
						? statusQuery
						: statusQuery.gt('userId', cursor.afterUserId);
				})
				.take(remaining + 1);
			const selected = connections.slice(0, remaining);
			for (const connection of selected) {
				await ctx.scheduler.runAfter(
					0,
					internal.googleHealth.account.queueConnectionReconciliation,
					{
						connectionId: connection._id,
						generation: connection.generation,
						trigger: 'reconciliation',
						anchorMs
					}
				);
			}
			scheduled += selected.length;
			if (connections.length > selected.length) {
				const last = selected.at(-1);
				if (last === undefined) throw new Error('Unable to advance reconciliation cursor');
				const continuationCursor = { statusIndex: cursor.statusIndex, afterUserId: last.userId };
				await scheduleReconciliationContinuation(ctx, continuationCursor, anchorMs);
				return { scheduled, continuationCursor };
			}
			cursor = { statusIndex: cursor.statusIndex + 1 };
		}
		return { scheduled };
	}
});

function nextCleanupPhase(phase: CleanupPhase): CleanupPhase | null {
	const index = CLEANUP_PHASES.indexOf(phase);
	return index < 0 || index + 1 >= CLEANUP_PHASES.length ? null : CLEANUP_PHASES[index + 1];
}

async function scheduleCleanupContinuation(
	ctx: MutationCtx,
	cursor: CleanupCursor,
	anchorMs: number
): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.googleHealth.maintenance.cleanupOperationalData, {
		cursor,
		anchorMs
	});
}

async function advanceCleanup(
	ctx: MutationCtx,
	phase: CleanupPhase,
	anchorMs: number
): Promise<{ processed: number; complete: boolean }> {
	const next = nextCleanupPhase(phase);
	if (next === null) return { processed: 0, complete: true };
	await scheduleCleanupContinuation(ctx, { phase: next }, anchorMs);
	return { processed: 0, complete: false };
}

async function deleteBatch<TableName extends TableNames>(
	ctx: MutationCtx,
	documents: readonly Doc<TableName>[],
	cursor: CleanupCursor,
	anchorMs: number
): Promise<{ processed: number; complete: boolean }> {
	for (const document of documents) {
		await ctx.db.delete(document._id);
	}
	await scheduleCleanupContinuation(ctx, cursor, anchorMs);
	return { processed: documents.length, complete: false };
}

async function terminalizeStaleDeliveries(
	ctx: MutationCtx,
	status: 'queued' | 'verifying' | 'retry' | 'applying',
	cursor: CleanupCursor,
	anchorMs: number
): Promise<{ processed: number; complete: boolean }> {
	const page = await ctx.db
		.query('googleHealthWebhookDeliveries')
		.withIndex('by_status_and_updatedAt', (q) => q.eq('status', status))
		.paginate({
			numItems: DELIVERY_CLEANUP_BATCH_SIZE,
			cursor: cursor.paginationCursor ?? null
		});
	for (const delivery of page.page) {
		const acceptedAt = delivery.acceptedAt ?? delivery._creationTime;
		if (acceptedAt >= anchorMs - WEBHOOK_BACKLOG_HORIZON_MS) {
			if (delivery.acceptedAt === undefined) {
				await ctx.db.patch('googleHealthWebhookDeliveries', delivery._id, { acceptedAt });
			}
			continue;
		}
		await ctx.db.patch('googleHealthWebhookDeliveries', delivery._id, {
			acceptedAt,
			status: 'rejected',
			rawBody: undefined,
			signature: undefined,
			notifications: undefined,
			nextNotificationIndex: undefined,
			leaseExpiresAt: undefined,
			nextAttemptAt: undefined,
			lastErrorCode: 'delivery_retention_expired',
			updatedAt: anchorMs
		});
	}
	if (!page.isDone) {
		await scheduleCleanupContinuation(
			ctx,
			{ phase: cursor.phase, paginationCursor: page.continueCursor },
			anchorMs
		);
		return { processed: page.page.length, complete: false };
	}
	const advanced = await advanceCleanup(ctx, cursor.phase, anchorMs);
	return { processed: page.page.length, complete: advanced.complete };
}

async function cleanTerminalDeliveries(
	ctx: MutationCtx,
	status: 'complete' | 'rejected',
	cursor: CleanupCursor,
	anchorMs: number
): Promise<{ processed: number; complete: boolean }> {
	const deliveries = await ctx.db
		.query('googleHealthWebhookDeliveries')
		.withIndex('by_status_and_updatedAt', (q) =>
			q.eq('status', status).lt('updatedAt', anchorMs - TERMINAL_DELIVERY_RETENTION_MS)
		)
		.take(DELIVERY_CLEANUP_BATCH_SIZE);
	if (deliveries.length === 0) return await advanceCleanup(ctx, cursor.phase, anchorMs);
	for (const delivery of deliveries) await ctx.db.delete(delivery._id);
	await scheduleCleanupContinuation(ctx, cursor, anchorMs);
	return { processed: deliveries.length, complete: false };
}

async function cleanStaleTombstones(
	ctx: MutationCtx,
	cursor: CleanupCursor,
	anchorMs: number
): Promise<{ processed: number; complete: boolean }> {
	const page = await ctx.db
		.query('googleHealthRecordTombstones')
		.withIndex('by_updatedAt', (q) => q.lt('updatedAt', anchorMs - STALE_TOMBSTONE_RETENTION_MS))
		.paginate({ numItems: CLEANUP_BATCH_SIZE, cursor: cursor.paginationCursor ?? null });
	let processed = 0;
	for (const tombstone of page.page) {
		const connection = await ctx.db.get('googleHealthConnections', tombstone.connectionId);
		if (connection === null || connection.generation !== tombstone.generation) {
			await ctx.db.delete(tombstone._id);
			processed += 1;
		}
	}
	if (!page.isDone) {
		await scheduleCleanupContinuation(
			ctx,
			{ phase: 'stale_tombstones', paginationCursor: page.continueCursor },
			anchorMs
		);
		return { processed, complete: false };
	}
	return { processed, complete: true };
}

export const cleanupOperationalData = internalMutation({
	args: {
		cursor: v.optional(cleanupCursorValidator),
		anchorMs: v.optional(v.number())
	},
	returns: v.object({ processed: v.number(), complete: v.boolean() }),
	handler: async (ctx, args): Promise<{ processed: number; complete: boolean }> => {
		const anchorMs = validAnchor(args.anchorMs);
		const cursor: CleanupCursor = args.cursor ?? { phase: 'expired_oauth' };
		if (cursor.phase === 'expired_oauth') {
			const rows = await ctx.db
				.query('googleHealthOAuthStates')
				.withIndex('by_expiresAt', (q) => q.lte('expiresAt', anchorMs))
				.take(CLEANUP_BATCH_SIZE);
			return rows.length === 0
				? await advanceCleanup(ctx, cursor.phase, anchorMs)
				: await deleteBatch(ctx, rows, cursor, anchorMs);
		}
		if (cursor.phase === 'succeeded_runs' || cursor.phase === 'failed_runs') {
			const status = cursor.phase === 'succeeded_runs' ? 'succeeded' : 'failed';
			const retention =
				status === 'succeeded' ? SUCCEEDED_RUN_RETENTION_MS : FAILED_RUN_RETENTION_MS;
			const rows = await ctx.db
				.query('googleHealthSyncRuns')
				.withIndex('by_status_and_startedAt', (q) =>
					q.eq('status', status).lt('startedAt', anchorMs - retention)
				)
				.take(CLEANUP_BATCH_SIZE);
			return rows.length === 0
				? await advanceCleanup(ctx, cursor.phase, anchorMs)
				: await deleteBatch(ctx, rows, cursor, anchorMs);
		}
		if (cursor.phase === 'stale_queued_deliveries')
			return await terminalizeStaleDeliveries(ctx, 'queued', cursor, anchorMs);
		if (cursor.phase === 'stale_verifying_deliveries')
			return await terminalizeStaleDeliveries(ctx, 'verifying', cursor, anchorMs);
		if (cursor.phase === 'stale_retry_deliveries')
			return await terminalizeStaleDeliveries(ctx, 'retry', cursor, anchorMs);
		if (cursor.phase === 'stale_applying_deliveries')
			return await terminalizeStaleDeliveries(ctx, 'applying', cursor, anchorMs);
		if (cursor.phase === 'terminal_complete_deliveries')
			return await cleanTerminalDeliveries(ctx, 'complete', cursor, anchorMs);
		if (cursor.phase === 'terminal_rejected_deliveries')
			return await cleanTerminalDeliveries(ctx, 'rejected', cursor, anchorMs);
		return await cleanStaleTombstones(ctx, cursor, anchorMs);
	}
});
