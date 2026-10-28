import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/types';
import {
	googleHealthConnection,
	googleHealthOAuthState,
	googleHealthRecordTombstone,
	googleHealthSyncRun,
	googleHealthWebhookDelivery
} from '../db/schema';
import { toCursorOwner } from './connection';
import { queueReconciliation } from './cursors';
import { SYNCABLE_STATUSES } from './types';
import { expireStaleDeliveries } from './webhook';

const DAY_MS = 24 * 60 * 60 * 1000;
const SUCCEEDED_RUN_RETENTION_MS = 30 * DAY_MS;
const FAILED_RUN_RETENTION_MS = 90 * DAY_MS;
const WEBHOOK_BACKLOG_HORIZON_MS = 7 * DAY_MS;
// Google retries deliveries for up to seven days; keep digests one more day to deduplicate them.
const TERMINAL_DELIVERY_RETENTION_MS = 8 * DAY_MS;
const STALE_TOMBSTONE_RETENTION_MS = 8 * DAY_MS;

/**
 * Queues the overlapping daily reconciliation for every connection that can sync. Returns the
 * connections that received work so the caller can dispatch them.
 */
export async function queueDailyReconciliation(
	db: Database,
	anchorMs = Date.now()
): Promise<string[]> {
	const connections = await db
		.select({ id: googleHealthConnection.id })
		.from(googleHealthConnection)
		.where(inArray(googleHealthConnection.status, [...SYNCABLE_STATUSES]));
	const queued: string[] = [];
	for (const { id } of connections) {
		const done = await db.transaction(async (tx) => {
			const [connection] = await tx
				.select()
				.from(googleHealthConnection)
				.where(eq(googleHealthConnection.id, id))
				.for('update');
			if (connection === undefined || !SYNCABLE_STATUSES.has(connection.status)) return false;
			await queueReconciliation(tx, toCursorOwner(connection), 'reconciliation', anchorMs);
			return true;
		});
		if (done) queued.push(id);
	}
	return queued;
}

export interface CleanupResult {
	oauthStates: number;
	syncRuns: number;
	expiredDeliveries: number;
	deliveries: number;
	tombstones: number;
}

/** Removes expired handshakes and operational history past their retention windows. */
export async function cleanupOperationalData(
	db: Database,
	anchorMs = Date.now()
): Promise<CleanupResult> {
	const before = (ms: number) => new Date(anchorMs - ms);
	const oauthStates = await db
		.delete(googleHealthOAuthState)
		.where(lt(googleHealthOAuthState.expiresAt, new Date(anchorMs)))
		.returning({ id: googleHealthOAuthState.id });
	const succeededRuns = await db
		.delete(googleHealthSyncRun)
		.where(
			and(
				eq(googleHealthSyncRun.status, 'succeeded'),
				lt(googleHealthSyncRun.startedAt, before(SUCCEEDED_RUN_RETENTION_MS))
			)
		)
		.returning({ id: googleHealthSyncRun.id });
	const failedRuns = await db
		.delete(googleHealthSyncRun)
		.where(
			and(
				ne(googleHealthSyncRun.status, 'succeeded'),
				lt(googleHealthSyncRun.startedAt, before(FAILED_RUN_RETENTION_MS))
			)
		)
		.returning({ id: googleHealthSyncRun.id });
	const expiredDeliveries = await expireStaleDeliveries(db, before(WEBHOOK_BACKLOG_HORIZON_MS));
	const deliveries = await db
		.delete(googleHealthWebhookDelivery)
		.where(
			and(
				inArray(googleHealthWebhookDelivery.status, ['complete', 'rejected']),
				lt(googleHealthWebhookDelivery.updatedAt, before(TERMINAL_DELIVERY_RETENTION_MS))
			)
		)
		.returning({ id: googleHealthWebhookDelivery.id });
	// Current-generation tombstones are kept until a later reconciliation pass consumes them.
	const tombstones = await db
		.delete(googleHealthRecordTombstone)
		.where(
			and(
				lt(googleHealthRecordTombstone.updatedAt, before(STALE_TOMBSTONE_RETENTION_MS)),
				sql`${googleHealthRecordTombstone.generation} <> (
					select ${googleHealthConnection.generation} from ${googleHealthConnection}
					where ${googleHealthConnection.id} = ${googleHealthRecordTombstone.connectionId}
				)`
			)
		)
		.returning({ recordKey: googleHealthRecordTombstone.recordKey });
	return {
		oauthStates: oauthStates.length,
		syncRuns: succeededRuns.length + failedRuns.length,
		expiredDeliveries,
		deliveries: deliveries.length,
		tombstones: tombstones.length
	};
}
