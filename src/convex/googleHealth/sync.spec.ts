/// <reference types="vite/client" />

import { type FunctionReference, makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../_generated/dataModel';
import schema from '../schema';
import { createTokenKeyring, decryptRefreshToken, encryptRefreshToken } from './crypto';
import { GOOGLE_HEALTH_READ_SCOPES, getMetricDefinition } from './registry';
import { computeRetryDelayMs } from './sync';
import type { SyncTrigger } from './validators';

const modules = import.meta.glob('/src/convex/**/*.*s');
const ACTIVE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const PREVIOUS_KEY = 'Hh8cHRobGBkWFxQVEhMQEQ4PDA0KCwgJBgUEAwIBAAA=';

type RunCursorArgs = {
	cursorId: Id<'googleHealthSyncCursors'>;
	generation: number;
	trigger: SyncTrigger;
};

const runCursor = makeFunctionReference<'action', RunCursorArgs, null>(
	'googleHealth/sync:runCursor'
) as unknown as FunctionReference<'action', 'internal', RunCursorArgs, null>;

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
			backfillTotalTypes: 1,
			backfillCompletedTypes: 0
		});
		const cursorId = await ctx.db.insert('googleHealthSyncCursors', {
			connectionId,
			userId,
			dataType: args.dataType,
			mode: args.mode ?? 'backfill',
			status: 'queued',
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
		const t = convexTest(schema, modules);
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

		await t.action(runCursor, { cursorId, generation: 1, trigger: 'oauth' });
		expect(page).toBe(1);
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
		expect(afterFirst.cursor).toMatchObject({ status: 'queued', pageToken: 'page-2' });
		expect(afterFirst.points).toHaveLength(1);
		expect(afterFirst.scheduled).toHaveLength(1);
		expect(afterFirst.scheduled[0].name).toBe('googleHealth/sync:runCursor');

		await t.finishAllScheduledFunctions(vi.runAllTimers);
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
		const t = convexTest(schema, modules);
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

		await t.action(runCursor, { cursorId, generation: 1, trigger: 'oauth' });
		expect(urls).toHaveLength(1);
		const request = new URL(urls[0]);
		expect(request.searchParams.get('pageSize')).toBe(String(pageSize));
		expect(request.searchParams.has('filter')).toBe(false);
		expect(request.pathname.endsWith(':reconcile')).toBe(dataType !== 'food');
	});

	it.each(['calories-in-heart-rate-zone', 'total-calories'] as const)(
		'walks %s daily rollups in one 14-day window starting at 2000-01-01',
		async (dataType) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
			const t = convexTest(schema, modules);
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

			await t.action(runCursor, { cursorId, generation: 1, trigger: 'oauth' });
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
			expect(stored.scheduled).toHaveLength(1);
		}
	);

	it.each([
		[
			'heart-rate',
			'2026-08-14T10:00:00Z',
			'2026-08-14T11:00:00Z',
			'heart_rate.sample_time.physical_time'
		],
		['daily-resting-heart-rate', '2026-08-14', '2026-08-15', 'daily_resting_heart_rate.date']
	] as const)(
		'uses a closed-open %s incremental filter owned by the registry record kind',
		async (dataType, windowStart, windowEnd, filterField) => {
			vi.useFakeTimers();
			const t = convexTest(schema, modules);
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

			await t.action(runCursor, { cursorId, generation: 1, trigger: 'webhook' });
			const filter = new URL(healthUrl).searchParams.get('filter');
			expect(filter).toBe(`${filterField} >= "${windowStart}" AND ${filterField} < "${windowEnd}"`);
		}
	);

	it('rotates an old envelope and atomically persists a replacement refresh token', async () => {
		const t = convexTest(schema, modules);
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

		await t.action(runCursor, { cursorId, generation: 1, trigger: 'oauth' });
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

	it('guards stale generations and inactive connections before any network request', async () => {
		const cases = [
			{ generation: 2, invocationGeneration: 1, status: 'backfilling' as const },
			{ generation: 1, invocationGeneration: 1, status: 'disconnected' as const }
		];
		for (const testCase of cases) {
			const t = convexTest(schema, modules);
			const { cursorId } = await seedCursor(t, {
				dataType: 'steps',
				generation: testCase.generation,
				status: testCase.status
			});
			const fetchMock = vi.fn();
			vi.stubGlobal('fetch', fetchMock);
			await t.action(runCursor, {
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
			const t = convexTest(schema, modules);
			const { connectionId, cursorId } = await seedCursor(t, { dataType: 'steps' });
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => jsonResponse({ error: errorCode }, status))
			);
			await t.action(runCursor, { cursorId, generation: 1, trigger: 'oauth' });
			const stored = await t.run(async (ctx) => ({
				connection: await ctx.db.get('googleHealthConnections', connectionId),
				cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
				scheduled: await ctx.db.system.query('_scheduled_functions').take(10)
			}));
			expect(stored.connection?.status).toBe(expectedStatus);
			if (expectedStatus === 'delayed') {
				expect(stored.cursor?.status).toBe('retry');
				expect(stored.connection?.nextRetryAt).toEqual(expect.any(Number));
				expect(stored.scheduled).toHaveLength(1);
			} else {
				expect(stored.scheduled).toEqual([]);
			}
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it('classifies a network interruption as retryable without exposing token material', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const { connectionId, cursorId } = await seedCursor(t, { dataType: 'steps' });
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('transport failed near stored-refresh-token');
			})
		);

		await t.action(runCursor, { cursorId, generation: 1, trigger: 'oauth' });
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
});
