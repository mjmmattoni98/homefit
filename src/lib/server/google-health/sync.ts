import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, isNull, or, sql } from 'drizzle-orm';
import type { Database, Executor } from '../db/types';
import { googleHealthConnection, googleHealthSyncCursor, googleHealthSyncRun } from '../db/schema';
import {
	GoogleHealthError,
	fetchGoogleHealthDataPage,
	refreshAccessToken,
	type GoogleHealthTimeFilter
} from './api-client';
import type { GoogleHealthConfig } from './config';
import { storedTokenEnvelope } from './connection';
import {
	encryptRefreshToken,
	rotateRefreshTokenEnvelope,
	type EncryptedTokenEnvelope
} from './crypto';
import { claimableCursor, countFinishedBackfills } from './cursors';
import { canonicalPhysicalCoverageKey, normalizeGooglePoint } from './normalize';
import { getMetricDefinition, type MetricDefinition } from './registry';
import {
	applyPoints,
	deleteUnseenInRange,
	rebuildDailySummaries,
	type CoveredRange,
	type PointOwner
} from './store';
import { SYNCABLE_STATUSES, type NormalizedHealthPoint, type SyncTrigger } from './types';

const FIRST_ROLLUP_DATE = '2000-01-01';
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_MARGIN_MS = 60_000;
/** How long one job may work on a connection before yielding to let other connections run. */
export const DEFAULT_SYNC_BUDGET_MS = 4 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type ConnectionRow = typeof googleHealthConnection.$inferSelect;
type CursorRow = typeof googleHealthSyncCursor.$inferSelect;

/** Thrown when another worker or a lifecycle change took ownership of the work. */
class LostOwnershipError extends Error {}

interface Claim {
	connection: ConnectionRow;
	cursor: CursorRow;
	claimId: string;
	runId: string;
}

interface AccessToken {
	token: string;
	expiresAt: number;
	grantedScopes: readonly string[];
	/** The connection generation whose refresh token issued it; a reconnect invalidates it. */
	generation: number;
}

interface Completion {
	nextPageToken?: string;
	nextWindow?: { start: string; end: string };
	finish: boolean;
}

export interface SyncDeps {
	db: Database;
	config: GoogleHealthConfig;
	/** Milliseconds the worker may keep processing before it yields. */
	budgetMs?: number;
}

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
	return addDays(new Date().toISOString().slice(0, 10), 1);
}

/** Capped exponential backoff with ±20 % jitter. */
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
	cursor: CursorRow,
	definition: MetricDefinition
): GoogleHealthTimeFilter | undefined {
	if (
		cursor.mode !== 'incremental' ||
		cursor.windowStart === null ||
		cursor.windowEnd === null ||
		// Daily roll-ups are bounded by their date range and do not accept a filter.
		definition.readMode === 'dailyRollUp'
	) {
		return undefined;
	}
	const physical = definition.filterStrategies.physical;
	if (physical !== undefined && isPhysical(cursor.windowStart) && isPhysical(cursor.windowEnd)) {
		return {
			axis: 'physical',
			field: physical.field,
			comparison: physical.comparison,
			start: cursor.windowStart,
			...(physical.comparison === 'closedOpen' ? { end: cursor.windowEnd } : {})
		};
	}
	const civil = definition.filterStrategies.civil;
	if (civil !== undefined && isCivil(cursor.windowStart) && isCivil(cursor.windowEnd)) {
		return {
			axis: 'civil',
			field: civil.field,
			comparison: civil.comparison,
			start: cursor.windowStart,
			...(civil.comparison === 'closedOpen' ? { end: cursor.windowEnd } : {})
		};
	}
	// Bounds from a different clock must never be coerced into a filter.
	return undefined;
}

function completionFor(
	pageToken: string | undefined,
	rollupRange: { start: string; end: string } | undefined
): Completion {
	if (pageToken !== undefined) return { nextPageToken: pageToken, finish: false };
	if (rollupRange !== undefined) {
		const terminal = currentExclusiveCivilDate();
		if (rollupRange.end < terminal) {
			return {
				nextWindow: {
					start: rollupRange.end,
					end: minDate(addDays(rollupRange.end, 14), terminal)
				},
				finish: false
			};
		}
	}
	return { finish: true };
}

/** The window a completed read fully covers, used to remove records Google no longer returns. */
function coveredRangeFor(
	cursor: CursorRow,
	definition: MetricDefinition,
	filter: GoogleHealthTimeFilter | undefined,
	rollupRange: { start: string; end: string } | undefined
): CoveredRange | undefined {
	if (rollupRange !== undefined) {
		return { kind: 'civil', startDate: rollupRange.start, endDateExclusive: rollupRange.end };
	}
	if (
		cursor.mode !== 'incremental' ||
		definition.readMode !== 'reconcile' ||
		filter?.comparison !== 'closedOpen' ||
		filter.end === undefined
	) {
		return undefined;
	}
	if (filter.axis === 'civil') {
		return { kind: 'civil', startDate: filter.start, endDateExclusive: filter.end };
	}
	const startKey = canonicalPhysicalCoverageKey(filter.start);
	const endKeyExclusive = canonicalPhysicalCoverageKey(filter.end);
	return startKey === undefined || endKeyExclusive === undefined
		? undefined
		: { kind: 'physical', startKey, endKeyExclusive };
}

/** Connections that have claimable work and are not waiting out a retry delay. */
export async function findDueConnections(db: Database, limit = 500): Promise<string[]> {
	const rows = await db
		.selectDistinct({ id: googleHealthConnection.id })
		.from(googleHealthConnection)
		.innerJoin(
			googleHealthSyncCursor,
			and(
				eq(googleHealthSyncCursor.connectionId, googleHealthConnection.id),
				eq(googleHealthSyncCursor.generation, googleHealthConnection.generation)
			)
		)
		.where(
			and(
				inArray(googleHealthConnection.status, [...SYNCABLE_STATUSES]),
				or(
					isNull(googleHealthConnection.nextRetryAt),
					lte(googleHealthConnection.nextRetryAt, sql`now()`)
				),
				claimableCursor
			)
		)
		.limit(limit);
	return rows.map((row) => row.id);
}

async function claimNextCursor(db: Database, connectionId: string): Promise<Claim | null> {
	return await db.transaction(async (tx) => {
		const [connection] = await tx
			.select()
			.from(googleHealthConnection)
			.where(eq(googleHealthConnection.id, connectionId))
			.for('update');
		if (connection === undefined || !SYNCABLE_STATUSES.has(connection.status)) return null;
		if (connection.nextRetryAt !== null && connection.nextRetryAt.getTime() > Date.now())
			return null;
		const [cursor] = await tx
			.select()
			.from(googleHealthSyncCursor)
			.where(
				and(
					eq(googleHealthSyncCursor.connectionId, connectionId),
					eq(googleHealthSyncCursor.generation, connection.generation),
					claimableCursor
				)
			)
			// Finish the historical import before incremental work, oldest request first.
			.orderBy(
				desc(sql`${googleHealthSyncCursor.mode} = 'backfill'`),
				asc(googleHealthSyncCursor.updatedAt)
			)
			.limit(1)
			.for('update', { skipLocked: true });
		if (cursor === undefined) return null;
		if (cursor.status === 'running') {
			// The previous worker crashed or stalled past its claim; close its run before resuming.
			await tx
				.update(googleHealthSyncRun)
				.set({ status: 'failed', finishedAt: new Date(), errorCode: 'stale_claim' })
				.where(
					and(
						eq(googleHealthSyncRun.connectionId, connectionId),
						eq(googleHealthSyncRun.dataType, cursor.dataType),
						eq(googleHealthSyncRun.mode, cursor.mode),
						eq(googleHealthSyncRun.status, 'running')
					)
				);
		}
		const claimId = randomUUID();
		const [claimed] = await tx
			.update(googleHealthSyncCursor)
			.set({
				status: 'running',
				claimId,
				claimExpiresAt: new Date(Date.now() + CLAIM_TTL_MS)
			})
			.where(eq(googleHealthSyncCursor.id, cursor.id))
			.returning();
		const [run] = await tx
			.insert(googleHealthSyncRun)
			.values({
				connectionId,
				dataType: cursor.dataType,
				mode: cursor.mode,
				trigger: cursor.trigger,
				rangeStart: cursor.windowStart,
				rangeEnd: cursor.windowEnd,
				status: 'running'
			})
			.returning({ id: googleHealthSyncRun.id });
		return { connection, cursor: claimed, claimId, runId: run.id };
	});
}

/** Locks the claimed cursor and its connection, failing if either changed hands. */
async function lockOwnership(
	tx: Executor,
	claim: Claim
): Promise<{ connection: ConnectionRow; cursor: CursorRow }> {
	const [connection] = await tx
		.select()
		.from(googleHealthConnection)
		.where(eq(googleHealthConnection.id, claim.connection.id))
		.for('update');
	const [cursor] = await tx
		.select()
		.from(googleHealthSyncCursor)
		.where(eq(googleHealthSyncCursor.id, claim.cursor.id))
		.for('update');
	if (
		connection === undefined ||
		cursor === undefined ||
		connection.generation !== claim.connection.generation ||
		!SYNCABLE_STATUSES.has(connection.status) ||
		cursor.claimId !== claim.claimId ||
		cursor.status !== 'running'
	) {
		throw new LostOwnershipError('Google Health work changed ownership');
	}
	return { connection, cursor };
}

async function finishRun(
	tx: Executor,
	runId: string,
	status: 'succeeded' | 'failed',
	errorCode?: string,
	errorMessage?: string
): Promise<void> {
	await tx
		.update(googleHealthSyncRun)
		.set({
			status,
			finishedAt: new Date(),
			errorCode: errorCode ?? null,
			errorMessage: errorMessage ?? null
		})
		.where(and(eq(googleHealthSyncRun.id, runId), eq(googleHealthSyncRun.status, 'running')));
}

/** Compare-and-set replacement of the stored token envelope and granted scopes. */
async function replaceTokenEnvelope(
	db: Database,
	claim: Claim,
	expected: EncryptedTokenEnvelope,
	replacement: EncryptedTokenEnvelope,
	grantedScopes?: readonly string[]
): Promise<void> {
	const updated = await db
		.update(googleHealthConnection)
		.set({
			...replacement,
			...(grantedScopes === undefined ? {} : { grantedScopes: [...new Set(grantedScopes)] })
		})
		.where(
			and(
				eq(googleHealthConnection.id, claim.connection.id),
				eq(googleHealthConnection.generation, claim.connection.generation),
				inArray(googleHealthConnection.status, [...SYNCABLE_STATUSES]),
				eq(googleHealthConnection.encryptedRefreshToken, expected.encryptedRefreshToken),
				eq(googleHealthConnection.tokenNonce, expected.tokenNonce),
				eq(googleHealthConnection.tokenTag, expected.tokenTag),
				eq(googleHealthConnection.tokenKeyVersion, expected.tokenKeyVersion)
			)
		)
		.returning({ id: googleHealthConnection.id });
	if (updated.length === 0) throw new LostOwnershipError('Google Health token changed');
}

async function obtainAccessToken(deps: SyncDeps, claim: Claim): Promise<AccessToken> {
	const envelope = storedTokenEnvelope(claim.connection);
	if (envelope === null) throw new GoogleHealthError('missing_token_envelope', null, false);
	const { keyring, clientId, clientSecret } = deps.config;
	const userId = claim.connection.userId;
	let current = envelope;
	const rotated = await rotateRefreshTokenEnvelope(current, userId, keyring);
	if (rotated.reencrypted) {
		await replaceTokenEnvelope(deps.db, claim, current, rotated.envelope);
		current = rotated.envelope;
	}
	const tokens = await refreshAccessToken({
		refreshToken: rotated.refreshToken,
		clientId,
		clientSecret,
		grantedScopes: claim.connection.grantedScopes
	});
	const replacement =
		tokens.refreshToken === undefined
			? current
			: await encryptRefreshToken(
					tokens.refreshToken,
					userId,
					keyring.activeKey,
					keyring.activeVersion
				);
	await replaceTokenEnvelope(deps.db, claim, current, replacement, tokens.grantedScopes);
	claim.connection = {
		...claim.connection,
		...replacement,
		grantedScopes: [...new Set(tokens.grantedScopes)]
	};
	return {
		token: tokens.accessToken,
		expiresAt: Date.now() + tokens.expiresIn * 1000,
		grantedScopes: tokens.grantedScopes,
		generation: claim.connection.generation
	};
}

/** Starts a new reconciliation pass for the cursor's next unit of work. */
async function startUnit(db: Database, claim: Claim): Promise<void> {
	await db.transaction(async (tx) => {
		await lockOwnership(tx, claim);
		const [connection] = await tx
			.update(googleHealthConnection)
			.set({ reconciliationEpoch: sql`${googleHealthConnection.reconciliationEpoch} + 1` })
			.where(eq(googleHealthConnection.id, claim.connection.id))
			.returning({ epoch: googleHealthConnection.reconciliationEpoch });
		const [cursor] = await tx
			.update(googleHealthSyncCursor)
			.set({ activeEpoch: connection.epoch, hadMalformed: false })
			.where(eq(googleHealthSyncCursor.id, claim.cursor.id))
			.returning();
		claim.cursor = cursor;
	});
}

async function commitPage(
	db: Database,
	claim: Claim,
	definition: MetricDefinition,
	page: {
		fetched: number;
		points: NormalizedHealthPoint[];
		malformed: number;
		completion: Completion;
		coveredRange: CoveredRange | undefined;
	}
): Promise<void> {
	await db.transaction(async (tx) => {
		const { connection, cursor } = await lockOwnership(tx, claim);
		const epoch = cursor.activeEpoch;
		if (epoch === null) throw new Error('Google Health cursor has no active pass');
		const owner: PointOwner = {
			connectionId: connection.id,
			userId: connection.userId,
			generation: connection.generation
		};
		const syncId = `${cursor.mode}:${connection.generation}:${cursor.dataType}:${epoch}`;
		const applied = await applyPoints(tx, owner, definition.dataType, page.points, {
			syncId,
			seenEpoch: epoch
		});
		const hadMalformed = cursor.hadMalformed || page.malformed > 0;
		const unitEnds = page.completion.nextPageToken === undefined;
		let deleted = 0;
		// Removing unseen records is only safe when the whole unit was read without loss.
		if (unitEnds && !hadMalformed && page.coveredRange !== undefined) {
			const cleanup = await deleteUnseenInRange(
				tx,
				owner,
				definition.dataType,
				page.coveredRange,
				epoch
			);
			deleted = cleanup.deleted;
			for (const date of cleanup.affectedDates) applied.affectedDates.add(date);
		}
		await rebuildDailySummaries(tx, owner, definition.dataType, applied.affectedDates);

		await tx
			.update(googleHealthSyncRun)
			.set({
				pages: sql`${googleHealthSyncRun.pages} + 1`,
				fetched: sql`${googleHealthSyncRun.fetched} + ${page.fetched}`,
				inserted: sql`${googleHealthSyncRun.inserted} + ${applied.inserted}`,
				updated: sql`${googleHealthSyncRun.updated} + ${applied.updated}`,
				deleted: sql`${googleHealthSyncRun.deleted} + ${deleted}`,
				skipped: sql`${googleHealthSyncRun.skipped} + ${applied.skipped + page.malformed}`
			})
			.where(eq(googleHealthSyncRun.id, claim.runId));

		const now = new Date();
		const claimExpiresAt = new Date(Date.now() + CLAIM_TTL_MS);
		let cursorUpdate: Partial<CursorRow>;
		if (page.completion.nextPageToken !== undefined) {
			cursorUpdate = {
				pageToken: page.completion.nextPageToken,
				hadMalformed,
				attempt: 0,
				nextAttemptAt: null,
				claimExpiresAt
			};
		} else if (page.completion.nextWindow !== undefined) {
			cursorUpdate = {
				pageToken: null,
				windowStart: page.completion.nextWindow.start,
				windowEnd: page.completion.nextWindow.end,
				activeEpoch: null,
				hadMalformed: false,
				attempt: 0,
				nextAttemptAt: null,
				claimExpiresAt
			};
		} else {
			const pendingWindow =
				cursor.pendingWindowStart !== null && cursor.pendingWindowEnd !== null
					? { start: cursor.pendingWindowStart, end: cursor.pendingWindowEnd }
					: null;
			const promotesPending =
				cursor.mode === 'incremental' && (cursor.pendingUnbounded || pendingWindow !== null);
			cursorUpdate = {
				status: promotesPending ? 'queued' : 'complete',
				...(promotesPending
					? {
							trigger: cursor.pendingTrigger ?? 'webhook',
							windowStart: pendingWindow?.start ?? null,
							windowEnd: pendingWindow?.end ?? null
						}
					: {}),
				pageToken: null,
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
			await finishRun(
				tx,
				claim.runId,
				'succeeded',
				hadMalformed ? 'warning_skipped_records' : undefined,
				hadMalformed ? 'Some Google Health records could not be imported' : undefined
			);
		}
		const [updatedCursor] = await tx
			.update(googleHealthSyncCursor)
			.set(cursorUpdate)
			.where(eq(googleHealthSyncCursor.id, cursor.id))
			.returning();
		claim.cursor = updatedCursor;

		const completed = await countFinishedBackfills(tx, connection.id, connection.generation);
		await tx
			.update(googleHealthConnection)
			.set({
				status: completed >= connection.backfillTotalTypes ? 'active' : 'backfilling',
				backfillCompletedTypes: completed,
				lastAttemptAt: now,
				...(page.completion.finish ? { lastSuccessfulSyncAt: now } : {}),
				lastErrorCode: null,
				lastErrorMessage: null,
				nextRetryAt: null
			})
			.where(eq(googleHealthConnection.id, connection.id));
	});
}

/** Leaves a mid-unit cursor queued so the next job resumes from its page token. */
async function yieldCursor(db: Database, claim: Claim): Promise<void> {
	await db.transaction(async (tx) => {
		await lockOwnership(tx, claim);
		await tx
			.update(googleHealthSyncCursor)
			.set({ status: 'queued', claimId: null, claimExpiresAt: null })
			.where(eq(googleHealthSyncCursor.id, claim.cursor.id));
		await finishRun(tx, claim.runId, 'succeeded');
	});
}

async function scheduleRetry(db: Database, claim: Claim, errorCode: string): Promise<void> {
	await db.transaction(async (tx) => {
		const { cursor } = await lockOwnership(tx, claim);
		const retryAt = new Date(Date.now() + computeRetryDelayMs(cursor.attempt));
		await tx
			.update(googleHealthSyncCursor)
			.set({
				status: 'retry',
				attempt: cursor.attempt + 1,
				nextAttemptAt: retryAt,
				claimId: null,
				claimExpiresAt: null
			})
			.where(eq(googleHealthSyncCursor.id, cursor.id));
		await tx
			.update(googleHealthConnection)
			.set({
				status: 'delayed',
				lastAttemptAt: new Date(),
				lastErrorCode: safeErrorCode(errorCode),
				lastErrorMessage: 'Google Health is temporarily unavailable',
				nextRetryAt: retryAt
			})
			.where(eq(googleHealthConnection.id, claim.connection.id));
		await finishRun(
			tx,
			claim.runId,
			'failed',
			safeErrorCode(errorCode),
			'Google Health is temporarily unavailable'
		);
	});
}

/**
 * Stops a cursor after a non-retryable error. Authorization failures require the user to review
 * access; other failures wait for the next manual or daily reconciliation.
 */
async function failCursor(
	db: Database,
	claim: Claim,
	errorCode: string,
	actionRequired: boolean
): Promise<void> {
	await db.transaction(async (tx) => {
		const { connection, cursor } = await lockOwnership(tx, claim);
		const code = safeErrorCode(errorCode);
		const message = actionRequired
			? 'Google Health access needs to be renewed'
			: 'Google Health synchronization failed';
		await tx
			.update(googleHealthSyncCursor)
			.set({ status: 'failed', attempt: cursor.attempt + 1, claimId: null, claimExpiresAt: null })
			.where(eq(googleHealthSyncCursor.id, cursor.id));
		// A failed metric counts as finished so it cannot hold the import in progress forever; the
		// failure is recorded on its sync run and the next reconciliation revives the cursor.
		const completed = await countFinishedBackfills(tx, connection.id, connection.generation);
		await tx
			.update(googleHealthConnection)
			.set({
				status: actionRequired
					? 'action_required'
					: completed >= connection.backfillTotalTypes
						? 'active'
						: 'backfilling',
				backfillCompletedTypes: completed,
				lastAttemptAt: new Date(),
				lastErrorCode: code,
				lastErrorMessage: message,
				nextRetryAt: null
			})
			.where(eq(googleHealthConnection.id, connection.id));
		await finishRun(tx, claim.runId, 'failed', code, message);
	});
}

type CursorOutcome = 'next' | 'yield' | 'stop';

// PostgreSQL serialization failure and deadlock: safe to retry, never a reason to give up.
const TRANSIENT_DATABASE_CODES = new Set(['40001', '40P01']);

function isTransientDatabaseError(error: unknown): boolean {
	for (let current = error, depth = 0; current instanceof Error && depth < 4; depth += 1) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === 'string' && TRANSIENT_DATABASE_CODES.has(code)) return true;
		current = current.cause;
	}
	return false;
}

async function processCursor(
	deps: SyncDeps,
	claim: Claim,
	deadline: number,
	access: { current: AccessToken | null }
): Promise<CursorOutcome> {
	const definition = getMetricDefinition(claim.cursor.dataType);
	try {
		if (definition === null || !claim.connection.grantedScopes.includes(definition.scope)) {
			await failCursor(deps.db, claim, 'scope_not_granted', true);
			return 'stop';
		}
		while (true) {
			if (
				access.current === null ||
				// A reconnect between claims may have switched to another Google account.
				access.current.generation !== claim.connection.generation ||
				access.current.expiresAt - ACCESS_TOKEN_MARGIN_MS < Date.now()
			) {
				access.current = await obtainAccessToken(deps, claim);
			}
			if (!access.current.grantedScopes.includes(definition.scope)) {
				await failCursor(deps.db, claim, 'scope_not_granted', true);
				return 'stop';
			}
			if (definition.readMode === 'rollUp') {
				throw new GoogleHealthError('unsupported_read_mode', null, false);
			}
			if (claim.cursor.activeEpoch === null) await startUnit(deps.db, claim);
			const cursor = claim.cursor;

			let rollupRange: { start: string; end: string } | undefined;
			if (definition.readMode === 'dailyRollUp') {
				const terminal = currentExclusiveCivilDate();
				const start = cursor.windowStart ?? FIRST_ROLLUP_DATE;
				if (!isValidDate(start) || start >= terminal) {
					await commitPage(deps.db, claim, definition, {
						fetched: 0,
						points: [],
						malformed: 0,
						completion: { finish: true },
						coveredRange: undefined
					});
					return 'next';
				}
				rollupRange = { start, end: minDate(cursor.windowEnd ?? addDays(start, 14), terminal) };
			}
			const filter = timeFilterFor(cursor, definition);
			const page = await fetchGoogleHealthDataPage({
				accessToken: access.current.token,
				dataType: definition.dataType,
				readMode: definition.readMode,
				pageSize: pageSizeFor(definition.dataType),
				pageToken: cursor.pageToken ?? undefined,
				filter,
				range: rollupRange
			});
			const points: NormalizedHealthPoint[] = [];
			let malformed = 0;
			let firstProblem = '';
			for (const raw of page.points) {
				try {
					points.push(normalizeGooglePoint(definition, raw));
				} catch (error) {
					malformed += 1;
					firstProblem ||= error instanceof Error ? error.message : String(error);
				}
			}
			if (malformed > 0) {
				// Only the reason is logged; payloads hold health data.
				console.warn(
					`[google-health] skipped ${malformed} ${definition.dataType} record(s): ${firstProblem}`
				);
			}
			const completion = completionFor(page.nextPageToken, rollupRange);
			await commitPage(deps.db, claim, definition, {
				fetched: page.points.length,
				points,
				malformed,
				completion,
				coveredRange: coveredRangeFor(cursor, definition, filter, rollupRange)
			});
			if (completion.finish) return 'next';
			// Checked after a committed page so every job makes progress, however short its budget.
			if (Date.now() >= deadline) {
				await yieldCursor(deps.db, claim);
				return 'yield';
			}
		}
	} catch (error) {
		if (error instanceof LostOwnershipError) return 'stop';
		try {
			if (error instanceof GoogleHealthError && error.retryable) {
				await scheduleRetry(deps.db, claim, error.code);
				return 'stop';
			}
			if (isTransientDatabaseError(error)) {
				await scheduleRetry(deps.db, claim, 'database_conflict');
				return 'stop';
			}
			const actionRequired =
				error instanceof GoogleHealthError &&
				(error.code === 'invalid_grant' || error.code === 'missing_token_envelope');
			await failCursor(
				deps.db,
				claim,
				error instanceof GoogleHealthError ? error.code : 'sync_error',
				actionRequired
			);
			return actionRequired ? 'stop' : 'next';
		} catch (failure) {
			if (failure instanceof LostOwnershipError) return 'stop';
			throw failure;
		}
	}
}

/**
 * Processes queued work for one connection, one cursor at a time, until nothing is due or the
 * time budget runs out. Returns `true` when work remains and another job should continue.
 */
export async function syncConnection(deps: SyncDeps, connectionId: string): Promise<boolean> {
	const deadline = Date.now() + (deps.budgetMs ?? DEFAULT_SYNC_BUDGET_MS);
	const access: { current: AccessToken | null } = { current: null };
	while (Date.now() < deadline) {
		const claim = await claimNextCursor(deps.db, connectionId);
		if (claim === null) return false;
		const outcome = await processCursor(deps, claim, deadline, access);
		if (outcome === 'stop') return false;
		if (outcome === 'yield') return true;
	}
	return true;
}

export type { SyncTrigger };
