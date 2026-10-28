import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Executor } from '../db/types';
import { googleHealthConnection, googleHealthSyncCursor } from '../db/schema';
import { canonicalPhysicalCoverageKey } from './normalize';
import { METRIC_DEFINITIONS, type MetricDefinition } from './registry';
import type { SyncTrigger } from './types';

export const RECONCILIATION_OVERLAP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type Cursor = typeof googleHealthSyncCursor.$inferSelect;
export type SyncWindow = { start: string; end: string };

export interface CursorOwner {
	connectionId: string;
	generation: number;
	grantedScopes: readonly string[];
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

/** The overlapping window re-read by manual and daily reconciliation, or `null` if unbounded. */
export function reconciliationWindow(
	definition: MetricDefinition,
	anchorMs: number
): SyncWindow | null {
	if (!Number.isFinite(anchorMs)) throw new Error('Invalid reconciliation anchor');
	if (definition.recordKind === 'daily' || definition.readMode === 'dailyRollUp') {
		return {
			start: civilDate(anchorMs - (RECONCILIATION_OVERLAP_DAYS - 1) * DAY_MS),
			end: civilDate(anchorMs + DAY_MS)
		};
	}
	const startMs = anchorMs - RECONCILIATION_OVERLAP_DAYS * DAY_MS;
	if (definition.filterStrategies.physical !== undefined) {
		return { start: physicalTimestamp(startMs), end: physicalTimestamp(anchorMs) };
	}
	if (definition.filterStrategies.civil !== undefined) {
		return { start: civilTimestamp(startMs), end: civilTimestamp(anchorMs) };
	}
	return null;
}

function mergeWindows(left: SyncWindow, right: SyncWindow): SyncWindow {
	return {
		start: left.start < right.start ? left.start : right.start,
		end: left.end > right.end ? left.end : right.end
	};
}

export function grantedDefinitions(grantedScopes: readonly string[]): MetricDefinition[] {
	const scopes = new Set(grantedScopes);
	return METRIC_DEFINITIONS.filter((definition) => scopes.has(definition.scope));
}

/**
 * Creates or resets one backfill cursor per granted metric for a new connection generation.
 * Reconnecting re-imports the full history, which is idempotent and fills any gap.
 */
export async function initializeBackfillCursors(tx: Executor, owner: CursorOwner): Promise<number> {
	const definitions = grantedDefinitions(owner.grantedScopes);
	if (definitions.length === 0) return 0;
	await tx
		.insert(googleHealthSyncCursor)
		.values(
			definitions.map((definition) => ({
				connectionId: owner.connectionId,
				dataType: definition.dataType,
				mode: 'backfill' as const,
				status: 'queued' as const,
				generation: owner.generation,
				trigger: 'oauth' as const
			}))
		)
		.onConflictDoUpdate({
			target: [
				googleHealthSyncCursor.connectionId,
				googleHealthSyncCursor.dataType,
				googleHealthSyncCursor.mode
			],
			set: {
				status: 'queued',
				generation: owner.generation,
				trigger: 'oauth',
				pageToken: null,
				windowStart: null,
				windowEnd: null,
				pendingWindowStart: null,
				pendingWindowEnd: null,
				pendingUnbounded: false,
				pendingTrigger: null,
				activeEpoch: null,
				hadMalformed: false,
				attempt: 0,
				nextAttemptAt: null,
				claimId: null,
				claimExpiresAt: null
			}
		});
	return definitions.length;
}

function isMidUnit(cursor: Cursor): boolean {
	if (cursor.status === 'complete' || cursor.status === 'failed') return false;
	return (
		cursor.status === 'running' ||
		cursor.status === 'retry' ||
		cursor.pageToken !== null ||
		cursor.activeEpoch !== null
	);
}

/**
 * Queues incremental work for one metric. Requests arriving while the cursor is in the middle
 * of a unit of work are coalesced into a pending window that runs once the unit finishes.
 * A `null` window requests an unbounded read for metrics that cannot be filtered by time.
 */
export async function queueIncrementalWindow(
	tx: Executor,
	owner: CursorOwner,
	dataType: string,
	requested: SyncWindow | null,
	trigger: SyncTrigger
): Promise<void> {
	const [existing] = await tx
		.select()
		.from(googleHealthSyncCursor)
		.where(
			and(
				eq(googleHealthSyncCursor.connectionId, owner.connectionId),
				eq(googleHealthSyncCursor.dataType, dataType),
				eq(googleHealthSyncCursor.mode, 'incremental')
			)
		)
		.for('update');
	const fresh = {
		status: 'queued' as const,
		generation: owner.generation,
		trigger,
		pageToken: null,
		windowStart: requested?.start ?? null,
		windowEnd: requested?.end ?? null,
		pendingWindowStart: null,
		pendingWindowEnd: null,
		pendingUnbounded: false,
		pendingTrigger: null,
		activeEpoch: null,
		hadMalformed: false,
		attempt: 0,
		nextAttemptAt: null,
		claimId: null,
		claimExpiresAt: null
	};
	if (existing === undefined) {
		await tx.insert(googleHealthSyncCursor).values({
			connectionId: owner.connectionId,
			dataType,
			mode: 'incremental',
			...fresh
		});
		return;
	}
	if (existing.generation !== owner.generation) {
		await tx
			.update(googleHealthSyncCursor)
			.set(fresh)
			.where(eq(googleHealthSyncCursor.id, existing.id));
		return;
	}
	if (isMidUnit(existing)) {
		const unbounded = requested === null || existing.pendingUnbounded;
		const pending =
			unbounded || requested === null
				? null
				: existing.pendingWindowStart !== null && existing.pendingWindowEnd !== null
					? mergeWindows(
							{ start: existing.pendingWindowStart, end: existing.pendingWindowEnd },
							requested
						)
					: requested;
		await tx
			.update(googleHealthSyncCursor)
			.set({
				pendingUnbounded: unbounded,
				pendingWindowStart: pending?.start ?? null,
				pendingWindowEnd: pending?.end ?? null,
				pendingTrigger: trigger
			})
			.where(eq(googleHealthSyncCursor.id, existing.id));
		return;
	}
	// Idle (queued, complete or failed): queue now, widening an already queued window.
	const queuedWindow =
		existing.status === 'queued' &&
		requested !== null &&
		existing.windowStart !== null &&
		existing.windowEnd !== null
			? mergeWindows({ start: existing.windowStart, end: existing.windowEnd }, requested)
			: requested;
	await tx
		.update(googleHealthSyncCursor)
		.set({
			...fresh,
			windowStart: queuedWindow?.start ?? null,
			windowEnd: queuedWindow?.end ?? null
		})
		.where(eq(googleHealthSyncCursor.id, existing.id));
}

/**
 * Queues the overlapping reconciliation window for every granted metric, and revives backfill
 * cursors that stopped on a non-retryable error so a manual or daily sync can recover them.
 */
export async function queueReconciliation(
	tx: Executor,
	owner: CursorOwner,
	trigger: SyncTrigger,
	anchorMs: number
): Promise<number> {
	const definitions = grantedDefinitions(owner.grantedScopes);
	for (const definition of definitions) {
		await queueIncrementalWindow(
			tx,
			owner,
			definition.dataType,
			reconciliationWindow(definition, anchorMs),
			trigger
		);
	}
	const revived = await tx
		.update(googleHealthSyncCursor)
		.set({ status: 'queued', attempt: 0, nextAttemptAt: null })
		.where(
			and(
				eq(googleHealthSyncCursor.connectionId, owner.connectionId),
				eq(googleHealthSyncCursor.generation, owner.generation),
				eq(googleHealthSyncCursor.mode, 'backfill'),
				eq(googleHealthSyncCursor.status, 'failed')
			)
		)
		.returning({ id: googleHealthSyncCursor.id });
	if (revived.length > 0) {
		const completed = await countFinishedBackfills(tx, owner.connectionId, owner.generation);
		await tx
			.update(googleHealthConnection)
			.set({
				backfillCompletedTypes: completed,
				status: sql`case when ${googleHealthConnection.status} = 'active' then 'backfilling' else ${googleHealthConnection.status} end`
			})
			.where(eq(googleHealthConnection.id, owner.connectionId));
	}
	return definitions.length;
}

/** Backfill cursors of the current generation that finished, successfully or not. */
export async function countFinishedBackfills(
	tx: Executor,
	connectionId: string,
	generation: number
): Promise<number> {
	const [row] = await tx
		.select({ count: sql<number>`count(*)::int` })
		.from(googleHealthSyncCursor)
		.where(
			and(
				eq(googleHealthSyncCursor.connectionId, connectionId),
				eq(googleHealthSyncCursor.generation, generation),
				eq(googleHealthSyncCursor.mode, 'backfill'),
				inArray(googleHealthSyncCursor.status, ['complete', 'failed'])
			)
		);
	return row.count;
}

/** SQL predicate matching cursors that a worker may claim right now. */
export const claimableCursor = sql`(
	${googleHealthSyncCursor.status} = 'queued'
	or (${googleHealthSyncCursor.status} = 'retry' and ${googleHealthSyncCursor.nextAttemptAt} <= now())
	or (${googleHealthSyncCursor.status} = 'running' and ${googleHealthSyncCursor.claimExpiresAt} < now())
)`;
