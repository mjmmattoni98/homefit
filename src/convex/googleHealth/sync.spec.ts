/// <reference types="vite/client" />

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import schema from '../schema';
import { createTokenKeyring, decryptRefreshToken, encryptRefreshToken } from './crypto';
import { GOOGLE_HEALTH_READ_SCOPES, getMetricDefinition } from './registry';
import { chunkNormalizedPoints, computeRetryDelayMs } from './sync';

const modules = import.meta.glob('/src/convex/**/*.*s');
const ACTIVE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const PREVIOUS_KEY = 'Hh8cHRobGBkWFxQVEhMQEQ4PDA0KCwgJBgUEAwIBAAA=';

function boundedConvexTest() {
	return convexTest({ schema, modules, transactionLimits: true });
}

async function pumpReady(t: ReturnType<typeof convexTest>, times = 1): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		vi.advanceTimersByTime(0);
		await t.finishInProgressScheduledFunctions();
	}
}

const runCursor = internal.googleHealth.sync.runCursor;

async function runCurrentCursor(
	t: ReturnType<typeof convexTest>,
	args: {
		cursorId: Id<'googleHealthSyncCursors'>;
		generation: number;
		trigger: 'oauth' | 'webhook' | 'manual' | 'retry' | 'reconciliation';
	}
): Promise<void> {
	const expectedDispatchVersion = await t.run(async (ctx) => {
		const cursor = await ctx.db.get('googleHealthSyncCursors', args.cursorId);
		if (cursor === null) throw new Error('expected cursor');
		return cursor.dispatchVersion ?? 0;
	});
	await t.action(runCursor, { ...args, expectedDispatchVersion });
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function installEnvironment(): void {
	vi.stubEnv('GOOGLE_HEALTH_CLIENT_ID', 'client-id.apps.googleusercontent.com');
	vi.stubEnv('GOOGLE_HEALTH_CLIENT_SECRET', 'client-secret');
	vi.stubEnv(
		'GOOGLE_HEALTH_REDIRECT_URI',
		'https://example.convex.site/google-health/oauth/callback'
	);
	vi.stubEnv('HOMEFIT_APP_URL', 'https://homefit.example');
	vi.stubEnv('GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY', ACTIVE_KEY);
	vi.stubEnv('GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION', 'v2');
	vi.stubEnv('GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS', JSON.stringify({ v1: PREVIOUS_KEY }));
	vi.stubEnv('GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION', 'unused-in-sync-tests');
}

async function seedCursor(
	t: ReturnType<typeof convexTest>,
	args: {
		dataType: string;
		generation?: number;
		status?: 'backfilling' | 'active' | 'delayed' | 'action_required' | 'disconnected';
		key?: string;
		keyVersion?: string;
		refreshToken?: string;
		mode?: 'backfill' | 'incremental';
		windowStart?: string;
		windowEnd?: string;
		pageToken?: string;
		backfillTotalTypes?: number;
		backfillCompletedTypes?: number;
	}
): Promise<{
	connectionId: Id<'googleHealthConnections'>;
	cursorId: Id<'googleHealthSyncCursors'>;
}> {
	const generation = args.generation ?? 1;
	const userId = 'user-a';
	const envelope = await encryptRefreshToken(
		args.refreshToken ?? 'stored-refresh-token',
		userId,
		args.key ?? ACTIVE_KEY,
		args.keyVersion ?? 'v2'
	);
	return await t.run(async (ctx) => {
		const connectionId = await ctx.db.insert('googleHealthConnections', {
			userId,
			healthUserId: 'health-user-a',
			status: args.status ?? 'backfilling',
			...envelope,
			grantedScopes: [getMetricDefinition(args.dataType)?.scope ?? GOOGLE_HEALTH_READ_SCOPES[0]],
			generation,
			backfillTotalTypes: args.backfillTotalTypes ?? 1,
			backfillCompletedTypes: args.backfillCompletedTypes ?? 0
		});
		const cursorId = await ctx.db.insert('googleHealthSyncCursors', {
			connectionId,
			userId,
			dataType: args.dataType,
			mode: args.mode ?? 'backfill',
			status: 'queued',
			...(args.pageToken === undefined ? {} : { pageToken: args.pageToken }),
			...(args.windowStart === undefined ? {} : { windowStart: args.windowStart }),
			...(args.windowEnd === undefined ? {} : { windowEnd: args.windowEnd }),
			syncId: `backfill:${generation}:${args.dataType}`,
			attempt: 0,
			generation,
			updatedAt: Date.now()
		});
		return { connectionId, cursorId };
	});
}

function tokenResponse(extra: Record<string, unknown> = {}): Response {
	return jsonResponse({
		access_token: 'short-lived-access-token',
		expires_in: 3600,
		token_type: 'Bearer',
		...extra
	});
}

describe('Google Health bounded cursor worker', () => {
	beforeEach(() => {
		installEnvironment();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('fetches one reconcile page per invocation and schedules one generated continuation', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
		const t = boundedConvexTest();
		const { cursorId } = await seedCursor(t, { dataType: 'heart-rate' });
		let page = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
			if (url.includes('/dataTypes/heart-rate/dataPoints:reconcile')) {
				page += 1;
				return jsonResponse(
					page === 1
						? {
								dataPoints: [
									{
										heartRate: {
											sampleTime: { physicalTime: '2026-08-14T10:00:00Z' },
											beatsPerMinute: 61
										}
									}
								],
								nextPageToken: 'page-2'
							}
						: {
								dataPoints: [
									{
										heartRate: {
											sampleTime: { physicalTime: '2026-08-14T11:00:00Z' },
											beatsPerMinute: 63
										}
									}
								]
							}
				);
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
		expect(page).toBe(1);
		expect(
			(await t.run(async (ctx) => ctx.db.get('googleHealthSyncCursors', cursorId)))?.status
		).toBe('running');
		const afterFirst = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(10),
			points: await ctx.db
				.query('healthDataPoints')
				.withIndex('by_userId_and_dataType_and_recordTimestamp', (q) =>
					q.eq('userId', 'user-a').eq('dataType', 'heart-rate')
				)
				.take(10)
		}));
		expect(afterFirst.cursor).toMatchObject({ status: 'running' });
		expect(afterFirst.points).toHaveLength(1);
		expect(
			afterFirst.scheduled.filter((job) => job.name === 'googleHealth/sync:runCursor')
		).toHaveLength(0);
		expect(
			afterFirst.scheduled.some((job) => job.name === 'googleHealth/sync:recoverStaleRun')
		).toBe(true);

		await pumpReady(t, 7);
		expect(page).toBe(2);
		const afterSecond = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			points: await ctx.db
				.query('healthDataPoints')
				.withIndex('by_userId_and_dataType_and_recordTimestamp', (q) =>
					q.eq('userId', 'user-a').eq('dataType', 'heart-rate')
				)
				.take(10)
		}));
		expect(afterSecond.cursor).toMatchObject({ status: 'complete' });
		expect(afterSecond.points).toHaveLength(2);
	});

	it.each([
		['sleep', 25],
		['exercise', 25],
		['steps', 1000],
		['food', 1000]
	] as const)('caps %s backfill page size at %i', async (dataType, pageSize) => {
		const t = boundedConvexTest();
		const { cursorId } = await seedCursor(t, { dataType });
		const urls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url === 'https://oauth2.googleapis.com/token') return tokenResponse();
				urls.push(url);
				return jsonResponse({ dataPoints: [] });
			})
		);

		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
		expect(urls).toHaveLength(1);
		const request = new URL(urls[0]);
		expect(request.searchParams.get('pageSize')).toBe(String(pageSize));
		expect(request.searchParams.has('filter')).toBe(false);
		expect(request.pathname.endsWith(':reconcile')).toBe(dataType !== 'food');
	});

	it('splits by cumulative UTF-8 bytes and point count before bounded record mutations', async () => {
		const small = (index: number) => ({
			provider: 'google_health' as const,
			recordKey: `key-${index}`,
			dataType: 'steps',
			category: 'activity' as const,
			recordTimestamp: index,
			localDate: '2026-08-14',
			primaryValue: index,
			payloadDigest: `digest-${index}`,
			payloadJson: '{}'
		});
		expect(
			chunkNormalizedPoints(Array.from({ length: 17 }, (_, index) => small(index))).map(
				(chunk) => chunk.length
			)
		).toEqual([16, 1]);
		const large = [
			{ ...small(1), payloadJson: 'é'.repeat(380_000) },
			{ ...small(2), payloadJson: 'é'.repeat(380_000) }
		];
		expect(chunkNormalizedPoints(large).map((chunk) => chunk.length)).toEqual([1, 1]);

		const t = boundedConvexTest();
		const { cursorId } = await seedCursor(t, { dataType: 'steps' });
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input) === 'https://oauth2.googleapis.com/token'
					? tokenResponse()
					: jsonResponse({
							dataPoints: Array.from({ length: 17 }, (_, index) => {
								const start = new Date(Date.parse('2026-08-14T10:00:00Z') + index * 60_000);
								const end = new Date(start.getTime() + 30_000);
								return {
									steps: {
										interval: { startTime: start.toISOString(), endTime: end.toISOString() },
										count: index + 1
									}
								};
							})
						})
			)
		);
		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
		const stored = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(50),
			rows: await ctx.db
				.query('healthDataPoints')
				.withIndex('by_userId_and_dataType_and_recordTimestamp', (q) =>
					q.eq('userId', 'user-a').eq('dataType', 'steps')
				)
				.take(20)
		}));
		expect(stored.rows).toHaveLength(17);
		expect(stored.cursor).toMatchObject({ status: 'running' });
		expect(
			stored.scheduled.filter((job) => job.name === 'googleHealth/records:rebuildSummaryBatch')
		).toHaveLength(1);
	});

	it.each(['calories-in-heart-rate-zone', 'total-calories'] as const)(
		'walks %s daily rollups in one 14-day window starting at 2000-01-01',
		async (dataType) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
			const t = boundedConvexTest();
			const { cursorId } = await seedCursor(t, { dataType });
			let rollupBody: unknown;
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
					if (String(input) === 'https://oauth2.googleapis.com/token') return tokenResponse();
					rollupBody = JSON.parse(String(init?.body));
					return jsonResponse({ rollupDataPoints: [] });
				})
			);

			await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
			await pumpReady(t, 3);
			expect(rollupBody).toEqual({
				range: {
					start: { date: { year: 2000, month: 1, day: 1 } },
					end: { date: { year: 2000, month: 1, day: 15 } }
				},
				windowSizeDays: 1,
				pageSize: 1000
			});
			const stored = await t.run(async (ctx) => ({
				cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
				scheduled: await ctx.db.system.query('_scheduled_functions').take(10)
			}));
			expect(stored.cursor).toMatchObject({
				status: 'queued',
				windowStart: '2000-01-15',
				windowEnd: '2000-01-29'
			});
			expect(
				stored.scheduled.filter((job) => job.name === 'googleHealth/sync:runCursor')
			).toHaveLength(1);
		}
	);

	it.each([
		[
			'heart-rate',
			'2026-08-14T10:00:00Z',
			'2026-08-14T11:00:00Z',
			'heart_rate.sample_time.physical_time'
		],
		['daily-resting-heart-rate', '2026-08-14', '2026-08-15', 'daily_resting_heart_rate.date'],
		[
			'exercise',
			'2026-08-14T10:00:00',
			'2026-08-14T11:00:00',
			'exercise.interval.civil_start_time'
		],
		['sleep', '2026-08-14T10:00:00Z', '2026-08-14T11:00:00Z', 'sleep.interval.end_time']
	] as const)(
		'uses a closed-open %s incremental filter owned by the registry record kind',
		async (dataType, windowStart, windowEnd, filterField) => {
			vi.useFakeTimers();
			const t = boundedConvexTest();
			const { cursorId } = await seedCursor(t, {
				dataType,
				mode: 'incremental',
				status: 'active',
				windowStart,
				windowEnd
			});
			let healthUrl = '';
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: RequestInfo | URL) => {
					if (String(input) === 'https://oauth2.googleapis.com/token') return tokenResponse();
					healthUrl = String(input);
					return jsonResponse({ dataPoints: [] });
				})
			);

			await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'webhook' });
			const filter = new URL(healthUrl).searchParams.get('filter');
			expect(filter).toBe(`${filterField} >= "${windowStart}" AND ${filterField} < "${windowEnd}"`);
		}
	);

	it('uses the registry ECG one-sided physical-start filter without inventing an upper bound', async () => {
		const t = boundedConvexTest();
		const { cursorId } = await seedCursor(t, {
			dataType: 'electrocardiogram',
			mode: 'incremental',
			status: 'active',
			windowStart: '2026-08-14T10:00:00Z',
			windowEnd: '2026-08-14T11:00:00Z'
		});
		let healthUrl = '';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input) === 'https://oauth2.googleapis.com/token') return tokenResponse();
				healthUrl = String(input);
				return jsonResponse({ dataPoints: [] });
			})
		);
		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'webhook' });
		expect(new URL(healthUrl).searchParams.get('filter')).toBe(
			'electrocardiogram.interval.start_time >= "2026-08-14T10:00:00Z"'
		);
	});

	it('falls back to an unbounded no-cleanup request when cursor bounds use an unsupported clock', async () => {
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, {
			dataType: 'exercise',
			mode: 'incremental',
			status: 'active',
			windowStart: '2026-08-14T10:00:00Z',
			windowEnd: '2026-08-14T11:00:00Z'
		});
		let healthUrl = '';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input) === 'https://oauth2.googleapis.com/token') return tokenResponse();
				healthUrl = String(input);
				return jsonResponse({ dataPoints: [] });
			})
		);
		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'webhook' });
		expect(new URL(healthUrl).searchParams.has('filter')).toBe(false);
		expect(
			(await t.run(async (ctx) => ctx.db.system.query('_scheduled_functions').take(10))).some(
				(job) => job.name === 'googleHealth/records:cleanupCoveredRange'
			)
		).toBe(false);
		expect(
			(await t.run(async (ctx) => ctx.db.get('googleHealthConnections', connectionId)))?.status
		).toBe('backfilling');
	});

	it('rotates an old envelope and atomically persists a replacement refresh token', async () => {
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, {
			dataType: 'steps',
			key: PREVIOUS_KEY,
			keyVersion: 'v1',
			refreshToken: 'old-refresh-token'
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input) === 'https://oauth2.googleapis.com/token'
					? tokenResponse({ refresh_token: 'replacement-refresh-token' })
					: jsonResponse({ dataPoints: [] })
			)
		);

		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
		const stored = await t.run(async (ctx) => ctx.db.get('googleHealthConnections', connectionId));
		if (
			!stored?.encryptedRefreshToken ||
			!stored.tokenNonce ||
			!stored.tokenTag ||
			!stored.tokenKeyVersion
		) {
			throw new Error('Missing stored envelope');
		}
		expect(stored.tokenKeyVersion).toBe('v2');
		const decrypted = await decryptRefreshToken(
			{
				encryptedRefreshToken: stored.encryptedRefreshToken,
				tokenNonce: stored.tokenNonce,
				tokenTag: stored.tokenTag,
				tokenKeyVersion: stored.tokenKeyVersion
			},
			'user-a',
			createTokenKeyring(ACTIVE_KEY, 'v2', JSON.stringify({ v1: PREVIOUS_KEY }))
		);
		expect(decrypted.refreshToken).toBe('replacement-refresh-token');
	});

	it('CAS-persists the refreshed granted-scope set even without a replacement refresh token', async () => {
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, { dataType: 'steps' });
		const stepsScope = getMetricDefinition('steps')!.scope;
		const sleepScope = getMetricDefinition('sleep')!.scope;
		await t.run(async (ctx) =>
			ctx.db.patch('googleHealthConnections', connectionId, {
				grantedScopes: [stepsScope, sleepScope]
			})
		);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input) === 'https://oauth2.googleapis.com/token'
					? tokenResponse({ scope: stepsScope })
					: jsonResponse({ dataPoints: [] })
			)
		);
		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
		expect(
			(await t.run(async (ctx) => ctx.db.get('googleHealthConnections', connectionId)))
				?.grantedScopes
		).toEqual([stepsScope]);
	});

	it('guards stale generations and inactive connections before any network request', async () => {
		const cases = [
			{ generation: 2, invocationGeneration: 1, status: 'backfilling' as const },
			{ generation: 1, invocationGeneration: 1, status: 'disconnected' as const }
		];
		for (const testCase of cases) {
			const t = boundedConvexTest();
			const { cursorId } = await seedCursor(t, {
				dataType: 'steps',
				generation: testCase.generation,
				status: testCase.status
			});
			const fetchMock = vi.fn();
			vi.stubGlobal('fetch', fetchMock);
			await runCurrentCursor(t, {
				cursorId,
				generation: testCase.invocationGeneration,
				trigger: 'oauth'
			});
			expect(fetchMock).not.toHaveBeenCalled();
			vi.unstubAllGlobals();
		}
	});

	it('uses bounded jittered exponential retry and stops invalid grants for user action', async () => {
		expect(computeRetryDelayMs(0, () => 0)).toBe(24_000);
		expect(computeRetryDelayMs(0, () => 0.5)).toBe(30_000);
		expect(computeRetryDelayMs(20, () => 1)).toBe(25_920_000);

		for (const [status, errorCode, expectedStatus] of [
			[429, 'rate_limited', 'delayed'],
			[503, 'unavailable', 'delayed'],
			[400, 'invalid_grant', 'action_required']
		] as const) {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
			const t = boundedConvexTest();
			const { connectionId, cursorId } = await seedCursor(t, { dataType: 'steps' });
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => jsonResponse({ error: errorCode }, status))
			);
			await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
			const stored = await t.run(async (ctx) => ({
				connection: await ctx.db.get('googleHealthConnections', connectionId),
				cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
				scheduled: await ctx.db.system.query('_scheduled_functions').take(10)
			}));
			expect(stored.connection?.status).toBe(expectedStatus);
			if (expectedStatus === 'delayed') {
				expect(stored.cursor?.status).toBe('retry');
				expect(stored.connection?.nextRetryAt).toEqual(expect.any(Number));
				expect(
					stored.scheduled.filter((job) => job.name === 'googleHealth/sync:runCursor')
				).toHaveLength(1);
			} else {
				expect(
					stored.scheduled.filter((job) => job.name === 'googleHealth/sync:runCursor')
				).toEqual([]);
			}
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it('classifies a network interruption as retryable without exposing token material', async () => {
		vi.useFakeTimers();
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, { dataType: 'steps' });
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('transport failed near stored-refresh-token');
			})
		);

		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
		const stored = await t.run(async (ctx) => ({
			connection: await ctx.db.get('googleHealthConnections', connectionId),
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			runs: await ctx.db
				.query('googleHealthSyncRuns')
				.withIndex('by_connectionId_and_startedAt', (q) => q.eq('connectionId', connectionId))
				.take(10)
		}));
		expect(stored.connection).toMatchObject({ status: 'delayed', lastErrorCode: 'network_error' });
		expect(stored.cursor).toMatchObject({ status: 'retry', attempt: 1 });
		expect(stored.runs[0]).toMatchObject({ status: 'failed', errorCode: 'network_error' });
		expect(JSON.stringify(stored)).not.toContain('stored-refresh-token');
		expect(consoleSpy).not.toHaveBeenCalled();
	});

	it('passes daily-rollup page tokens in the body and reconciles missing civil days before advancing', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, {
			dataType: 'total-calories',
			pageToken: 'rollup-page-2',
			windowStart: '2000-01-01',
			windowEnd: '2000-01-15'
		});
		const staleId = await t.run(async (ctx) => {
			const dataPointId = await ctx.db.insert('healthDataPoints', {
				connectionId,
				userId: 'user-a',
				provider: 'google_health',
				recordKey: 'missing-rollup-day',
				dataType: 'total-calories',
				category: 'activity',
				recordTimestamp: Date.parse('2000-01-02T00:00:00Z'),
				localDate: '2000-01-02',
				civilCoverageTime: '2000-01-02',
				primaryValue: 50,
				primaryUnit: 'kcal',
				payloadDigest: 'old',
				payloadJson: '{}',
				lastSeenSyncId: 'old',
				seenEpoch: 0
			});
			await ctx.db.insert('healthDataPointContributions', {
				connectionId,
				dataPointId,
				userId: 'user-a',
				recordKey: 'missing-rollup-day',
				dataType: 'total-calories',
				category: 'activity',
				localDate: '2000-01-02',
				recordTimestamp: Date.parse('2000-01-02T00:00:00Z'),
				civilCoverageTime: '2000-01-02',
				primaryValue: 50,
				seenEpoch: 0
			});
			return dataPointId;
		});
		let body: Record<string, unknown> = {};
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (String(input) === 'https://oauth2.googleapis.com/token') return tokenResponse();
				body = JSON.parse(String(init?.body));
				return jsonResponse({ rollupDataPoints: [] });
			})
		);
		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
		expect(body).toMatchObject({ pageToken: 'rollup-page-2' });
		expect(
			(await t.run(async (ctx) => ctx.db.get('googleHealthSyncCursors', cursorId)))?.status
		).toBe('running');
		await pumpReady(t, 4);
		const stored = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			stale: await ctx.db.get('healthDataPoints', staleId)
		}));
		expect(stored.stale).toBeNull();
		expect(stored.cursor).toMatchObject({
			status: 'running',
			windowStart: '2000-01-15',
			windowEnd: '2000-01-29'
		});
	});

	it('keeps incremental continuations backfilling until every backfill type completes', async () => {
		vi.useFakeTimers();
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, {
			dataType: 'heart-rate',
			mode: 'incremental',
			status: 'active',
			windowStart: '2026-08-14T10:00:00Z',
			windowEnd: '2026-08-14T11:00:00Z',
			backfillTotalTypes: 2,
			backfillCompletedTypes: 0
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input) === 'https://oauth2.googleapis.com/token'
					? tokenResponse()
					: jsonResponse({ dataPoints: [], nextPageToken: 'next' })
			)
		);
		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'webhook' });
		await pumpReady(t);
		const stored = await t.run(async (ctx) => ({
			connection: await ctx.db.get('googleHealthConnections', connectionId),
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId)
		}));
		expect(stored.connection).toMatchObject({
			status: 'backfilling',
			backfillCompletedTypes: 0,
			backfillTotalTypes: 2
		});
		expect(stored.cursor).toMatchObject({ status: 'queued', pageToken: 'next' });
	});

	it('closes and same-generation requeues a run when token-envelope CAS is lost', async () => {
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, { dataType: 'steps' });
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input) !== 'https://oauth2.googleapis.com/token')
					throw new Error('health request must not start');
				await t.run(async (ctx) =>
					ctx.db.patch('googleHealthConnections', connectionId, {
						encryptedRefreshToken: 'raced-ciphertext'
					})
				);
				return tokenResponse();
			})
		);
		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
		const stored = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			runs: await ctx.db
				.query('googleHealthSyncRuns')
				.withIndex('by_connectionId_and_startedAt', (q) => q.eq('connectionId', connectionId))
				.take(10),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(10)
		}));
		expect(stored.cursor).toMatchObject({ status: 'queued' });
		expect(stored.runs[0]).toMatchObject({ status: 'failed', errorCode: 'token_cas_lost' });
		expect(
			stored.scheduled.filter((job) => job.name === 'googleHealth/sync:runCursor')
		).toHaveLength(1);
	});

	it('abandons but never requeues work after its connection generation becomes stale', async () => {
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, { dataType: 'steps' });
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input) !== 'https://oauth2.googleapis.com/token') {
					throw new Error('health request must not start');
				}
				await t.run(async (ctx) =>
					ctx.db.patch('googleHealthConnections', connectionId, { generation: 2 })
				);
				return tokenResponse();
			})
		);
		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
		const stored = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			runs: await ctx.db
				.query('googleHealthSyncRuns')
				.withIndex('by_connectionId_and_startedAt', (q) => q.eq('connectionId', connectionId))
				.take(10),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(10)
		}));
		expect(stored.cursor).toMatchObject({ status: 'retry', generation: 1 });
		expect(stored.cursor).not.toHaveProperty('activeRunId');
		expect(stored.runs[0]).toMatchObject({ status: 'failed', errorCode: 'token_cas_lost' });
		expect(stored.scheduled.filter((job) => job.name === 'googleHealth/sync:runCursor')).toEqual(
			[]
		);
	});

	it('guards and recovers a stale running lease without requeueing a different generation', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, { dataType: 'steps' });
		const work = await t.mutation(internal.googleHealth.sync.markCursorRunning, {
			cursorId,
			generation: 1,
			trigger: 'oauth',
			expectedDispatchVersion: 0
		});
		if (work === null) throw new Error('expected leased work');
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').take(10)
		);
		expect(scheduled.some((job) => job.name === 'googleHealth/sync:recoverStaleRun')).toBe(true);
		vi.advanceTimersByTime(5 * 60 * 1000);
		await t.finishInProgressScheduledFunctions();
		const recovered = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			run: await ctx.db.get('googleHealthSyncRuns', work.runId)
		}));
		expect(recovered.cursor).toMatchObject({ status: 'queued' });
		expect(recovered.run).toMatchObject({ status: 'failed', errorCode: 'stale_run_lease' });
		await t.run(async (ctx) =>
			ctx.db.patch('googleHealthConnections', connectionId, { generation: 2 })
		);
		expect(
			await t.mutation(internal.googleHealth.sync.recoverStaleRun, {
				cursorId,
				generation: 1,
				runId: work.runId,
				leaseExpiresAt: Date.parse('2026-08-14T12:05:00Z'),
				leaseVersion: work.leaseVersion
			})
		).toBe(false);
	});

	it('dispatches queued and unscheduled retry cursors while invalidating an older watchdog', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
		const t = boundedConvexTest();
		const { cursorId } = await seedCursor(t, {
			dataType: 'steps',
			status: 'active',
			backfillCompletedTypes: 1
		});
		expect(
			await t.mutation(internal.googleHealth.sync.ensureCursorDispatched, {
				cursorId,
				generation: 1,
				trigger: 'webhook'
			})
		).toBe(true);
		const queued = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(10)
		}));
		expect(queued.cursor).toMatchObject({ status: 'queued', dispatchVersion: 1 });
		expect(queued.scheduled.map((job) => job.name)).toEqual([
			'googleHealth/sync:runCursor',
			'googleHealth/sync:ensureCursorDispatched'
		]);

		const work = await t.mutation(internal.googleHealth.sync.markCursorRunning, {
			cursorId,
			generation: 1,
			trigger: 'webhook',
			expectedDispatchVersion: 1
		});
		if (work === null) throw new Error('expected leased work');
		expect(
			await t.mutation(internal.googleHealth.sync.failCursor, {
				cursorId,
				generation: 1,
				runId: work.runId,
				errorCode: 'malformed_request',
				actionRequired: false
			})
		).toBe(true);
		expect(
			await t.mutation(internal.googleHealth.sync.ensureCursorDispatched, {
				cursorId,
				generation: 1,
				trigger: 'webhook',
				expectedDispatchVersion: 1
			})
		).toBe(false);
		expect(
			await t.mutation(internal.googleHealth.sync.ensureCursorDispatched, {
				cursorId,
				generation: 1,
				trigger: 'webhook'
			})
		).toBe(true);
		const retry = await t.run(async (ctx) => ctx.db.get('googleHealthSyncCursors', cursorId));
		expect(retry).toMatchObject({ status: 'retry', dispatchVersion: 3 });
	});

	it('rejects a duplicate stale action without bypassing retry backoff', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, {
			dataType: 'steps',
			status: 'active',
			backfillCompletedTypes: 1
		});
		expect(
			await t.mutation(internal.googleHealth.sync.ensureCursorDispatched, {
				cursorId,
				generation: 1,
				trigger: 'webhook'
			})
		).toBe(true);

		let tokenRequests = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input) === 'https://oauth2.googleapis.com/token') {
					tokenRequests += 1;
					return tokenRequests === 1
						? jsonResponse({ error: 'unavailable' }, 503)
						: tokenResponse();
				}
				return jsonResponse({ dataPoints: [] });
			})
		);

		const duplicateAction = {
			cursorId,
			generation: 1,
			trigger: 'webhook' as const,
			expectedDispatchVersion: 1
		};
		await t.action(runCursor, duplicateAction);
		const afterFailure = await t.run(async (ctx) => ({
			connection: await ctx.db.get('googleHealthConnections', connectionId),
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			runs: await ctx.db
				.query('googleHealthSyncRuns')
				.withIndex('by_cursorId', (q) => q.eq('cursorId', cursorId))
				.take(10),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(20)
		}));
		expect(afterFailure.connection?.nextRetryAt).toBe(Date.parse('2026-08-14T12:00:30Z'));
		expect(afterFailure.cursor).toMatchObject({ status: 'retry', dispatchVersion: 3 });
		expect(afterFailure.runs).toHaveLength(1);

		await t.action(runCursor, duplicateAction);
		const afterDuplicate = await t.run(async (ctx) => ({
			runs: await ctx.db
				.query('googleHealthSyncRuns')
				.withIndex('by_cursorId', (q) => q.eq('cursorId', cursorId))
				.take(10),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(20)
		}));
		expect(tokenRequests).toBe(1);
		expect(afterDuplicate.runs).toHaveLength(1);
		expect(afterDuplicate.scheduled).toEqual(afterFailure.scheduled);

		await t.action(runCursor, {
			...duplicateAction,
			expectedDispatchVersion: 3
		});
		expect(tokenRequests).toBe(1);
		const beforeRetry = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(20)
		}));
		expect(beforeRetry.cursor).toMatchObject({ status: 'retry', dispatchVersion: 3 });
		expect(beforeRetry.scheduled).toEqual(afterDuplicate.scheduled);
		vi.setSystemTime(new Date('2026-08-14T12:00:30.001Z'));
		await t.action(runCursor, {
			...duplicateAction,
			expectedDispatchVersion: 3
		});
		expect(tokenRequests).toBe(2);
	});

	it('renews a healthy run with an exact lease version so an older watchdog cannot recover it', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
		const t = boundedConvexTest();
		const { cursorId } = await seedCursor(t, { dataType: 'steps' });
		const work = await t.mutation(internal.googleHealth.sync.markCursorRunning, {
			cursorId,
			generation: 1,
			trigger: 'oauth',
			expectedDispatchVersion: 0
		});
		if (work === null) throw new Error('expected leased work');
		const oldExpiry = Date.parse('2026-08-14T12:05:00Z');
		vi.setSystemTime(new Date('2026-08-14T12:06:00Z'));
		const renewed = await t.mutation(internal.googleHealth.sync.renewRunLease, {
			cursorId,
			generation: 1,
			runId: work.runId,
			expectedLeaseVersion: work.leaseVersion
		});
		expect(renewed).toEqual({
			leaseVersion: work.leaseVersion + 1,
			leaseExpiresAt: Date.parse('2026-08-14T12:11:00Z')
		});
		expect(
			await t.mutation(internal.googleHealth.sync.recoverStaleRun, {
				cursorId,
				generation: 1,
				runId: work.runId,
				leaseExpiresAt: oldExpiry,
				leaseVersion: work.leaseVersion
			})
		).toBe(false);
		vi.setSystemTime(new Date('2026-08-14T12:11:00Z'));
		expect(
			await t.mutation(internal.googleHealth.sync.recoverStaleRun, {
				cursorId,
				generation: 1,
				runId: work.runId,
				leaseExpiresAt: renewed?.leaseExpiresAt ?? 0,
				leaseVersion: renewed?.leaseVersion ?? 0
			})
		).toBe(true);
	});

	it('serializes overlapping backfill and incremental cursors per connection without stranding the waiter', async () => {
		const t = boundedConvexTest();
		const { connectionId, cursorId: backfillCursorId } = await seedCursor(t, {
			dataType: 'steps'
		});
		const incrementalCursorId = await t.run(async (ctx) =>
			ctx.db.insert('googleHealthSyncCursors', {
				connectionId,
				userId: 'user-a',
				dataType: 'steps',
				mode: 'incremental',
				status: 'queued',
				syncId: 'incremental-1',
				attempt: 0,
				generation: 1,
				updatedAt: Date.now()
			})
		);
		const first = await t.mutation(internal.googleHealth.sync.markCursorRunning, {
			cursorId: backfillCursorId,
			generation: 1,
			trigger: 'oauth',
			expectedDispatchVersion: 0
		});
		const second = await t.mutation(internal.googleHealth.sync.markCursorRunning, {
			cursorId: incrementalCursorId,
			generation: 1,
			trigger: 'webhook',
			expectedDispatchVersion: 0
		});
		expect(first?.reconciliationEpoch).toBe(1);
		expect(second).toBeNull();
		expect(
			(await t.run(async (ctx) => ctx.db.get('googleHealthConnections', connectionId)))
				?.reconciliationEpoch
		).toBe(1);
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').take(10)
		);
		expect(
			scheduled.filter(
				(job) =>
					job.name === 'googleHealth/sync:runCursor' &&
					job.args[0]?.cursorId === incrementalCursorId
			)
		).toHaveLength(1);
	});

	it('validates run cursor, generation, and connection ownership before abandoning anything', async () => {
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, { dataType: 'steps' });
		const active = await t.mutation(internal.googleHealth.sync.markCursorRunning, {
			cursorId,
			generation: 1,
			trigger: 'oauth',
			expectedDispatchVersion: 0
		});
		if (active === null) throw new Error('expected active run');
		const unrelatedRunId = await t.run(async (ctx) =>
			ctx.db.insert('googleHealthSyncRuns', {
				connectionId,
				userId: 'user-a',
				generation: 1,
				reconciliationEpoch: 99,
				trigger: 'manual',
				dataType: 'steps',
				startedAt: Date.now(),
				pages: 0,
				fetched: 0,
				inserted: 0,
				updated: 0,
				deleted: 0,
				skipped: 0,
				status: 'running'
			})
		);
		expect(
			await t.mutation(internal.googleHealth.sync.abandonRun, {
				cursorId,
				generation: 1,
				runId: unrelatedRunId,
				errorCode: 'wrong_run'
			})
		).toBe(false);
		const stored = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			connection: await ctx.db.get('googleHealthConnections', connectionId),
			activeRun: await ctx.db.get('googleHealthSyncRuns', active.runId),
			unrelatedRun: await ctx.db.get('googleHealthSyncRuns', unrelatedRunId)
		}));
		expect(stored.cursor).toMatchObject({ status: 'running', activeRunId: active.runId });
		expect(stored.connection).toMatchObject({ activeSyncRunId: active.runId });
		expect(stored.activeRun).toMatchObject({ status: 'running' });
		expect(stored.unrelatedRun).toMatchObject({ status: 'running' });
	});

	it('closes an active old-generation run when cursor initialization replaces its generation', async () => {
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, { dataType: 'steps' });
		const work = await t.mutation(internal.googleHealth.sync.markCursorRunning, {
			cursorId,
			generation: 1,
			trigger: 'oauth',
			expectedDispatchVersion: 0
		});
		if (work === null) throw new Error('expected active old-generation run');
		await t.run(async (ctx) =>
			ctx.db.patch('googleHealthConnections', connectionId, { generation: 2 })
		);
		await t.mutation(internal.googleHealth.model.initializeCursors, { connectionId });
		const stored = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			run: await ctx.db.get('googleHealthSyncRuns', work.runId)
		}));
		expect(stored.cursor).toMatchObject({ status: 'queued', generation: 2 });
		expect(stored.cursor).not.toHaveProperty('activeRunId');
		expect(stored.run).toMatchObject({ status: 'failed', errorCode: 'stale_generation' });
	});

	it('leaves a non-retryable malformed page in terminal manual-recovery state without a hot loop', async () => {
		vi.useFakeTimers();
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, { dataType: 'steps' });
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input) === 'https://oauth2.googleapis.com/token'
					? tokenResponse()
					: jsonResponse({ dataPoints: {} })
			)
		);
		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
		const stored = await t.run(async (ctx) => ({
			connection: await ctx.db.get('googleHealthConnections', connectionId),
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(10)
		}));
		expect(stored.connection).toMatchObject({
			status: 'delayed',
			lastErrorCode: 'invalid_response'
		});
		expect(stored.cursor).toMatchObject({ status: 'retry', attempt: 1 });
		expect(
			stored.scheduled.filter((job) => job.name === 'googleHealth/sync:runCursor')
		).toHaveLength(0);
		expect(stored.connection?.nextRetryAt).toBeUndefined();
	});

	it('imports valid siblings and suppresses omission cleanup when one response point is malformed', async () => {
		vi.useFakeTimers();
		const t = boundedConvexTest();
		const start = '2026-08-14T10:00:00Z';
		const end = '2026-08-14T11:00:00Z';
		const { connectionId, cursorId } = await seedCursor(t, {
			dataType: 'steps',
			mode: 'incremental',
			status: 'active',
			windowStart: start,
			windowEnd: end
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('healthDataPoints', {
				connectionId,
				userId: 'user-a',
				provider: 'google_health',
				recordKey: 'stale-but-protected',
				dataType: 'steps',
				category: 'activity',
				recordTimestamp: Date.parse(start) + 1,
				startTime: Date.parse(start) + 1,
				endTime: Date.parse(start) + 1000,
				localDate: '2026-08-14',
				primaryValue: 5,
				primaryUnit: 'steps',
				payloadDigest: 'old-digest',
				payloadJson: '{"steps":{"count":5}}',
				lastSeenSyncId: 'older-sync'
			});
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input) === 'https://oauth2.googleapis.com/token'
					? tokenResponse()
					: jsonResponse({
							dataPoints: [
								{
									steps: {
										interval: { startTime: start, endTime: end },
										count: 42
									}
								},
								{ steps: { count: 99 } }
							]
						})
			)
		);

		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'webhook' });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const stored = await t.run(async (ctx) => ({
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			points: await ctx.db
				.query('healthDataPoints')
				.withIndex('by_connectionId', (q) => q.eq('connectionId', connectionId))
				.take(10),
			runs: await ctx.db
				.query('googleHealthSyncRuns')
				.withIndex('by_connectionId_and_startedAt', (q) => q.eq('connectionId', connectionId))
				.take(10)
		}));
		expect(stored.cursor).toMatchObject({ status: 'complete' });
		expect(stored.points).toHaveLength(2);
		expect(stored.points.map((row) => row.recordKey)).toContain('stale-but-protected');
		expect(stored.runs[0]).toMatchObject({ status: 'succeeded', fetched: 2, skipped: 1 });
	});

	it('does not emit malformed-record warning telemetry for an idempotent duplicate skip', async () => {
		vi.useFakeTimers();
		const t = boundedConvexTest();
		const { connectionId, cursorId } = await seedCursor(t, { dataType: 'steps' });
		const duplicate = {
			steps: {
				interval: {
					startTime: '2026-08-14T10:00:00Z',
					endTime: '2026-08-14T10:01:00Z'
				},
				count: 10
			}
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input) === 'https://oauth2.googleapis.com/token'
					? tokenResponse()
					: jsonResponse({ dataPoints: [duplicate, duplicate] })
			)
		);
		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'oauth' });
		await pumpReady(t, 4);
		const stored = await t.run(async (ctx) => ({
			run: (
				await ctx.db
					.query('googleHealthSyncRuns')
					.withIndex('by_connectionId_and_startedAt', (q) => q.eq('connectionId', connectionId))
					.take(10)
			)[0],
			points: await ctx.db
				.query('healthDataPoints')
				.withIndex('by_connectionId', (q) => q.eq('connectionId', connectionId))
				.take(10)
		}));
		expect(stored.points).toHaveLength(1);
		expect(stored.run).toMatchObject({ status: 'succeeded', skipped: 1 });
		expect(stored.run?.errorCode).toBeUndefined();
		expect(stored.run?.errorMessage).toBeUndefined();
	});

	it('carries malformed state across network pages and suppresses cleanup for the whole covered unit', async () => {
		vi.useFakeTimers();
		const t = boundedConvexTest();
		const start = '2026-08-14T10:00:00Z';
		const end = '2026-08-14T11:00:00Z';
		const { connectionId, cursorId } = await seedCursor(t, {
			dataType: 'steps',
			mode: 'incremental',
			status: 'active',
			windowStart: start,
			windowEnd: end
		});
		const staleId = await t.run(async (ctx) => {
			const dataPointId = await ctx.db.insert('healthDataPoints', {
				connectionId,
				userId: 'user-a',
				provider: 'google_health',
				recordKey: 'omitted-across-pages',
				dataType: 'steps',
				category: 'activity',
				recordTimestamp: Date.parse(start) + 1,
				localDate: '2026-08-14',
				physicalCoverageKey: '2026-08-14T10:00:00.000000001Z',
				primaryValue: 5,
				primaryUnit: 'steps',
				payloadDigest: 'old',
				payloadJson: '{}',
				lastSeenSyncId: 'old',
				seenEpoch: 0
			});
			await ctx.db.insert('healthDataPointContributions', {
				connectionId,
				dataPointId,
				userId: 'user-a',
				recordKey: 'omitted-across-pages',
				dataType: 'steps',
				category: 'activity',
				localDate: '2026-08-14',
				recordTimestamp: Date.parse(start) + 1,
				primaryValue: 5,
				physicalCoverageKey: '2026-08-14T10:00:00.000000001Z',
				seenEpoch: 0
			});
			return dataPointId;
		});
		let page = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				if (String(input) === 'https://oauth2.googleapis.com/token') return tokenResponse();
				page += 1;
				return jsonResponse(
					page === 1
						? {
								dataPoints: [
									{
										steps: {
											interval: { startTime: start, endTime: end },
											count: 10
										}
									},
									{ steps: { count: 99 } }
								],
								nextPageToken: 'page-2'
							}
						: {
								dataPoints: [
									{
										steps: {
											interval: {
												startTime: '2026-08-14T10:30:00Z',
												endTime: '2026-08-14T10:31:00Z'
											},
											count: 20
										}
									}
								]
							}
				);
			})
		);
		await runCurrentCursor(t, { cursorId, generation: 1, trigger: 'webhook' });
		expect(
			await t.run(async (ctx) => ctx.db.get('googleHealthSyncCursors', cursorId))
		).toMatchObject({ status: 'running', hadMalformed: true });
		await pumpReady(t, 4);
		expect(page).toBe(2);
		const pendingCleanup = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').take(50)).filter(
				(job) => job.name === 'googleHealth/records:cleanupCoveredRange'
			)
		);
		expect(pendingCleanup).toHaveLength(0);
		await pumpReady(t, 4);
		const stored = await t.run(async (ctx) => ({
			stale: await ctx.db.get('healthDataPoints', staleId),
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			runs: await ctx.db
				.query('googleHealthSyncRuns')
				.withIndex('by_connectionId_and_startedAt', (q) => q.eq('connectionId', connectionId))
				.take(10)
		}));
		expect(stored.stale).not.toBeNull();
		expect(stored.cursor).toMatchObject({ status: 'complete', hadMalformed: false });
		expect(stored.runs).toHaveLength(2);
		for (const run of stored.runs)
			expect(run).toMatchObject({
				status: 'succeeded',
				errorCode: 'warning_skipped_records',
				errorMessage: 'Some Google Health records could not be imported'
			});
	});
});
