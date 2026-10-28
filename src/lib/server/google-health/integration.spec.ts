import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	googleHealthConnection,
	googleHealthOAuthState,
	googleHealthSyncCursor,
	googleHealthSyncRun,
	googleHealthWebhookDelivery,
	healthDataPoint
} from '../db/schema';
import { importSleepRecords, listNights } from '../sleep';
import { FakeGoogle } from '../testing/fake-google';
import { createTestDatabase, createUser, type TestDatabase } from '../testing/database';
import { signatureFixture } from '../testing/webhook-signing';
import { loadGoogleHealthConfig } from './config';
import {
	DELETE_CONFIRMATION,
	IMPORT_RETURN_PATH,
	beginConnection,
	beginDeletion,
	completeConnection,
	deleteConnectionDataBatch,
	disconnect,
	getConnectionStatus,
	requestManualSync
} from './connection';
import { cleanupOperationalData, queueDailyReconciliation } from './maintenance';
import {
	getMetricTrend,
	getOverview,
	listCategories,
	listMetricRecords,
	listMetrics
} from './records';
import { queueIncrementalWindow, reconciliationWindow } from './cursors';
import { getMetricDefinition } from './registry';
import { findDueConnections, syncConnection } from './sync';
import {
	KeysetUnavailableError,
	acceptDelivery,
	processDelivery,
	rescheduleStrandedDeliveries
} from './webhook';

const METRICS_SCOPE =
	'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly';
const ACTIVITY_SCOPE = 'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly';
// Metrics covered by the health-metrics scope alone (no rollups, which page through every
// fortnight since 2000 and would make these tests slow).
const METRICS_SCOPE_TYPES = 15;
const DAY_MS = 24 * 60 * 60 * 1000;

const config = loadGoogleHealthConfig({
	ORIGIN: 'https://homefit.example',
	GOOGLE_HEALTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
	GOOGLE_HEALTH_CLIENT_SECRET: 'client-secret',
	GOOGLE_HEALTH_REDIRECT_URI: '',
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION: 'v1',
	GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS: '{}',
	GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION: 'Bearer webhook-secret'
})!;

let database: TestDatabase;
let google: FakeGoogle;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.close();
});

beforeEach(() => {
	google = new FakeGoogle();
	google.grantedScopes = [METRICS_SCOPE];
	google.healthUserId = `health-${Math.random().toString(36).slice(2, 10)}`;
	google.install();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** An ISO timestamp `days` before now, at a fixed UTC hour so local dates are predictable. */
function daysAgo(days: number, hour = 12): string {
	const date = new Date(Date.now() - days * DAY_MS);
	date.setUTCHours(hour, 0, 0, 0);
	return date.toISOString();
}

function weight(time: string, grams: number, name?: string) {
	return {
		...(name === undefined ? {} : { name }),
		weight: { sampleTime: { physicalTime: time }, weightGrams: grams }
	};
}

function heartRate(time: string, beatsPerMinute: number) {
	return { heartRate: { sampleTime: { physicalTime: time }, beatsPerMinute } };
}

async function connect(userId: string): Promise<string> {
	const { authorizationUrl } = await beginConnection(
		database.db,
		config,
		userId,
		IMPORT_RETURN_PATH
	);
	const state = new URL(authorizationUrl).searchParams.get('state')!;
	const { connectionId } = await completeConnection(database.db, config, {
		code: 'authorization-code',
		state,
		userId
	});
	return connectionId;
}

async function authorizationState(userId: string): Promise<string> {
	const { authorizationUrl } = await beginConnection(
		database.db,
		config,
		userId,
		IMPORT_RETURN_PATH
	);
	return new URL(authorizationUrl).searchParams.get('state')!;
}

async function deleteGoogleData(userId: string): Promise<void> {
	const { connectionId, generation } = await beginDeletion(
		database.db,
		config,
		userId,
		DELETE_CONFIRMATION
	);
	while ((await deleteConnectionDataBatch(database.db, connectionId, generation)) === 'continue');
}

/** Holds the next outgoing request until released, so a callback can be interleaved with others. */
function holdNextFetch(): { reached: Promise<void>; release: () => void } {
	const fakeFetch = globalThis.fetch;
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => (reach = resolve));
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	let held = false;
	vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
		if (!held) {
			held = true;
			reach();
			await released;
		}
		return fakeFetch(input, init);
	});
	return { reached, release };
}

async function sync(connectionId: string): Promise<void> {
	expect(await syncConnection({ db: database.db, config }, connectionId)).toBe(false);
}

async function weightRecords(userId: string) {
	const page = await listMetricRecords(database.db, userId, {
		dataType: 'weight',
		limit: 50,
		after: null
	});
	return page.records.map((record) => [
		new Date(record.recordTimestamp).toISOString(),
		record.primaryValue
	]);
}

describe('Google Health OAuth', () => {
	it('builds a read-only authorization URL for the app callback', async () => {
		const userId = await createUser(database.db);
		const { authorizationUrl } = await beginConnection(
			database.db,
			config,
			userId,
			IMPORT_RETURN_PATH
		);
		const url = new URL(authorizationUrl);
		expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(url.searchParams.get('redirect_uri')).toBe(
			'https://homefit.example/api/google-health/oauth/callback'
		);
		expect(url.searchParams.get('access_type')).toBe('offline');
		expect(
			url.searchParams
				.get('scope')
				?.split(' ')
				.every((scope) => scope.endsWith('.readonly'))
		).toBe(true);
		await expect(beginConnection(database.db, config, userId, '/elsewhere')).rejects.toThrow();
	});

	it('binds the state to the signed-in user and consumes it once', async () => {
		const userId = await createUser(database.db);
		const other = await createUser(database.db);
		const { authorizationUrl } = await beginConnection(
			database.db,
			config,
			userId,
			IMPORT_RETURN_PATH
		);
		const state = new URL(authorizationUrl).searchParams.get('state')!;

		await expect(
			completeConnection(database.db, config, { code: 'code', state, userId: other })
		).rejects.toMatchObject({ code: 'invalid_state' });
		// The mismatched attempt consumed the state, so it cannot be replayed by its owner either.
		await expect(
			completeConnection(database.db, config, { code: 'code', state, userId })
		).rejects.toMatchObject({ code: 'invalid_state' });
		expect(await getConnectionStatus(database.db, userId)).toBeNull();
	});

	it('rejects a callback whose connection changed meanwhile and revokes its new token', async () => {
		const userId = await createUser(database.db);
		const first = await beginConnection(database.db, config, userId, IMPORT_RETURN_PATH);
		const second = await beginConnection(database.db, config, userId, IMPORT_RETURN_PATH);
		const state = (value: { authorizationUrl: string }) =>
			new URL(value.authorizationUrl).searchParams.get('state')!;

		await completeConnection(database.db, config, { code: 'a', state: state(first), userId });
		google.refreshToken = 'refresh-token-2';
		await expect(
			completeConnection(database.db, config, { code: 'b', state: state(second), userId })
		).rejects.toMatchObject({ code: 'connection_lifecycle_changed' });
		expect(google.revokedTokens).toContain('refresh-token-2');
	});

	it('rejects a callback whose connection was deleted and replaced meanwhile', async () => {
		const userId = await createUser(database.db);
		await connect(userId);
		const state = await authorizationState(userId);
		const exchange = holdNextFetch();
		const stale = completeConnection(database.db, config, { code: 'stale', state, userId });
		await exchange.reached;

		await deleteGoogleData(userId);
		google.healthUserId = 'health-replacement';
		google.refreshToken = 'refresh-token-replacement';
		const replacement = await connect(userId);

		google.healthUserId = 'health-stale';
		google.refreshToken = 'refresh-token-stale';
		exchange.release();
		await expect(stale).rejects.toMatchObject({ code: 'connection_lifecycle_changed' });
		expect(google.revokedTokens).toContain('refresh-token-stale');
		const [row] = await database.db
			.select()
			.from(googleHealthConnection)
			.where(eq(googleHealthConnection.userId, userId));
		expect(row).toMatchObject({ id: replacement, healthUserId: 'health-replacement' });
	});

	it('rejects a callback whose user connected and deleted meanwhile', async () => {
		const userId = await createUser(database.db);
		const state = await authorizationState(userId);
		const exchange = holdNextFetch();
		const stale = completeConnection(database.db, config, { code: 'stale', state, userId });
		await exchange.reached;

		await connect(userId);
		await deleteGoogleData(userId);

		google.refreshToken = 'refresh-token-stale';
		exchange.release();
		await expect(stale).rejects.toMatchObject({ code: 'connection_lifecycle_changed' });
		expect(google.revokedTokens).toContain('refresh-token-stale');
		expect(await getConnectionStatus(database.db, userId)).toBeNull();
	});

	it('stores only an encrypted refresh token', async () => {
		const userId = await createUser(database.db);
		const connectionId = await connect(userId);
		const [row] = await database.db
			.select()
			.from(googleHealthConnection)
			.where(eq(googleHealthConnection.id, connectionId));
		expect(row.healthUserId).toBe(google.healthUserId);
		expect(row.encryptedRefreshToken).not.toBeNull();
		expect(JSON.stringify(row)).not.toContain('refresh-token-1');
		expect(await getConnectionStatus(database.db, userId)).toMatchObject({
			status: 'backfilling',
			backfillTotalTypes: METRICS_SCOPE_TYPES,
			backfillCompletedTypes: 0,
			grantedScopes: [METRICS_SCOPE]
		});
	});
});

describe('Google Health synchronization', () => {
	it('imports the full history page by page and serves owned read models', async () => {
		google.setPages('weight', [
			[weight(daysAgo(10), 72_000), weight(daysAgo(9), 71_500)],
			[weight(daysAgo(2), 71_000)]
		]);
		google.setPages('heart-rate', [[heartRate(daysAgo(1, 8), 60), heartRate(daysAgo(1, 9), 80)]]);
		const userId = await createUser(database.db);
		const other = await createUser(database.db);
		const connectionId = await connect(userId);

		await sync(connectionId);

		expect(google.requestsFor('weight').map((request) => request.pageToken)).toEqual([
			undefined,
			'p1'
		]);
		expect(await getConnectionStatus(database.db, userId)).toMatchObject({
			status: 'active',
			backfillCompletedTypes: METRICS_SCOPE_TYPES,
			lastSuccessfulSyncAt: expect.any(Number)
		});
		expect(await listCategories(database.db, userId)).toEqual([
			{ category: 'vitals', count: 1 },
			{ category: 'body', count: 1 }
		]);
		const metrics = await listMetrics(database.db, userId, null);
		expect(metrics.map((metric) => metric.dataType)).toEqual(['heart-rate', 'weight']);
		expect(metrics[0].latestSummary).toMatchObject({ count: 2, average: 70, min: 60, max: 80 });
		expect(metrics[1].latestSummary).toMatchObject({
			localDate: daysAgo(2).slice(0, 10),
			latestValue: 71
		});
		expect(await listMetrics(database.db, other, null)).toEqual([]);

		const overview = await getOverview(database.db, userId, 30);
		expect(overview.metrics.map((metric) => metric.dataType)).toEqual(['weight', 'heart-rate']);
		expect(overview.metrics[0].trend).toHaveLength(3);
		const trend = await getMetricTrend(database.db, userId, {
			dataType: 'weight',
			fromDate: daysAgo(9).slice(0, 10),
			toDate: daysAgo(0).slice(0, 10)
		});
		expect(trend.kind === 'found' && trend.summaries.map((summary) => summary.latestValue)).toEqual(
			[71.5, 71]
		);

		const firstPage = await listMetricRecords(database.db, userId, {
			dataType: 'weight',
			limit: 2,
			after: null
		});
		expect(firstPage.records.map((record) => record.primaryValue)).toEqual([71, 71.5]);
		expect(firstPage.records[0].payload).toMatchObject({ kind: 'fields' });
		const secondPage = await listMetricRecords(database.db, userId, {
			dataType: 'weight',
			limit: 2,
			after: firstPage.nextCursor
		});
		expect(secondPage).toMatchObject({ records: [{ primaryValue: 72 }], nextCursor: null });
	});

	it('reconciles the recent window: corrects, keeps and removes records idempotently', async () => {
		const older = daysAgo(20);
		const kept = daysAgo(3);
		const vanished = daysAgo(2);
		google.setPages('weight', [
			[weight(older, 70_000), weight(kept, 71_000), weight(vanished, 72_000)]
		]);
		const userId = await createUser(database.db);
		const connectionId = await connect(userId);
		await sync(connectionId);

		// Google now reports a corrected value and no longer returns the newest record.
		google.setHandler('weight', ({ filter }) => ({
			points: filter === undefined ? [] : [weight(kept, 71_200)]
		}));
		expect(await requestManualSync(database.db, userId)).toEqual({
			connectionId,
			queued: METRICS_SCOPE_TYPES
		});
		await sync(connectionId);

		expect(google.requestsFor('weight').at(-1)?.filter).toMatch(
			/^weight\.sample_time\.physical_time >= ".+" AND/
		);
		expect(await weightRecords(userId)).toEqual([
			[kept, 71.2],
			[older, 70]
		]);
		const metrics = await listMetrics(database.db, userId, 'body');
		expect(metrics[0].latestSummary).toMatchObject({
			localDate: kept.slice(0, 10),
			latestValue: 71.2
		});
		const [run] = await database.db
			.select()
			.from(googleHealthSyncRun)
			.where(
				and(
					eq(googleHealthSyncRun.connectionId, connectionId),
					eq(googleHealthSyncRun.dataType, 'weight'),
					eq(googleHealthSyncRun.mode, 'incremental')
				)
			);
		expect(run).toMatchObject({ status: 'succeeded', updated: 1, deleted: 1 });

		// Running the same reconciliation again changes nothing.
		await requestManualSync(database.db, userId);
		await sync(connectionId);
		expect(await weightRecords(userId)).toEqual([
			[kept, 71.2],
			[older, 70]
		]);
	});

	it('resumes a partially imported metric from its page token after yielding', async () => {
		google.setPages('weight', [
			[weight(daysAgo(6), 70_000)],
			[weight(daysAgo(5), 70_500)],
			[weight(daysAgo(4), 71_000)]
		]);
		google.setHandler('heart-rate', () => ({ points: [] }));
		const pages = google.requestsFor.bind(google);
		const userId = await createUser(database.db);
		const connectionId = await connect(userId);

		// A 1 ms budget yields after (at most) one page, exercising every resume path.
		let jobs = 0;
		while (await syncConnection({ db: database.db, config, budgetMs: 1 }, connectionId)) {
			jobs += 1;
			expect(jobs).toBeLessThan(100);
		}

		expect(jobs).toBeGreaterThan(1);
		expect(pages('weight').map((request) => request.pageToken)).toEqual([undefined, 'p1', 'p2']);
		expect(await weightRecords(userId)).toHaveLength(3);
		const epochs = await database.db
			.selectDistinct({ epoch: healthDataPoint.seenEpoch })
			.from(healthDataPoint)
			.where(and(eq(healthDataPoint.userId, userId), eq(healthDataPoint.dataType, 'weight')));
		// Every page of one historical unit belongs to the same reconciliation pass.
		expect(epochs).toHaveLength(1);
		expect(await getConnectionStatus(database.db, userId)).toMatchObject({ status: 'active' });
	});

	it('finishes the import when Google permanently refuses one metric', async () => {
		google.setPages('weight', [[weight(daysAgo(3), 70_000)]]);
		google.setHandler('blood-glucose', () => {
			throw new Response(JSON.stringify({ error: 'permission_denied' }), { status: 403 });
		});
		const userId = await createUser(database.db);
		const connectionId = await connect(userId);

		await sync(connectionId);

		expect(await getConnectionStatus(database.db, userId)).toMatchObject({
			status: 'active',
			backfillCompletedTypes: METRICS_SCOPE_TYPES
		});
		expect(await weightRecords(userId)).toHaveLength(1);
		const [run] = await database.db
			.select()
			.from(googleHealthSyncRun)
			.where(
				and(
					eq(googleHealthSyncRun.connectionId, connectionId),
					eq(googleHealthSyncRun.dataType, 'blood-glucose')
				)
			);
		expect(run).toMatchObject({ status: 'failed', errorCode: 'permission_denied' });
		const [cursor] = await database.db
			.select()
			.from(googleHealthSyncCursor)
			.where(
				and(
					eq(googleHealthSyncCursor.connectionId, connectionId),
					eq(googleHealthSyncCursor.dataType, 'blood-glucose')
				)
			);
		expect(cursor.status).toBe('failed');

		// Reconciliation revives the failed metric, which reopens the import until it finishes.
		google.setHandler('blood-glucose', () => ({ points: [] }));
		await requestManualSync(database.db, userId);
		expect(await getConnectionStatus(database.db, userId)).toMatchObject({
			status: 'backfilling',
			backfillCompletedTypes: METRICS_SCOPE_TYPES - 1
		});
		await sync(connectionId);
		expect(await getConnectionStatus(database.db, userId)).toMatchObject({
			status: 'active',
			backfillCompletedTypes: METRICS_SCOPE_TYPES
		});
	});

	it('resets the retry backoff once a page succeeds', async () => {
		const failures = new Set(['p1', 'p3']);
		const serve = (pageToken: string | undefined) => {
			if (pageToken !== undefined && failures.delete(pageToken)) {
				throw new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
			}
			const index = pageToken === undefined ? 0 : Number(pageToken.slice(1));
			return {
				points: [weight(daysAgo(9 - index), 70_000 + index * 100)],
				...(index < 3 ? { nextPageToken: `p${index + 1}` } : {})
			};
		};
		google.setHandler('weight', ({ pageToken }) => serve(pageToken));
		const userId = await createUser(database.db);
		const connectionId = await connect(userId);
		const makeDue = async () => {
			const past = new Date(Date.now() - 1_000);
			await database.db
				.update(googleHealthConnection)
				.set({ nextRetryAt: past })
				.where(eq(googleHealthConnection.id, connectionId));
			await database.db
				.update(googleHealthSyncCursor)
				.set({ nextAttemptAt: past })
				.where(eq(googleHealthSyncCursor.connectionId, connectionId));
		};

		await sync(connectionId); // page 0 succeeds, p1 fails (first retry)
		await makeDue();
		await sync(connectionId); // p1 and p2 succeed, p3 fails again
		const delay = (await getConnectionStatus(database.db, userId))!.nextRetryAt! - Date.now();
		// A first-attempt delay (30 s ± 20 %), not a second-attempt one (60 s ± 20 %).
		expect(delay).toBeLessThan(40_000);

		await makeDue();
		await sync(connectionId);
		expect(await weightRecords(userId)).toHaveLength(4);
	});

	it('refreshes the access token when a reconnect lands between two metrics', async () => {
		google.setPages('weight', [[weight(daysAgo(2), 70_000)]]);
		const userId = await createUser(database.db);
		const connectionId = await connect(userId);
		let requestsBeforeReconnect: number | null = null;
		const finishedMetric = async () =>
			(
				await database.db
					.select({ id: googleHealthSyncCursor.id })
					.from(googleHealthSyncCursor)
					.where(
						and(
							eq(googleHealthSyncCursor.connectionId, connectionId),
							eq(googleHealthSyncCursor.status, 'complete')
						)
					)
					.limit(1)
			).length > 0;
		// Reconnects to another Google account as soon as the first metric is committed, before
		// the worker claims the next one.
		const db = new Proxy(database.db, {
			get(target, property, receiver) {
				if (property !== 'transaction') return Reflect.get(target, property, receiver);
				return async (...args: Parameters<typeof target.transaction>) => {
					if (requestsBeforeReconnect === null && (await finishedMetric())) {
						requestsBeforeReconnect = google.dataRequests.length;
						google.healthUserId = `${google.healthUserId}-other`;
						google.refreshToken = 'refresh-token-2';
						await connect(userId);
					}
					return await target.transaction(...args);
				};
			}
		});

		expect(await syncConnection({ db, config }, connectionId)).toBe(false);

		expect(requestsBeforeReconnect).not.toBeNull();
		const previousTokens = new Set(
			google.dataRequests.slice(0, requestsBeforeReconnect!).map((request) => request.authorization)
		);
		const afterReconnect = google.dataRequests.slice(requestsBeforeReconnect!);
		expect(afterReconnect.length).toBeGreaterThan(0);
		expect(afterReconnect.filter((request) => previousTokens.has(request.authorization))).toEqual(
			[]
		);
	});

	it('refreshes daily roll-up metrics by date range', async () => {
		const userId = await createUser(database.db);
		const connectionId = await connect(userId);
		await sync(connectionId);
		google.grantedScopes = [METRICS_SCOPE, ACTIVITY_SCOPE];
		const [connection] = await database.db
			.update(googleHealthConnection)
			.set({ grantedScopes: google.grantedScopes })
			.where(eq(googleHealthConnection.id, connectionId))
			.returning();
		const civil = (date: Date) => ({
			date: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
			time: { hours: 0, minutes: 0, seconds: 0 }
		});
		const yesterday = new Date(Date.now() - DAY_MS);
		google.setHandler('total-calories', () => ({
			points: [
				{
					civilStartTime: civil(yesterday),
					civilEndTime: civil(new Date()),
					totalCalories: { kcalSum: 1850 }
				}
			]
		}));
		const rollups = ['total-calories', 'calories-in-heart-rate-zone'];
		for (const dataType of rollups) {
			await queueIncrementalWindow(
				database.db,
				{ connectionId, generation: connection.generation, grantedScopes: google.grantedScopes },
				dataType,
				reconciliationWindow(getMetricDefinition(dataType)!, Date.now()),
				'manual'
			);
		}

		await sync(connectionId);

		const cursors = await database.db
			.select({ dataType: googleHealthSyncCursor.dataType, status: googleHealthSyncCursor.status })
			.from(googleHealthSyncCursor)
			.where(
				and(
					eq(googleHealthSyncCursor.connectionId, connectionId),
					eq(googleHealthSyncCursor.mode, 'incremental')
				)
			);
		expect(cursors.toSorted((a, b) => a.dataType.localeCompare(b.dataType))).toEqual([
			{ dataType: 'calories-in-heart-rate-zone', status: 'complete' },
			{ dataType: 'total-calories', status: 'complete' }
		]);
		for (const dataType of rollups) {
			expect(google.requestsFor(dataType)).toEqual([
				expect.objectContaining({ readMode: 'dailyRollUp', filter: undefined })
			]);
		}
		const page = await listMetricRecords(database.db, userId, {
			dataType: 'total-calories',
			limit: 50,
			after: null
		});
		expect(page.records.map((record) => record.primaryValue)).toEqual([1850]);
	});

	it('backs off on transient errors and asks for action when access is revoked', async () => {
		const userId = await createUser(database.db);
		const connectionId = await connect(userId);
		google.refreshFailure = { status: 503, error: 'backendError' };

		await sync(connectionId);
		const delayed = await getConnectionStatus(database.db, userId);
		// Remote error codes are sanitized; mixed-case ones fall back to the HTTP status.
		expect(delayed).toMatchObject({ status: 'delayed', lastErrorCode: 'http_503' });
		expect(delayed?.nextRetryAt).toBeGreaterThan(Date.now());
		expect(await findDueConnections(database.db)).not.toContain(connectionId);

		const past = new Date(Date.now() - 1_000);
		await database.db
			.update(googleHealthConnection)
			.set({ nextRetryAt: past })
			.where(eq(googleHealthConnection.id, connectionId));
		await database.db
			.update(googleHealthSyncCursor)
			.set({ nextAttemptAt: past })
			.where(eq(googleHealthSyncCursor.connectionId, connectionId));
		expect(await findDueConnections(database.db)).toContain(connectionId);

		google.refreshFailure = { status: 400, error: 'invalid_grant' };
		await sync(connectionId);
		expect(await getConnectionStatus(database.db, userId)).toMatchObject({
			status: 'action_required',
			lastErrorCode: 'invalid_grant'
		});
		expect(await findDueConnections(database.db)).not.toContain(connectionId);
	});
});

describe('Google Health webhooks', () => {
	function notification(operation: 'UPSERT' | 'DELETE', around: string, recordId?: string) {
		const at = Date.parse(around);
		return {
			data: {
				version: '1',
				clientProvidedSubscriptionName: 'homefit-health',
				healthUserId: google.healthUserId,
				operation,
				dataType: 'weight',
				intervals: [
					{
						physicalTimeInterval: {
							startTime: new Date(at - 3_600_000).toISOString(),
							endTime: new Date(at + 3_600_000).toISOString()
						}
					}
				],
				...(recordId === undefined ? {} : { recordId })
			}
		};
	}

	it('verifies signed deliveries once and applies them to the owning connection', async () => {
		const signing = await signatureFixture();
		google.keyset = signing.keyset;
		const named = daysAgo(1);
		const unnamed = daysAgo(2);
		google.setPages('weight', [
			[
				weight(named, 70_000, `users/${google.healthUserId}/dataTypes/weight/dataPoints/abc`),
				weight(unnamed, 71_000)
			]
		]);
		const userId = await createUser(database.db);
		const connectionId = await connect(userId);
		await sync(connectionId);

		const rawBody = JSON.stringify([
			notification('DELETE', named, 'abc'),
			notification('UPSERT', unnamed)
		]);
		const signature = await signing.sign(rawBody);
		const accepted = await acceptDelivery(database.db, rawBody, signature);
		expect(accepted.created).toBe(true);
		expect(await acceptDelivery(database.db, rawBody, signature)).toEqual({
			deliveryId: accepted.deliveryId,
			created: false
		});

		expect(await processDelivery(database.db, accepted.deliveryId)).toEqual([connectionId]);
		expect(await processDelivery(database.db, accepted.deliveryId)).toEqual([]);
		// The identifiable record is deleted immediately; the other notification queues a window.
		expect(await weightRecords(userId)).toEqual([[unnamed, 71]]);
		const [delivery] = await database.db
			.select()
			.from(googleHealthWebhookDelivery)
			.where(eq(googleHealthWebhookDelivery.id, accepted.deliveryId));
		expect(delivery).toMatchObject({ status: 'complete', rawBody: null, signature: null });
		const [cursor] = await database.db
			.select()
			.from(googleHealthSyncCursor)
			.where(
				and(
					eq(googleHealthSyncCursor.connectionId, connectionId),
					eq(googleHealthSyncCursor.dataType, 'weight'),
					eq(googleHealthSyncCursor.mode, 'incremental')
				)
			);
		expect(cursor).toMatchObject({ status: 'queued', trigger: 'webhook' });
		expect(cursor.windowStart! < unnamed && unnamed < cursor.windowEnd!).toBe(true);

		google.setHandler('weight', () => ({ points: [weight(unnamed, 71_000)] }));
		await sync(connectionId);
		expect(await weightRecords(userId)).toEqual([[unnamed, 71]]);
	});

	it('records a delete-only delivery as a sync so open views refresh', async () => {
		const signing = await signatureFixture();
		google.keyset = signing.keyset;
		const named = daysAgo(1);
		google.setPages('weight', [
			[weight(named, 70_000, `users/${google.healthUserId}/dataTypes/weight/dataPoints/abc`)]
		]);
		const userId = await createUser(database.db);
		const connectionId = await connect(userId);
		await sync(connectionId);
		await database.db
			.update(googleHealthConnection)
			.set({ lastSuccessfulSyncAt: new Date(0) })
			.where(eq(googleHealthConnection.id, connectionId));

		const rawBody = JSON.stringify([notification('DELETE', named, 'abc')]);
		const { deliveryId } = await acceptDelivery(database.db, rawBody, await signing.sign(rawBody));
		expect(await processDelivery(database.db, deliveryId)).toEqual([]);

		expect(await weightRecords(userId)).toEqual([]);
		expect((await getConnectionStatus(database.db, userId))?.lastSuccessfulSyncAt).toBeGreaterThan(
			0
		);
	});

	it('rejects deliveries whose signature does not match the body', async () => {
		const signing = await signatureFixture();
		google.keyset = signing.keyset;
		const rawBody = JSON.stringify([notification('UPSERT', daysAgo(1))]);
		const { deliveryId } = await acceptDelivery(
			database.db,
			rawBody,
			await signing.sign(`${rawBody} `)
		);

		expect(await processDelivery(database.db, deliveryId)).toEqual([]);
		const [delivery] = await database.db
			.select()
			.from(googleHealthWebhookDelivery)
			.where(eq(googleHealthWebhookDelivery.id, deliveryId));
		expect(delivery).toMatchObject({
			status: 'rejected',
			lastErrorCode: 'invalid_signature',
			rawBody: null
		});
	});

	it('resumes deliveries whose processing job is gone', async () => {
		const signing = await signatureFixture();
		google.keyset = null;
		const rawBody = JSON.stringify([notification('UPSERT', daysAgo(1))]);
		const { deliveryId } = await acceptDelivery(database.db, rawBody, await signing.sign(rawBody));
		const idleFor = async (ms: number) => {
			await database.db
				.update(googleHealthWebhookDelivery)
				.set({ updatedAt: new Date(Date.now() - ms) })
				.where(eq(googleHealthWebhookDelivery.id, deliveryId));
		};
		const stranded = async () => await rescheduleStrandedDeliveries(database.db);

		// Its job is still expected to run.
		expect(await stranded()).not.toContain(deliveryId);
		// Never started, e.g. because enqueueing it failed. It is handed out once per interval.
		await idleFor(6 * 60_000);
		expect(await stranded()).toContain(deliveryId);
		expect(await stranded()).not.toContain(deliveryId);

		await expect(processDelivery(database.db, deliveryId)).rejects.toBeInstanceOf(
			KeysetUnavailableError
		);
		// Attempted recently, so the job is still retrying.
		await idleFor(30 * 60_000);
		expect(await stranded()).not.toContain(deliveryId);
		// Idle past the job's longest retry delay: its retries ran out.
		await idleFor(3 * 60 * 60_000);
		expect(await stranded()).toContain(deliveryId);

		google.keyset = signing.keyset;
		await processDelivery(database.db, deliveryId);
		await idleFor(3 * 60 * 60_000);
		expect(await stranded()).not.toContain(deliveryId);
	});
});

describe('Google Health lifecycle', () => {
	it('disconnects without losing data and deletes only Google data on request', async () => {
		google.setPages('weight', [[weight(daysAgo(4), 70_000)]]);
		const userId = await createUser(database.db);
		await importSleepRecords(database.db, userId, [
			{
				wentToBed: Date.now() - 9 * 3_600_000,
				wokeUp: Date.now() - 3_600_000,
				sleepQuality: 80,
				timeInBedSeconds: 28_800,
				timeAsleepSeconds: 25_200,
				asleepAfterSeconds: 600,
				didSnore: false,
				snoreTimeSeconds: 0,
				notes: []
			}
		]);
		const connectionId = await connect(userId);
		await sync(connectionId);

		await disconnect(database.db, config, userId);
		expect(google.revokedTokens).toEqual(['refresh-token-1']);
		expect(await getConnectionStatus(database.db, userId)).toMatchObject({
			status: 'disconnected',
			disconnectedAt: expect.any(Number)
		});
		const [disconnected] = await database.db
			.select()
			.from(googleHealthConnection)
			.where(eq(googleHealthConnection.id, connectionId));
		expect(disconnected.encryptedRefreshToken).toBeNull();
		expect(await weightRecords(userId)).toHaveLength(1);
		await expect(requestManualSync(database.db, userId)).rejects.toThrow();

		await expect(beginDeletion(database.db, config, userId, 'delete')).rejects.toThrow();
		const deletion = await beginDeletion(database.db, config, userId, DELETE_CONFIRMATION);
		expect(await getConnectionStatus(database.db, userId)).toMatchObject({ status: 'deleting' });
		await expect(
			beginConnection(database.db, config, userId, IMPORT_RETURN_PATH)
		).rejects.toThrow();

		let result: string;
		do {
			result = await deleteConnectionDataBatch(
				database.db,
				deletion.connectionId,
				deletion.generation
			);
		} while (result === 'continue');
		expect(result).toBe('done');
		expect(await getConnectionStatus(database.db, userId)).toBeNull();
		expect(await listMetrics(database.db, userId, null)).toEqual([]);
		expect(
			await database.db.select().from(healthDataPoint).where(eq(healthDataPoint.userId, userId))
		).toEqual([]);
		expect(await listNights(database.db, userId, 'UTC')).toHaveLength(1);
	});

	it('queues daily reconciliation and removes expired operational data', async () => {
		const userId = await createUser(database.db);
		const connectionId = await connect(userId);
		await sync(connectionId);

		expect(await queueDailyReconciliation(database.db)).toContain(connectionId);
		expect(await findDueConnections(database.db)).toContain(connectionId);

		await database.db.insert(googleHealthOAuthState).values({
			userId,
			stateDigest: `expired-${connectionId}`,
			returnPath: IMPORT_RETURN_PATH,
			expiresAt: new Date(Date.now() - 60_000)
		});
		await database.db.insert(googleHealthSyncRun).values({
			connectionId,
			dataType: 'weight',
			mode: 'backfill',
			trigger: 'oauth',
			status: 'succeeded',
			startedAt: new Date(Date.now() - 40 * DAY_MS)
		});
		const result = await cleanupOperationalData(database.db);
		expect(result.oauthStates).toBeGreaterThanOrEqual(1);
		expect(result.syncRuns).toBeGreaterThanOrEqual(1);
	});
});
