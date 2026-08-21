/// <reference types="vite/client" />

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import { readBoundedRawBody } from '../http';
import schema from '../schema';
import { canonicalJson, sha256Base64Url } from './normalize';
import { getMetricDefinition } from './registry';

const modules = import.meta.glob('/src/convex/**/*.*s');
const AUTHORIZATION = 'Bearer webhook-secret-with-high-entropy';
const KEY_ID = 0x0102_0304;
const KEYSET_URL = 'https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json';
const TYPE_URL = 'type.googleapis.com/google.crypto.tink.EcdsaPublicKey';

function backend() {
	return convexTest({ schema, modules, transactionLimits: true });
}

function fromBase64Url(value: string): Uint8Array {
	const padding = '='.repeat((4 - (value.length % 4)) % 4);
	const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64(value: Uint8Array): string {
	let binary = '';
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function field(fieldNumber: number, value: Uint8Array): number[] {
	if (value.byteLength > 127) throw new Error('Fixture field is too long');
	return [(fieldNumber << 3) | 2, value.byteLength, ...value];
}

function trimInteger(value: Uint8Array): Uint8Array {
	let first = 0;
	while (first < value.byteLength - 1 && value[first] === 0) first += 1;
	const trimmed = value.slice(first);
	return (trimmed[0] & 0x80) === 0 ? trimmed : Uint8Array.from([0, ...trimmed]);
}

function p1363ToDer(signature: Uint8Array): Uint8Array {
	const r = trimInteger(signature.slice(0, 32));
	const s = trimInteger(signature.slice(32));
	return Uint8Array.from([
		0x30,
		2 + r.byteLength + 2 + s.byteLength,
		0x02,
		r.byteLength,
		...r,
		0x02,
		s.byteLength,
		...s
	]);
}

async function signer() {
	const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify'
	]);
	if (!('privateKey' in keys)) throw new Error('Expected an ECDSA key pair');
	const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
	if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
		throw new Error('Expected P-256 coordinates');
	}
	const keyset = {
		primaryKeyId: KEY_ID,
		key: [
			{
				keyData: {
					typeUrl: TYPE_URL,
					value: toBase64(
						Uint8Array.from([
							...field(3, Uint8Array.from([0, ...fromBase64Url(jwk.x)])),
							...field(4, Uint8Array.from([0, ...fromBase64Url(jwk.y)]))
						])
					),
					keyMaterialType: 'ASYMMETRIC_PUBLIC'
				},
				status: 'ENABLED',
				keyId: KEY_ID,
				outputPrefixType: 'TINK'
			}
		]
	};

	return {
		keyset,
		sign: async (rawBody: string) => {
			const p1363 = new Uint8Array(
				await crypto.subtle.sign(
					{ name: 'ECDSA', hash: 'SHA-256' },
					keys.privateKey,
					new TextEncoder().encode(rawBody)
				)
			);
			const prefix = new Uint8Array(5);
			prefix[0] = 1;
			new DataView(prefix.buffer).setUint32(1, KEY_ID, false);
			return toBase64(Uint8Array.from([...prefix, ...p1363ToDer(p1363)]));
		}
	};
}

function physicalInterval(startTime: string, endTime: string) {
	return { physicalTimeInterval: { startTime, endTime } };
}

function civilInterval(startTime: string, endTime: string) {
	return { civilIso8601TimeInterval: { startTime, endTime } };
}

function documentedCivilInterval() {
	return {
		civilDateTimeInterval: {
			startDateTime: {
				date: { year: 2026, month: 8, day: 14 },
				time: { hours: 10 }
			},
			endDateTime: {
				date: { year: 2026, month: 8, day: 14 },
				time: { hours: 11 }
			}
		},
		civilIso8601TimeInterval: {
			startTime: '2026-08-14T10:00:00',
			endTime: '2026-08-14T11:00:00'
		}
	};
}

function notification(args: {
	healthUserId?: string;
	dataType?: string;
	operation?: 'UPSERT' | 'DELETE';
	intervals?: unknown[];
	recordId?: string;
}) {
	return {
		data: {
			version: '1',
			clientProvidedSubscriptionName: 'homefit-health',
			healthUserId: args.healthUserId ?? 'health-user-a',
			operation: args.operation ?? 'UPSERT',
			dataType: args.dataType ?? 'steps',
			intervals: args.intervals ?? [
				physicalInterval('2026-08-14T10:00:00Z', '2026-08-14T11:00:00Z')
			],
			...(args.recordId === undefined ? {} : { recordId: args.recordId })
		}
	};
}

async function seedConnection(t: ReturnType<typeof backend>, healthUserId = 'health-user-a') {
	return await t.run(async (ctx) =>
		ctx.db.insert('googleHealthConnections', {
			userId: 'clerk|user-a',
			healthUserId,
			status: 'active',
			grantedScopes: [
				getMetricDefinition('steps')?.scope ??
					'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
				getMetricDefinition('exercise')?.scope ??
					'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
				getMetricDefinition('sleep')?.scope ??
					'https://www.googleapis.com/auth/googlehealth.sleep.readonly'
			],
			generation: 1,
			backfillTotalTypes: 1,
			backfillCompletedTypes: 1
		})
	);
}

async function postSigned(
	t: ReturnType<typeof backend>,
	fixture: Awaited<ReturnType<typeof signer>>,
	value: unknown,
	authorization = AUTHORIZATION
): Promise<Response> {
	const rawBody = JSON.stringify(value);
	return await t.fetch('/google-health/webhook', {
		method: 'POST',
		headers: {
			Authorization: authorization,
			'Content-Type': 'application/json',
			'GOOGLE-HEALTH-API-SIGNATURE': await fixture.sign(rawBody)
		},
		body: rawBody
	});
}

async function pumpWebhookDelivery(
	t: ReturnType<typeof backend>,
	terminalStatuses: readonly string[] = ['complete', 'rejected'],
	maximumTurns = 220
) {
	for (let turn = 0; turn < maximumTurns; turn += 1) {
		vi.advanceTimersByTime(0);
		await t.finishInProgressScheduledFunctions();
		const delivery = await t.run(async (ctx) =>
			ctx.db.query('googleHealthWebhookDeliveries').order('desc').first()
		);
		if (delivery !== null && terminalStatuses.includes(delivery.status)) return delivery;
	}
	throw new Error('Google Health webhook delivery did not reach a terminal status');
}

describe('Google Health webhook HTTP contract', () => {
	let fixture: Awaited<ReturnType<typeof signer>>;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.stubEnv('GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION', AUTHORIZATION);
		fixture = await signer();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input) !== KEYSET_URL) throw new Error('Unexpected webhook test URL');
				return new Response(JSON.stringify(fixture.keyset), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			})
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('returns the exact subscriber-create statuses for authorized and unauthorized verification', async () => {
		const t = backend();
		const authorized = await t.fetch('/google-health/webhook', {
			method: 'POST',
			headers: { Authorization: AUTHORIZATION, 'Content-Type': 'application/json' },
			body: '{"type":"verification"}'
		});
		const unauthorized = await t.fetch('/google-health/webhook', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{"type":"verification"}'
		});

		expect(authorized.status).toBe(201);
		expect(await authorized.text()).toBe('');
		expect(unauthorized.status).toBe(401);
	});

	it('durably acknowledges before signature verification and queues verified work asynchronously', async () => {
		const t = backend();
		const connectionId = await seedConnection(t);
		const response = await postSigned(t, fixture, notification({}));
		const accepted = await t.run(async (ctx) => ({
			delivery: await ctx.db.query('googleHealthWebhookDeliveries').unique(),
			cursors: await ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
					q.eq('connectionId', connectionId).eq('dataType', 'steps').eq('mode', 'incremental')
				)
				.take(2),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(10)
		}));

		expect(response.status).toBe(204);
		expect(await response.text()).toBe('');
		expect(fetch).not.toHaveBeenCalled();
		expect(accepted.delivery).toMatchObject({ status: 'queued', attempt: 0 });
		expect(accepted.delivery).not.toHaveProperty('authorization');
		expect(accepted.cursors).toEqual([]);
		expect(accepted.scheduled.map((job) => job.name)).toEqual([
			'googleHealth/webhook:dispatchDelivery'
		]);

		const delivery = await pumpWebhookDelivery(t);
		const stored = await t.run(async (ctx) =>
			ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
					q.eq('connectionId', connectionId).eq('dataType', 'steps').eq('mode', 'incremental')
				)
				.take(2)
		);
		expect(delivery).toMatchObject({ status: 'complete', nextNotificationIndex: 1 });
		expect(delivery).not.toHaveProperty('rawBody');
		expect(delivery).not.toHaveProperty('signature');
		expect(stored).toMatchObject([
			{
				status: 'queued',
				windowStart: '2026-08-14T10:00:00.000000000Z',
				windowEnd: '2026-08-14T11:00:00.000000000Z',
				generation: 1
			}
		]);
	});

	it('rejects a signed payload with unknown fields before scheduling', async () => {
		const t = backend();
		await seedConnection(t);
		const value = notification({});
		const response = await postSigned(t, fixture, { ...value, unexpected: true });
		const delivery = await pumpWebhookDelivery(t);
		const cursors = await t.run(async (ctx) => ctx.db.query('googleHealthSyncCursors').take(1));

		expect(response.status).toBe(204);
		expect(delivery).toMatchObject({ status: 'rejected', lastErrorCode: 'invalid_payload' });
		expect(cursors).toEqual([]);
	});

	it('fails closed for wrong authorization, changed bodies, and unavailable signing keys', async () => {
		const t = backend();
		await seedConnection(t);
		const wrongAuthorization = await postSigned(
			t,
			fixture,
			notification({}),
			`${AUTHORIZATION}-wrong`
		);
		const originalBody = JSON.stringify(notification({}));
		const changedBody = `${originalBody} `;
		const changed = await t.fetch('/google-health/webhook', {
			method: 'POST',
			headers: {
				Authorization: AUTHORIZATION,
				'GOOGLE-HEALTH-API-SIGNATURE': await fixture.sign(originalBody)
			},
			body: changedBody
		});
		const rejected = await pumpWebhookDelivery(t);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 503 }))
		);
		const unavailableFixture = await signer();
		const unavailableKeyset = await postSigned(t, unavailableFixture, notification({}));
		const retrying = await pumpWebhookDelivery(t, ['retry']);
		const cursors = await t.run(async (ctx) => ctx.db.query('googleHealthSyncCursors').take(1));

		expect([wrongAuthorization.status, changed.status, unavailableKeyset.status]).toEqual([
			401, 204, 204
		]);
		expect(rejected).toMatchObject({ status: 'rejected', lastErrorCode: 'invalid_signature' });
		expect(retrying).toMatchObject({ status: 'retry', lastErrorCode: 'keyset_unavailable' });
		expect(retrying).toHaveProperty('rawBody');
		expect(retrying).toHaveProperty('signature');
		expect(cursors).toEqual([]);
	});

	it('caches a verified keyset and refreshes only when a signature no longer matches', async () => {
		const t = backend();
		const first = await postSigned(
			t,
			fixture,
			notification({ healthUserId: 'unknown-health-user' })
		);
		const second = await postSigned(
			t,
			fixture,
			notification({ healthUserId: 'unknown-health-user' })
		);
		await pumpWebhookDelivery(t);

		expect([first.status, second.status]).toEqual([204, 204]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('rejects an oversized body and a non-exact verification challenge', async () => {
		const t = backend();
		const tooLarge = await t.fetch('/google-health/webhook', {
			method: 'POST',
			headers: { Authorization: AUTHORIZATION },
			body: 'x'.repeat(256 * 1024 + 1)
		});
		const extraVerificationField = await t.fetch('/google-health/webhook', {
			method: 'POST',
			headers: { Authorization: AUTHORIZATION },
			body: '{"type":"verification","extra":true}'
		});
		const unauthorizedOversized = await t.fetch('/google-health/webhook', {
			method: 'POST',
			headers: { Authorization: `${AUTHORIZATION}-wrong` },
			body: 'x'.repeat(256 * 1024 + 1)
		});

		expect([tooLarge.status, extraVerificationField.status]).toEqual([413, 400]);
		expect(unauthorizedOversized.status).toBe(401);
	});

	it('cancels a body stream that exceeds the total read deadline', async () => {
		const cancelled = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => undefined),
			cancel: () => {
				cancelled();
			}
		});
		const requestInit = { method: 'POST', body: stream, duplex: 'half' };
		const reading = readBoundedRawBody(
			new Request('https://homefit.example/google-health/webhook', requestInit)
		);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(await reading).toEqual({ kind: 'timed_out' });
		await Promise.resolve();
		expect(cancelled).toHaveBeenCalledOnce();
	});

	it('recovers a verifying delivery when its scheduled action is lost', async () => {
		const t = backend();
		const response = await postSigned(t, fixture, notification({}));
		const deliveryId = await t.run(
			async (ctx) => (await ctx.db.query('googleHealthWebhookDeliveries').unique())?._id
		);
		if (deliveryId === undefined) throw new Error('expected accepted delivery');
		expect(await t.mutation(internal.googleHealth.webhook.dispatchDelivery, { deliveryId })).toBe(
			true
		);
		const leased = await t.run(async (ctx) =>
			ctx.db.get('googleHealthWebhookDeliveries', deliveryId)
		);
		if (leased?.leaseExpiresAt === undefined) throw new Error('expected delivery lease');
		vi.setSystemTime(leased.leaseExpiresAt);
		expect(
			await t.mutation(internal.googleHealth.webhook.recoverDeliveryLease, {
				deliveryId,
				leaseVersion: leased.leaseVersion,
				leaseExpiresAt: leased.leaseExpiresAt
			})
		).toBe(true);
		const recovered = await t.run(async (ctx) =>
			ctx.db.get('googleHealthWebhookDeliveries', deliveryId)
		);

		expect(response.status).toBe(204);
		expect(recovered).toMatchObject({
			status: 'queued',
			lastErrorCode: 'verification_lease_expired'
		});
		expect(recovered).toHaveProperty('rawBody');
		expect(recovered).toHaveProperty('signature');
	});
});

describe('Google Health webhook queue coalescing', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv('GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION', AUTHORIZATION);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('promotes a notification received during a running cursor after that run finishes', async () => {
		const fixture = await signer();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(fixture.keyset)))
		);
		const t = backend();
		const connectionId = await seedConnection(t);
		const { cursorId, runId } = await t.run(async (ctx) => {
			const cursorId = await ctx.db.insert('googleHealthSyncCursors', {
				connectionId,
				userId: 'clerk|user-a',
				dataType: 'steps',
				mode: 'incremental',
				status: 'running',
				windowStart: '2026-08-14T08:00:00.000000000Z',
				windowEnd: '2026-08-14T09:00:00.000000000Z',
				syncId: 'webhook:active',
				attempt: 0,
				generation: 1,
				updatedAt: Date.now()
			});
			const runId = await ctx.db.insert('googleHealthSyncRuns', {
				connectionId,
				userId: 'clerk|user-a',
				trigger: 'webhook',
				dataType: 'steps',
				cursorId,
				generation: 1,
				startedAt: Date.now(),
				pages: 0,
				fetched: 0,
				inserted: 0,
				updated: 0,
				deleted: 0,
				skipped: 0,
				status: 'running'
			});
			await ctx.db.patch('googleHealthSyncCursors', cursorId, {
				activeRunId: runId,
				activeEpoch: 1,
				leaseExpiresAt: Date.now() + 300_000,
				leaseVersion: 1
			});
			await ctx.db.patch('googleHealthConnections', connectionId, {
				activeSyncCursorId: cursorId,
				activeSyncRunId: runId,
				syncLeaseExpiresAt: Date.now() + 300_000,
				syncLeaseVersion: 1
			});
			return { cursorId, runId };
		});

		const first = await postSigned(
			t,
			fixture,
			notification({
				intervals: [physicalInterval('2026-08-14T10:00:00Z', '2026-08-14T11:00:00Z')]
			})
		);
		const duplicate = await postSigned(
			t,
			fixture,
			notification({
				intervals: [physicalInterval('2026-08-14T10:30:00Z', '2026-08-14T12:00:00Z')]
			})
		);
		await pumpWebhookDelivery(t);
		const beforeFinish = await t.run(async (ctx) =>
			ctx.db.get('googleHealthSyncCursors', cursorId)
		);
		await t.mutation(internal.googleHealth.sync.finishDataType, {
			cursorId,
			generation: 1,
			runId,
			counts: { fetched: 0, inserted: 0, updated: 0, skipped: 0 }
		});
		await t.mutation(internal.googleHealth.sync.tryFinalizeRun, { runId });
		const afterFinish = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(10)
		}));

		expect([first.status, duplicate.status]).toEqual([204, 204]);
		expect(beforeFinish).toMatchObject({
			windowStart: '2026-08-14T08:00:00.000000000Z',
			windowEnd: '2026-08-14T09:00:00.000000000Z',
			pendingWindowStart: '2026-08-14T10:00:00.000000000Z',
			pendingWindowEnd: '2026-08-14T12:00:00.000000000Z'
		});
		expect(afterFinish.cursor).toMatchObject({
			status: 'queued',
			windowStart: '2026-08-14T10:00:00.000000000Z',
			windowEnd: '2026-08-14T12:00:00.000000000Z'
		});
		expect(afterFinish.cursor).not.toHaveProperty('pendingWindowStart');
		expect(afterFinish.scheduled.map((job) => job.name)).toContain(
			'googleHealth/sync:ensureCursorDispatched'
		);
	});

	it('clears matching stale incremental ownership before queueing a reconnected generation', async () => {
		const fixture = await signer();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(fixture.keyset)))
		);
		const t = backend();
		const connectionId = await seedConnection(t);
		const { cursorId, runId } = await t.run(async (ctx) => {
			const cursorId = await ctx.db.insert('googleHealthSyncCursors', {
				connectionId,
				userId: 'clerk|user-a',
				dataType: 'steps',
				mode: 'incremental',
				status: 'running',
				windowStart: '2026-08-14T08:00:00.000000000Z',
				windowEnd: '2026-08-14T09:00:00.000000000Z',
				syncId: 'webhook:stale',
				attempt: 0,
				generation: 1,
				updatedAt: Date.now()
			});
			const runId = await ctx.db.insert('googleHealthSyncRuns', {
				connectionId,
				userId: 'clerk|user-a',
				trigger: 'webhook',
				dataType: 'steps',
				cursorId,
				generation: 1,
				startedAt: Date.now(),
				pages: 0,
				fetched: 0,
				inserted: 0,
				updated: 0,
				deleted: 0,
				skipped: 0,
				status: 'running'
			});
			await ctx.db.patch('googleHealthSyncCursors', cursorId, {
				activeRunId: runId,
				activeEpoch: 1,
				leaseExpiresAt: Date.now() + 300_000,
				leaseVersion: 1
			});
			await ctx.db.patch('googleHealthConnections', connectionId, {
				generation: 2,
				activeSyncCursorId: cursorId,
				activeSyncRunId: runId,
				syncLeaseExpiresAt: Date.now() + 300_000,
				syncLeaseVersion: 1
			});
			return { cursorId, runId };
		});

		const response = await postSigned(t, fixture, notification({}));
		await pumpWebhookDelivery(t);
		const stored = await t.run(async (ctx) => ({
			connection: await ctx.db.get('googleHealthConnections', connectionId),
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			run: await ctx.db.get('googleHealthSyncRuns', runId),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(10)
		}));

		expect(response.status).toBe(204);
		expect(stored.connection).not.toHaveProperty('activeSyncCursorId');
		expect(stored.connection).not.toHaveProperty('activeSyncRunId');
		expect(stored.cursor).toMatchObject({ status: 'queued', generation: 2 });
		expect(stored.run).toMatchObject({ status: 'failed', errorCode: 'stale_generation' });
		expect(stored.scheduled.map((job) => job.name)).toContain(
			'googleHealth/sync:ensureCursorDispatched'
		);
	});
});

describe('Google Health webhook delivery variants', () => {
	let fixture: Awaited<ReturnType<typeof signer>>;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.stubEnv('GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION', AUTHORIZATION);
		fixture = await signer();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify(fixture.keyset)))
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('accepts a batch of 99, rejects 100, and acknowledges an unknown user without work', async () => {
		const t = backend();
		await seedConnection(t);
		const batch = Array.from({ length: 99 }, () => notification({}));
		const accepted = await postSigned(t, fixture, batch);
		const acceptedDelivery = await pumpWebhookDelivery(t);
		const tooLarge = await postSigned(t, fixture, [...batch, notification({})]);
		const rejectedDelivery = await pumpWebhookDelivery(t);
		const unknown = await postSigned(
			t,
			fixture,
			notification({ healthUserId: 'unknown-health-user' })
		);
		const unknownDelivery = await pumpWebhookDelivery(t);

		expect([accepted.status, tooLarge.status, unknown.status]).toEqual([204, 204, 204]);
		expect([acceptedDelivery.status, rejectedDelivery.status, unknownDelivery.status]).toEqual([
			'complete',
			'rejected',
			'complete'
		]);
	});

	it('uses civil bounds for civil-only metrics and exclusive dates for daily rollups', async () => {
		const t = backend();
		const connectionId = await seedConnection(t);
		const response = await postSigned(t, fixture, [
			notification({
				dataType: 'exercise',
				intervals: [documentedCivilInterval()]
			}),
			notification({
				dataType: 'calories-in-heart-rate-zone',
				intervals: [civilInterval('2026-08-14T10:00:00', '2026-08-14T11:00:00')]
			})
		]);
		await pumpWebhookDelivery(t);
		const cursors = await t.run(async (ctx) =>
			ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|user-a'))
				.take(10)
		);

		expect(response.status).toBe(204);
		expect(cursors.find((cursor) => cursor.dataType === 'exercise')).toMatchObject({
			connectionId,
			windowStart: '2026-08-14T10:00:00.000000000',
			windowEnd: '2026-08-14T11:00:00.000000000'
		});
		expect(
			cursors.find((cursor) => cursor.dataType === 'calories-in-heart-rate-zone')
		).toMatchObject({
			connectionId,
			windowStart: '2026-08-14',
			windowEnd: '2026-08-15'
		});
	});

	it('deletes an identifiable record without reconciliation and rejects non-webhook types', async () => {
		const t = backend();
		const connectionId = await seedConnection(t);
		const recordId = 'step-record-123';
		const fullName = `users/health-user-a/dataTypes/steps/dataPoints/${recordId}`;
		const recordKey = sha256Base64Url(`steps\n${canonicalJson({ kind: 'named', name: fullName })}`);
		const dataPointId = await t.run(async (ctx) => {
			const dataPointId = await ctx.db.insert('healthDataPoints', {
				connectionId,
				userId: 'clerk|user-a',
				provider: 'google_health',
				recordKey,
				googleDataPointName: fullName,
				dataType: 'steps',
				category: 'activity',
				recordTimestamp: Date.parse('2026-08-14T10:30:00Z'),
				localDate: '2026-08-14',
				physicalCoverageKey: '2026-08-14T10:30:00.000000000Z',
				primaryValue: 10,
				primaryUnit: 'steps',
				payloadDigest: 'digest',
				payloadJson: '{}',
				lastSeenSyncId: 'old',
				seenEpoch: 1
			});
			await ctx.db.insert('healthDataPointContributions', {
				connectionId,
				dataPointId,
				userId: 'clerk|user-a',
				recordKey,
				dataType: 'steps',
				category: 'activity',
				localDate: '2026-08-14',
				recordTimestamp: Date.parse('2026-08-14T10:30:00Z'),
				primaryValue: 10,
				physicalCoverageKey: '2026-08-14T10:30:00.000000000Z',
				seenEpoch: 1
			});
			return dataPointId;
		});
		const deleted = await postSigned(t, fixture, notification({ operation: 'DELETE', recordId }));
		await pumpWebhookDelivery(t);
		const unsupported = await postSigned(
			t,
			fixture,
			notification({ dataType: 'electrocardiogram' })
		);
		const unsupportedDelivery = await pumpWebhookDelivery(t);
		const stored = await t.run(async (ctx) => ({
			point: await ctx.db.get('healthDataPoints', dataPointId),
			rebuilds: await ctx.db
				.query('healthSummaryRebuilds')
				.withIndex('by_userId_and_dataType_and_localDate', (q) =>
					q.eq('userId', 'clerk|user-a').eq('dataType', 'steps').eq('localDate', '2026-08-14')
				)
				.take(2),
			cursors: await ctx.db.query('googleHealthSyncCursors').take(1)
		}));

		expect([deleted.status, unsupported.status]).toEqual([204, 204]);
		expect(unsupportedDelivery).toMatchObject({
			status: 'rejected',
			lastErrorCode: 'invalid_payload'
		});
		expect(stored.point).toBeNull();
		expect(stored.rebuilds).toHaveLength(1);
		expect(stored.cursors).toEqual([]);
	});

	it('tombstones a named delete against an active page until a same-generation upsert', async () => {
		const t = backend();
		const connectionId = await seedConnection(t);
		const recordId = 'step-record-active-run';
		const fullName = `users/health-user-a/dataTypes/steps/dataPoints/${recordId}`;
		const recordKey = sha256Base64Url(`steps\n${canonicalJson({ kind: 'named', name: fullName })}`);
		const pagePoint = {
			provider: 'google_health' as const,
			recordKey,
			googleDataPointName: fullName,
			dataType: 'steps',
			category: 'activity' as const,
			recordTimestamp: Date.parse('2026-08-14T10:30:00Z'),
			localDate: '2026-08-14',
			physicalCoverageKey: '2026-08-14T10:30:00.000000000Z',
			primaryValue: 10,
			primaryUnit: 'steps',
			payloadDigest: 'page-digest',
			payloadJson: '{}'
		};
		const { cursorId, runId } = await t.run(async (ctx) => {
			const cursorId = await ctx.db.insert('googleHealthSyncCursors', {
				connectionId,
				userId: 'clerk|user-a',
				dataType: 'steps',
				mode: 'incremental',
				status: 'queued',
				windowStart: '2026-08-14T10:00:00.000000000Z',
				windowEnd: '2026-08-14T11:00:00.000000000Z',
				syncId: 'active-page',
				attempt: 0,
				generation: 1,
				updatedAt: Date.now()
			});
			const runId = await ctx.db.insert('googleHealthSyncRuns', {
				connectionId,
				userId: 'clerk|user-a',
				cursorId,
				generation: 1,
				reconciliationEpoch: 1,
				trigger: 'webhook',
				dataType: 'steps',
				startedAt: Date.now(),
				pages: 0,
				fetched: 0,
				inserted: 0,
				updated: 0,
				deleted: 0,
				skipped: 0,
				status: 'running'
			});
			await ctx.db.patch('googleHealthSyncCursors', cursorId, {
				status: 'running',
				activeRunId: runId,
				activeEpoch: 1,
				reconciliationEpoch: 1,
				leaseVersion: 1,
				leaseExpiresAt: Date.now() + 300_000
			});
			await ctx.db.patch('googleHealthConnections', connectionId, {
				reconciliationEpoch: 1,
				activeSyncCursorId: cursorId,
				activeSyncRunId: runId,
				syncLeaseVersion: 1,
				syncLeaseExpiresAt: Date.now() + 300_000
			});
			const dataPointId = await ctx.db.insert('healthDataPoints', {
				connectionId,
				userId: 'clerk|user-a',
				...pagePoint,
				payloadDigest: 'stored-before-delete',
				lastSeenSyncId: 'older-page',
				seenEpoch: 1
			});
			await ctx.db.insert('healthDataPointContributions', {
				connectionId,
				dataPointId,
				userId: 'clerk|user-a',
				recordKey,
				dataType: 'steps',
				category: 'activity',
				localDate: '2026-08-14',
				recordTimestamp: pagePoint.recordTimestamp,
				primaryValue: 10,
				physicalCoverageKey: pagePoint.physicalCoverageKey,
				seenEpoch: 1
			});
			return { cursorId, runId };
		});

		const deleted = await postSigned(t, fixture, notification({ operation: 'DELETE', recordId }));
		await pumpWebhookDelivery(t);
		const afterDelete = await t.run(async (ctx) => ({
			points: await ctx.db
				.query('healthDataPoints')
				.withIndex('by_userId_and_recordKey', (q) =>
					q.eq('userId', 'clerk|user-a').eq('recordKey', recordKey)
				)
				.take(2),
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId)
		}));
		expect(deleted.status).toBe(204);
		expect(afterDelete.points).toEqual([]);
		expect(afterDelete.cursor).toMatchObject({ status: 'running' });
		expect(afterDelete.cursor).not.toHaveProperty('pendingWindowStart');
		expect(afterDelete.cursor).not.toHaveProperty('pendingWindowEnd');

		expect(
			await t.mutation(internal.googleHealth.records.applyReconciledPage, {
				connectionId,
				expectedGeneration: 1,
				cursorId,
				runId,
				dataType: 'steps',
				points: [pagePoint],
				syncId: 'page-fetched-before-delete',
				seenEpoch: 1
			})
		).toEqual({ inserted: 0, updated: 0, skipped: 1 });
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query('healthDataPoints')
					.withIndex('by_userId_and_recordKey', (q) =>
						q.eq('userId', 'clerk|user-a').eq('recordKey', recordKey)
					)
					.unique()
			)
		).toBeNull();

		const upserted = await postSigned(t, fixture, notification({ operation: 'UPSERT', recordId }));
		await pumpWebhookDelivery(t);
		expect(upserted.status).toBe(204);
		expect(
			await t.mutation(internal.googleHealth.records.applyReconciledPage, {
				connectionId,
				expectedGeneration: 1,
				cursorId,
				runId,
				dataType: 'steps',
				points: [pagePoint],
				syncId: 'page-after-upsert',
				seenEpoch: 1
			})
		).toEqual({ inserted: 1, updated: 0, skipped: 0 });

		await postSigned(t, fixture, notification({ operation: 'DELETE', recordId }));
		await pumpWebhookDelivery(t);
		await t.run(async (ctx) =>
			ctx.db.patch('googleHealthConnections', connectionId, {
				generation: 2,
				activeSyncCursorId: undefined,
				activeSyncRunId: undefined,
				syncLeaseExpiresAt: undefined
			})
		);
		expect(
			await t.mutation(internal.googleHealth.records.applyReconciledPage, {
				connectionId,
				expectedGeneration: 2,
				dataType: 'steps',
				points: [pagePoint],
				syncId: 'new-generation-page',
				seenEpoch: 2
			})
		).toEqual({ inserted: 1, updated: 0, skipped: 0 });
	});

	it('falls back to interval reconciliation when a named delete has no local match', async () => {
		const t = backend();
		await seedConnection(t);
		const response = await postSigned(
			t,
			fixture,
			notification({ operation: 'DELETE', recordId: 'not-imported' })
		);
		await pumpWebhookDelivery(t);
		const cursor = await t.run(async (ctx) => ctx.db.query('googleHealthSyncCursors').unique());

		expect(response.status).toBe(204);
		expect(cursor).toMatchObject({ dataType: 'steps', status: 'queued' });
	});

	it.each([
		[
			'physical',
			physicalInterval('2026-08-14T22:00:00Z', '2026-08-15T06:00:00Z'),
			'2026-08-14T22:00:00.000000000Z',
			'2026-08-15T06:00:00.000000001Z'
		],
		[
			'civil',
			civilInterval('2026-08-14T22:00:00', '2026-08-15T06:00:00'),
			'2026-08-14T22:00:00.000000000',
			'2026-08-15T06:00:00.000000001'
		]
	] as const)(
		'widens the official overnight sleep %s end-selector window by one nanosecond',
		async (_axis, interval, windowStart, windowEnd) => {
			const t = backend();
			await seedConnection(t);
			const response = await postSigned(
				t,
				fixture,
				notification({ dataType: 'sleep', intervals: [interval] })
			);
			await pumpWebhookDelivery(t);
			const cursor = await t.run(async (ctx) => ctx.db.query('googleHealthSyncCursors').unique());

			expect(response.status).toBe(204);
			expect(cursor).toMatchObject({ dataType: 'sleep', windowStart, windowEnd });
		}
	);

	it('applies 99 maximum-size named deletes in bounded transactions', async () => {
		const t = backend();
		const connectionId = await seedConnection(t);
		const largePayload = 'x'.repeat(749 * 1024);
		const batch: unknown[] = [];
		for (let index = 0; index < 99; index += 1) {
			const recordId = `large-step-${index}`;
			const fullName = `users/health-user-a/dataTypes/steps/dataPoints/${recordId}`;
			const recordKey = sha256Base64Url(
				`steps\n${canonicalJson({ kind: 'named', name: fullName })}`
			);
			await t.run(async (ctx) => {
				const dataPointId = await ctx.db.insert('healthDataPoints', {
					connectionId,
					userId: 'clerk|user-a',
					provider: 'google_health',
					recordKey,
					googleDataPointName: fullName,
					dataType: 'steps',
					category: 'activity',
					recordTimestamp: Date.parse('2026-08-14T10:30:00Z'),
					localDate: '2026-08-14',
					physicalCoverageKey: '2026-08-14T10:30:00.000000000Z',
					primaryValue: index,
					primaryUnit: 'steps',
					payloadDigest: `digest-${index}`,
					payloadJson: largePayload,
					lastSeenSyncId: 'old',
					seenEpoch: 1
				});
				await ctx.db.insert('healthDataPointContributions', {
					connectionId,
					dataPointId,
					userId: 'clerk|user-a',
					recordKey,
					dataType: 'steps',
					category: 'activity',
					localDate: '2026-08-14',
					recordTimestamp: Date.parse('2026-08-14T10:30:00Z'),
					primaryValue: index,
					physicalCoverageKey: '2026-08-14T10:30:00.000000000Z',
					seenEpoch: 1
				});
			});
			batch.push(notification({ operation: 'DELETE', recordId }));
		}

		const response = await postSigned(t, fixture, batch);
		const delivery = await pumpWebhookDelivery(t);
		const remaining = await t.run(async (ctx) => ({
			point: await ctx.db
				.query('healthDataPoints')
				.withIndex('by_connectionId', (q) => q.eq('connectionId', connectionId))
				.first(),
			contribution: await ctx.db
				.query('healthDataPointContributions')
				.withIndex('by_userId_and_dataType_and_localDate', (q) =>
					q.eq('userId', 'clerk|user-a').eq('dataType', 'steps').eq('localDate', '2026-08-14')
				)
				.first(),
			cursor: await ctx.db.query('googleHealthSyncCursors').first()
		}));

		expect(response.status).toBe(204);
		expect(delivery).toMatchObject({ status: 'complete', nextNotificationIndex: 99 });
		expect(remaining).toEqual({ point: null, contribution: null, cursor: null });
	});
});
