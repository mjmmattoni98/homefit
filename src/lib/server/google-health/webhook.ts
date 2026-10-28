import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Database, Executor } from '../db/types';
import { googleHealthConnection, googleHealthWebhookDelivery } from '../db/schema';
import { queueIncrementalWindow } from './cursors';
import { sha256Base64Url } from './normalize';
import { getMetricDefinition } from './registry';
import { clearNamedTombstones, deleteNamedPoints } from './store';
import { SYNCABLE_STATUSES } from './types';
import {
	parseNotifications,
	recordNameCandidates,
	type NormalizedNotification
} from './webhook-parse';
import { verifyGoogleHealthSignature } from './webhook-signature';

const PUBLIC_KEYSET_URL =
	'https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json';
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
export const MAX_WEBHOOK_SIGNATURE_LENGTH = 4096;
const MAX_WEBHOOK_AUTHORIZATION_BYTES = 4096;
const WEBHOOK_BODY_TIMEOUT_MS = 5_000;
const MAX_KEYSET_BYTES = 64 * 1024;
const KEYSET_TIMEOUT_MS = 5_000;
const KEYSET_CACHE_MS = 10 * 60 * 1000;
// A delivery whose job never started within this grace period lost its job (e.g. enqueueing failed).
const UNSTARTED_DELIVERY_GRACE_MS = 5 * 60 * 1000;
// Longer than the webhook job's longest retry delay (one hour), so only exhausted jobs qualify.
const ABANDONED_DELIVERY_AFTER_MS = 2 * 60 * 60 * 1000;

type RawBodyResult =
	| { kind: 'ok'; value: string }
	| { kind: 'invalid' }
	| { kind: 'too_large' }
	| { kind: 'timed_out' };

/** Thrown while Google's signing keys cannot be fetched; the delivery is retried later. */
export class KeysetUnavailableError extends Error {
	constructor() {
		super('Google Health webhook keyset unavailable');
	}
}

let cachedKeyset: { value: unknown; expiresAt: number } | null = null;
let keysetRequest: Promise<unknown | null> | null = null;

/** Constant-time comparison of the received `Authorization` header with the configured value. */
export function webhookAuthorizationMatches(received: string | null, expected: string): boolean {
	if (received === null) return false;
	const encoder = new TextEncoder();
	const actualBytes = encoder.encode(received);
	const expectedBytes = encoder.encode(expected);
	if (
		actualBytes.byteLength === 0 ||
		actualBytes.byteLength > MAX_WEBHOOK_AUTHORIZATION_BYTES ||
		actualBytes.byteLength !== expectedBytes.byteLength
	) {
		return false;
	}
	let difference = 0;
	for (let index = 0; index < actualBytes.byteLength; index += 1) {
		difference |= actualBytes[index] ^ expectedBytes[index];
	}
	return difference === 0;
}

/** Reads a request body with a size limit and a total read deadline. */
export async function readBoundedRawBody(request: Request): Promise<RawBodyResult> {
	const contentLength = request.headers.get('content-length');
	if (contentLength !== null) {
		if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) return { kind: 'invalid' };
		if (Number(contentLength) > MAX_WEBHOOK_BODY_BYTES) return { kind: 'too_large' };
	}
	if (request.body === null) return { kind: 'invalid' };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let complete = false;
	let timedOut = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			timedOut = true;
			reject(new Error('Google Health webhook body timed out'));
		}, WEBHOOK_BODY_TIMEOUT_MS);
	});
	try {
		while (true) {
			const result = await Promise.race([reader.read(), timeout]);
			if (result.done) {
				complete = true;
				break;
			}
			total += result.value.byteLength;
			if (total > MAX_WEBHOOK_BODY_BYTES) return { kind: 'too_large' };
			chunks.push(result.value);
		}
	} catch {
		return { kind: timedOut ? 'timed_out' : 'invalid' };
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
		if (complete) reader.releaseLock();
		else void reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return {
			kind: 'ok',
			value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
		};
	} catch {
		return { kind: 'invalid' };
	}
}

async function fetchPublicKeyset(): Promise<unknown | null> {
	const controller = new AbortController();
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			controller.abort();
			reject(new Error('Google Health keyset request timed out'));
		}, KEYSET_TIMEOUT_MS);
	});
	try {
		const response = await Promise.race([
			fetch(PUBLIC_KEYSET_URL, {
				method: 'GET',
				headers: { Accept: 'application/json' },
				signal: controller.signal
			}),
			timeout
		]);
		if (!response.ok || response.body === null) return null;
		const contentLength = response.headers.get('content-length');
		if (contentLength !== null) {
			if (!/^(0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > MAX_KEYSET_BYTES) {
				return null;
			}
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		let complete = false;
		try {
			while (true) {
				const result = await Promise.race([reader.read(), timeout]);
				if (result.done) {
					complete = true;
					break;
				}
				total += result.value.byteLength;
				if (total > MAX_KEYSET_BYTES) return null;
				chunks.push(result.value);
			}
		} finally {
			if (complete) reader.releaseLock();
			else void reader.cancel().catch(() => undefined);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return JSON.parse(text);
	} catch {
		return null;
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

async function getPublicKeyset(
	forceRefresh: boolean,
	staleKeyset?: unknown
): Promise<unknown | null> {
	const now = Date.now();
	if (
		forceRefresh &&
		staleKeyset !== undefined &&
		cachedKeyset !== null &&
		cachedKeyset.expiresAt > now &&
		cachedKeyset.value !== staleKeyset
	) {
		return cachedKeyset.value;
	}
	if (!forceRefresh && cachedKeyset !== null && cachedKeyset.expiresAt > now) {
		return cachedKeyset.value;
	}
	const request = keysetRequest ?? fetchPublicKeyset();
	keysetRequest = request;
	let value: unknown | null;
	try {
		value = await request;
	} finally {
		if (keysetRequest === request) keysetRequest = null;
	}
	if (value === null) return null;
	cachedKeyset = { value, expiresAt: now + KEYSET_CACHE_MS };
	return value;
}

/**
 * Durably records an authenticated webhook delivery before its signature is verified, so the
 * request can be acknowledged quickly. Duplicate deliveries map to the same row.
 */
export async function acceptDelivery(
	db: Database,
	rawBody: string,
	signature: string
): Promise<{ deliveryId: string; created: boolean }> {
	if (
		new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BODY_BYTES ||
		signature.length === 0 ||
		signature.length > MAX_WEBHOOK_SIGNATURE_LENGTH
	) {
		throw new Error('invalid Google Health webhook delivery');
	}
	const deliveryDigest = sha256Base64Url(`${signature}\n${rawBody}`);
	const [created] = await db
		.insert(googleHealthWebhookDelivery)
		.values({ deliveryDigest, status: 'queued', rawBody, signature })
		.onConflictDoNothing({ target: googleHealthWebhookDelivery.deliveryDigest })
		.returning({ id: googleHealthWebhookDelivery.id });
	if (created !== undefined) return { deliveryId: created.id, created: true };
	const [existing] = await db
		.select({ id: googleHealthWebhookDelivery.id })
		.from(googleHealthWebhookDelivery)
		.where(eq(googleHealthWebhookDelivery.deliveryDigest, deliveryDigest));
	return { deliveryId: existing.id, created: false };
}

async function verifyWithFreshKeys(rawBody: string, signature: string): Promise<boolean> {
	const keyset = await getPublicKeyset(false);
	if (keyset === null) throw new KeysetUnavailableError();
	if (await verifyGoogleHealthSignature(rawBody, signature, keyset)) return true;
	// Google rotates signing keys; refresh once before rejecting the delivery.
	const refreshed = await getPublicKeyset(true, keyset);
	if (refreshed === null) throw new KeysetUnavailableError();
	return refreshed !== keyset && (await verifyGoogleHealthSignature(rawBody, signature, refreshed));
}

async function rejectDelivery(db: Database, deliveryId: string, errorCode: string): Promise<void> {
	await db
		.update(googleHealthWebhookDelivery)
		.set({ status: 'rejected', rawBody: null, signature: null, lastErrorCode: errorCode })
		.where(eq(googleHealthWebhookDelivery.id, deliveryId));
}

/**
 * Verifies a queued delivery's signature and applies its notifications. Returns the connections
 * that received new work. Throws {@link KeysetUnavailableError} when it should be retried.
 */
export async function processDelivery(db: Database, deliveryId: string): Promise<string[]> {
	const [delivery] = await db
		.select()
		.from(googleHealthWebhookDelivery)
		.where(eq(googleHealthWebhookDelivery.id, deliveryId));
	if (
		delivery === undefined ||
		delivery.status !== 'queued' ||
		delivery.rawBody === null ||
		delivery.signature === null
	) {
		return [];
	}
	await db
		.update(googleHealthWebhookDelivery)
		.set({ attempt: sql`${googleHealthWebhookDelivery.attempt} + 1` })
		.where(eq(googleHealthWebhookDelivery.id, deliveryId));
	if (!(await verifyWithFreshKeys(delivery.rawBody, delivery.signature))) {
		await rejectDelivery(db, deliveryId, 'invalid_signature');
		return [];
	}
	let value: unknown;
	try {
		value = JSON.parse(delivery.rawBody);
	} catch {
		value = undefined;
	}
	const notifications = parseNotifications(value);
	if (notifications === null) {
		await rejectDelivery(db, deliveryId, 'invalid_payload');
		return [];
	}
	return await db.transaction(async (tx) => {
		const [current] = await tx
			.select({ status: googleHealthWebhookDelivery.status })
			.from(googleHealthWebhookDelivery)
			.where(eq(googleHealthWebhookDelivery.id, deliveryId))
			.for('update');
		if (current?.status !== 'queued') return [];
		const affected = await applyNotifications(tx, notifications);
		await tx
			.update(googleHealthWebhookDelivery)
			.set({ status: 'complete', rawBody: null, signature: null, lastErrorCode: null })
			.where(eq(googleHealthWebhookDelivery.id, deliveryId));
		return affected;
	});
}

/**
 * Maps verified notifications to their connection by Google health user ID. Identifiable
 * deletions are applied directly; everything else queues an incremental reconciliation window.
 */
async function applyNotifications(
	tx: Executor,
	notifications: readonly NormalizedNotification[]
): Promise<string[]> {
	const affected = new Set<string>();
	for (const notification of notifications) {
		const connections = await tx
			.select()
			.from(googleHealthConnection)
			.where(eq(googleHealthConnection.healthUserId, notification.healthUserId))
			.limit(2)
			.for('update');
		// An unknown or ambiguous Google account is acknowledged without work.
		if (connections.length !== 1) continue;
		const [connection] = connections;
		const definition = getMetricDefinition(notification.dataType);
		if (
			definition === null ||
			!definition.webhook ||
			!connection.grantedScopes.includes(definition.scope) ||
			!SYNCABLE_STATUSES.has(connection.status)
		) {
			continue;
		}
		const owner = {
			connectionId: connection.id,
			userId: connection.userId,
			generation: connection.generation,
			reconciliationEpoch: connection.reconciliationEpoch
		};
		const names =
			notification.recordId === undefined
				? []
				: recordNameCandidates(
						notification.healthUserId,
						notification.dataType,
						notification.recordId
					);
		if (notification.operation === 'UPSERT' && names.length > 0) {
			await clearNamedTombstones(tx, owner, notification.dataType, names);
		}
		const deleted =
			notification.operation === 'DELETE' && names.length > 0
				? await deleteNamedPoints(tx, owner, notification.dataType, names)
				: false;
		if (deleted) {
			// The deletion brings HomeFit up to date with Google without a reconciliation, so it
			// counts as a sync; open views refresh when this time advances.
			await tx
				.update(googleHealthConnection)
				.set({ lastSuccessfulSyncAt: new Date() })
				.where(eq(googleHealthConnection.id, connection.id));
			continue;
		}
		await queueIncrementalWindow(
			tx,
			{
				connectionId: connection.id,
				generation: connection.generation,
				grantedScopes: connection.grantedScopes
			},
			notification.dataType,
			{ start: notification.windowStart, end: notification.windowEnd },
			'webhook'
		);
		affected.add(connection.id);
	}
	return [...affected];
}

/**
 * Finds queued deliveries that no job will process anymore: never started, or idle for longer
 * than the job's retry delays after its retries ran out. Google has already received a `204`, so
 * these must be resumed here. Each returned delivery is touched so the next pass skips it until
 * the new job has had time to run.
 */
export async function rescheduleStrandedDeliveries(db: Database, limit = 100): Promise<string[]> {
	const now = Date.now();
	const stranded = db
		.select({ id: googleHealthWebhookDelivery.id })
		.from(googleHealthWebhookDelivery)
		.where(
			and(
				eq(googleHealthWebhookDelivery.status, 'queued'),
				or(
					and(
						eq(googleHealthWebhookDelivery.attempt, 0),
						lt(googleHealthWebhookDelivery.updatedAt, new Date(now - UNSTARTED_DELIVERY_GRACE_MS))
					),
					lt(googleHealthWebhookDelivery.updatedAt, new Date(now - ABANDONED_DELIVERY_AFTER_MS))
				)
			)
		)
		.orderBy(asc(googleHealthWebhookDelivery.updatedAt))
		.limit(limit);
	const rows = await db
		.update(googleHealthWebhookDelivery)
		.set({ updatedAt: new Date(now) })
		.where(inArray(googleHealthWebhookDelivery.id, stranded))
		.returning({ id: googleHealthWebhookDelivery.id });
	return rows.map((row) => row.id);
}

/** Marks deliveries that could not be verified within the retry horizon as rejected. */
export async function expireStaleDeliveries(db: Database, olderThan: Date): Promise<number> {
	const expired = await db
		.update(googleHealthWebhookDelivery)
		.set({
			status: 'rejected',
			rawBody: null,
			signature: null,
			lastErrorCode: 'delivery_retention_expired'
		})
		.where(
			and(
				eq(googleHealthWebhookDelivery.status, 'queued'),
				sql`${googleHealthWebhookDelivery.acceptedAt} < ${olderThan}`
			)
		)
		.returning({ id: googleHealthWebhookDelivery.id });
	return expired.length;
}
