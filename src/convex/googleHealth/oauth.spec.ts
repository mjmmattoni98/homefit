/// <reference types="vite/client" />

import { type FunctionReference, makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { GOOGLE_HEALTH_READ_SCOPES, METRIC_DEFINITIONS } from './registry';

const modules = import.meta.glob('/src/convex/**/*.*s');
const APP_URL = 'https://homefit.example';
const REDIRECT_URI = 'https://example.convex.site/google-health/oauth/callback';
const ACTIVE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

function actionReference<
	Visibility extends 'public' | 'internal',
	Args extends Record<string, unknown>,
	Return
>(name: string): FunctionReference<'action', Visibility, Args, Return> {
	return makeFunctionReference<'action', Args, Return>(name) as unknown as FunctionReference<
		'action',
		Visibility,
		Args,
		Return
	>;
}

const beginConnection = actionReference<
	'public',
	{ returnPath: string },
	{ authorizationUrl: string }
>('googleHealth/oauth:beginConnection');
const deleteImportedData = actionReference<
	'public',
	{ confirmation: string },
	{ status: 'deleting' }
>('googleHealth/account:deleteImportedData');

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function expectPrivateRedirect(response: Response, location: string): void {
	expect(response.status).toBe(302);
	expect(response.headers.get('location')).toBe(location);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}

async function sha256Base64Url(value: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
	);
	let binary = '';
	for (const byte of digest) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function installEnvironment(): void {
	vi.stubEnv('GOOGLE_HEALTH_CLIENT_ID', 'google-client-id.apps.googleusercontent.com');
	vi.stubEnv('GOOGLE_HEALTH_CLIENT_SECRET', 'google-client-secret');
	vi.stubEnv('GOOGLE_HEALTH_REDIRECT_URI', REDIRECT_URI);
	vi.stubEnv('HOMEFIT_APP_URL', APP_URL);
	vi.stubEnv('GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY', ACTIVE_KEY);
	vi.stubEnv('GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION', 'v1');
	vi.stubEnv('GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS', '');
	vi.stubEnv('GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION', 'unused-in-oauth-tests');
}

describe('Google Health OAuth flow', () => {
	beforeEach(() => {
		installEnvironment();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('begins only for an authenticated user and stores a digest of 32 random state bytes', async () => {
		const t = convexTest(schema, modules);

		await expect(t.action(beginConnection, { returnPath: '/dashboard/import' })).rejects.toThrow(
			'Not authenticated'
		);
		const first = await t
			.withIdentity({ tokenIdentifier: 'clerk|user-a' })
			.action(beginConnection, { returnPath: '/dashboard/import' });
		const second = await t
			.withIdentity({ tokenIdentifier: 'clerk|user-a' })
			.action(beginConnection, { returnPath: '/dashboard/import' });
		const firstUrl = new URL(first.authorizationUrl);
		const secondUrl = new URL(second.authorizationUrl);
		const rawState = firstUrl.searchParams.get('state');

		expect(rawState).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(secondUrl.searchParams.get('state')).not.toBe(rawState);
		expect(firstUrl.searchParams.get('scope')?.split(' ')).toEqual(GOOGLE_HEALTH_READ_SCOPES);
		if (!rawState) throw new Error('Missing state fixture');
		const decodedState = Uint8Array.from(
			atob(rawState.replaceAll('-', '+').replaceAll('_', '/') + '='),
			(character) => character.charCodeAt(0)
		);
		expect(decodedState).toHaveLength(32);
		const stateDigest = await sha256Base64Url(rawState);

		const stored = await t.run(async (ctx) =>
			ctx.db
				.query('googleHealthOAuthStates')
				.withIndex('by_stateDigest', (q) => q.eq('stateDigest', stateDigest))
				.unique()
		);
		expect(stored).toMatchObject({
			userId: 'clerk|user-a',
			stateDigest,
			returnPath: '/dashboard/import'
		});
		expect(JSON.stringify(stored)).not.toContain(rawState);
	});

	it('rejects every return path except the exact application-owned import path', async () => {
		const t = convexTest(schema, modules).withIdentity({ tokenIdentifier: 'clerk|user-a' });

		for (const returnPath of [
			'https://attacker.example/dashboard/import',
			'//attacker.example',
			'/dashboard/import?next=https://attacker.example',
			'/dashboard/import/',
			'/dashboard'
		]) {
			await expect(t.action(beginConnection, { returnPath })).rejects.toThrow(
				'Invalid Google Health return path'
			);
		}
	});

	it('persists partial consent and initializes only the metrics covered by granted scopes', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
		const t = convexTest(schema, modules);
		const { authorizationUrl } = await t
			.withIdentity({ tokenIdentifier: 'clerk|user-a' })
			.action(beginConnection, { returnPath: '/dashboard/import' });
		const state = new URL(authorizationUrl).searchParams.get('state');
		if (!state) throw new Error('Missing state fixture');
		let tokenRequests = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://oauth2.googleapis.com/token') {
				tokenRequests += 1;
				return jsonResponse({
					access_token: 'ephemeral-access-token',
					...(tokenRequests === 1 ? { refresh_token: 'partial-refresh-token' } : {}),
					expires_in: 3600,
					...(tokenRequests === 1 ? { scope: GOOGLE_HEALTH_READ_SCOPES[6] } : {}),
					token_type: 'Bearer'
				});
			}
			if (url === 'https://health.googleapis.com/v4/users/me/identity') {
				return jsonResponse({ healthUserId: 'google-health-user-a' });
			}
			if (url.includes('/dataTypes/sleep/dataPoints:reconcile')) {
				return jsonResponse({ dataPoints: [] });
			}
			throw new Error(`Unexpected URL: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await t.fetch(
			`/google-health/oauth/callback?code=partial-code&state=${encodeURIComponent(state)}`
		);
		expectPrivateRedirect(response, `${APP_URL}/dashboard/import?googleHealth=connected`);
		const stored = await t.run(async (ctx) => {
			const connection = await ctx.db
				.query('googleHealthConnections')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|user-a'))
				.unique();
			if (!connection) throw new Error('Missing connection fixture');
			const cursors = await ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|user-a'))
				.take(10);
			const scheduled = await ctx.db.system.query('_scheduled_functions').take(10);
			return { connection, cursors, scheduled };
		});
		expect(stored.connection.grantedScopes).toEqual([GOOGLE_HEALTH_READ_SCOPES[6]]);
		expect(stored.connection.backfillTotalTypes).toBe(1);
		expect(stored.cursors.map((cursor) => cursor.dataType)).toEqual(['sleep']);
		expect(stored.scheduled).toHaveLength(1);
		expect(stored.scheduled[0].name).toBe('googleHealth/sync:ensureCursorDispatched');

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const completed = await t.run(async (ctx) => ({
			connection: await ctx.db.get('googleHealthConnections', stored.connection._id),
			cursor: await ctx.db.get('googleHealthSyncCursors', stored.cursors[0]._id)
		}));
		expect(completed.connection).toMatchObject({
			status: 'active',
			backfillCompletedTypes: 1
		});
		expect(completed.cursor).toMatchObject({ status: 'complete' });
	});

	it('completes through the callback, encrypts the token, and schedules the first of 40 cursors', async () => {
		const t = convexTest(schema, modules);
		const { authorizationUrl } = await t
			.withIdentity({ tokenIdentifier: 'clerk|user-a' })
			.action(beginConnection, { returnPath: '/dashboard/import' });
		const state = new URL(authorizationUrl).searchParams.get('state');
		if (!state) throw new Error('Missing state fixture');

		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://oauth2.googleapis.com/token') {
				return jsonResponse({
					access_token: 'ephemeral-access-token',
					refresh_token: 'refresh-token-that-must-be-encrypted',
					expires_in: 3600,
					scope: GOOGLE_HEALTH_READ_SCOPES.join(' '),
					token_type: 'Bearer'
				});
			}
			if (url === 'https://health.googleapis.com/v4/users/me/identity') {
				return jsonResponse({ healthUserId: 'google-health-user-a' });
			}
			throw new Error(`Unexpected test URL: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await t.fetch(
			`/google-health/oauth/callback?code=one-time-code&state=${encodeURIComponent(state)}`
		);
		expectPrivateRedirect(response, `${APP_URL}/dashboard/import?googleHealth=connected`);

		const stored = await t.run(async (ctx) => {
			const connection = await ctx.db
				.query('googleHealthConnections')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|user-a'))
				.unique();
			if (!connection) throw new Error('Missing connection fixture');
			const cursors = await ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|user-a'))
				.take(41);
			const scheduled = await ctx.db.system.query('_scheduled_functions').take(1);
			return { connection, cursors, scheduled };
		});

		expect(stored.connection).toMatchObject({
			userId: 'clerk|user-a',
			healthUserId: 'google-health-user-a',
			status: 'backfilling',
			grantedScopes: [...GOOGLE_HEALTH_READ_SCOPES],
			generation: 1,
			backfillTotalTypes: 40
		});
		expect(stored.connection.encryptedRefreshToken).not.toBe(
			'refresh-token-that-must-be-encrypted'
		);
		expect(JSON.stringify(stored.connection)).not.toContain('refresh-token-that-must-be-encrypted');
		expect(stored.cursors).toHaveLength(40);
		expect(stored.scheduled).toHaveLength(1);
		expect(stored.scheduled[0].name).toBe('googleHealth/sync:ensureCursorDispatched');
	});

	it('cannot recreate a deleted connection from an OAuth callback already in flight', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
		const t = convexTest(schema, modules);
		const userId = 'clerk|oauth-delete-race';
		await t.run(async (ctx) => {
			await ctx.db.insert('googleHealthConnections', {
				userId,
				healthUserId: 'old-google-health-user',
				status: 'active',
				grantedScopes: [],
				generation: 4,
				backfillTotalTypes: 0,
				backfillCompletedTypes: 0
			});
		});
		const { authorizationUrl } = await t
			.withIdentity({ tokenIdentifier: userId })
			.action(beginConnection, { returnPath: '/dashboard/import' });
		const staleState = new URL(authorizationUrl).searchParams.get('state');
		if (!staleState) throw new Error('Missing state fixture');

		let releaseFirstTokenResponse: (response: Response) => void = () => undefined;
		const firstTokenResponse = new Promise<Response>((resolve) => {
			releaseFirstTokenResponse = resolve;
		});
		let markFirstTokenRequestStarted: () => void = () => undefined;
		const firstTokenRequestStarted = new Promise<void>((resolve) => {
			markFirstTokenRequestStarted = resolve;
		});
		let tokenRequests = 0;
		const revocationRequests: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === 'https://oauth2.googleapis.com/token') {
				tokenRequests += 1;
				if (tokenRequests === 1) {
					markFirstTokenRequestStarted();
					return await firstTokenResponse;
				}
				return jsonResponse({
					access_token: 'fresh-access-token',
					refresh_token: 'fresh-refresh-token',
					expires_in: 3600,
					scope: GOOGLE_HEALTH_READ_SCOPES[0],
					token_type: 'Bearer'
				});
			}
			if (url === 'https://health.googleapis.com/v4/users/me/identity') {
				return jsonResponse({ healthUserId: 'new-google-health-user' });
			}
			if (url.startsWith('https://oauth2.googleapis.com/revoke?token=')) {
				revocationRequests.push(url);
				return new Response(null, { status: 200 });
			}
			throw new Error(`Unexpected test URL: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const staleCallback = t.fetch(
			`/google-health/oauth/callback?code=stale-code&state=${encodeURIComponent(staleState)}`
		);
		await firstTokenRequestStarted;
		await expect(
			t
				.withIdentity({ tokenIdentifier: userId })
				.action(deleteImportedData, { confirmation: 'DELETE GOOGLE DATA' })
		).resolves.toEqual({ status: 'deleting' });
		await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
		await expect(
			t.run(async (ctx) => ({
				connection: await ctx.db
					.query('googleHealthConnections')
					.withIndex('by_userId', (q) => q.eq('userId', userId))
					.unique(),
				states: await ctx.db
					.query('googleHealthOAuthStates')
					.withIndex('by_userId', (q) => q.eq('userId', userId))
					.take(1)
			}))
		).resolves.toEqual({ connection: null, states: [] });

		releaseFirstTokenResponse(
			jsonResponse({
				access_token: 'stale-access-token',
				refresh_token: 'stale-refresh-token-that-must-not-be-stored',
				expires_in: 3600,
				scope: GOOGLE_HEALTH_READ_SCOPES[0],
				token_type: 'Bearer'
			})
		);
		expectPrivateRedirect(await staleCallback, `${APP_URL}/dashboard/import?googleHealth=error`);
		const afterStaleCallback = await t.run(async (ctx) => ({
			connections: await ctx.db.query('googleHealthConnections').take(1),
			cursors: await ctx.db.query('googleHealthSyncCursors').take(1),
			states: await ctx.db.query('googleHealthOAuthStates').take(1)
		}));
		expect(afterStaleCallback).toEqual({ connections: [], cursors: [], states: [] });
		expect(JSON.stringify(afterStaleCallback)).not.toContain(
			'stale-refresh-token-that-must-not-be-stored'
		);
		expect(revocationRequests).toEqual([
			'https://oauth2.googleapis.com/revoke?token=stale-refresh-token-that-must-not-be-stored'
		]);

		const freshAuthorization = await t
			.withIdentity({ tokenIdentifier: userId })
			.action(beginConnection, { returnPath: '/dashboard/import' });
		const freshState = new URL(freshAuthorization.authorizationUrl).searchParams.get('state');
		if (!freshState) throw new Error('Missing fresh state fixture');
		const freshResponse = await t.fetch(
			`/google-health/oauth/callback?code=fresh-code&state=${encodeURIComponent(freshState)}`
		);
		expectPrivateRedirect(freshResponse, `${APP_URL}/dashboard/import?googleHealth=connected`);
		const reconnected = await t.run(async (ctx) => ({
			connection: await ctx.db
				.query('googleHealthConnections')
				.withIndex('by_userId', (q) => q.eq('userId', userId))
				.unique(),
			cursors: await ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_userId', (q) => q.eq('userId', userId))
				.take(METRIC_DEFINITIONS.length + 1),
			states: await ctx.db
				.query('googleHealthOAuthStates')
				.withIndex('by_userId', (q) => q.eq('userId', userId))
				.take(1)
		}));
		expect(reconnected.connection).toMatchObject({
			status: 'backfilling',
			generation: 1,
			healthUserId: 'new-google-health-user'
		});
		expect(reconnected.connection?.encryptedRefreshToken).not.toBe('fresh-refresh-token');
		expect(reconnected.cursors).toHaveLength(
			METRIC_DEFINITIONS.filter((definition) => definition.scope === GOOGLE_HEALTH_READ_SCOPES[0])
				.length
		);
		expect(reconnected.states).toEqual([]);
	});

	it('rejects a location-only grant before requesting a Health identity', async () => {
		const t = convexTest(schema, modules);
		const { authorizationUrl } = await t
			.withIdentity({ tokenIdentifier: 'clerk|user-a' })
			.action(beginConnection, { returnPath: '/dashboard/import' });
		const state = new URL(authorizationUrl).searchParams.get('state');
		if (!state) throw new Error('Missing state fixture');
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				access_token: 'access-token',
				refresh_token: 'refresh-token',
				expires_in: 3600,
				scope: GOOGLE_HEALTH_READ_SCOPES[4],
				token_type: 'Bearer'
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const response = await t.fetch(
			`/google-health/oauth/callback?code=one-time-code&state=${encodeURIComponent(state)}`
		);
		expectPrivateRedirect(response, `${APP_URL}/dashboard/import?googleHealth=error`);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const connection = await t.run(async (ctx) =>
			ctx.db
				.query('googleHealthConnections')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|user-a'))
				.unique()
		);
		expect(connection).toBeNull();
	});

	it('marks a saved connection delayed when cursor initialization rolls back', async () => {
		const t = convexTest({
			schema,
			modules,
			transactionLimits: { documentsWritten: 2 }
		});
		const { authorizationUrl } = await t
			.withIdentity({ tokenIdentifier: 'clerk|user-a' })
			.action(beginConnection, { returnPath: '/dashboard/import' });
		const state = new URL(authorizationUrl).searchParams.get('state');
		if (!state) throw new Error('Missing state fixture');
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) =>
				String(input) === 'https://oauth2.googleapis.com/token'
					? jsonResponse({
							access_token: 'access-token',
							refresh_token: 'refresh-token',
							expires_in: 3600,
							scope: GOOGLE_HEALTH_READ_SCOPES.join(' '),
							token_type: 'Bearer'
						})
					: jsonResponse({ healthUserId: 'google-health-user-a' })
			)
		);

		const response = await t.fetch(
			`/google-health/oauth/callback?code=one-time-code&state=${encodeURIComponent(state)}`
		);
		expectPrivateRedirect(response, `${APP_URL}/dashboard/import?googleHealth=error`);
		const stored = await t.run(async (ctx) => {
			const connection = await ctx.db
				.query('googleHealthConnections')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|user-a'))
				.unique();
			const cursors = await ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|user-a'))
				.take(1);
			return { connection, cursors };
		});
		expect(stored.connection).toMatchObject({
			status: 'delayed',
			generation: 1,
			lastErrorCode: 'cursor_initialization_failed',
			lastErrorMessage: 'Google Health is temporarily unavailable'
		});
		expect(stored.cursors).toEqual([]);
	});

	it('accepts partial consent but requires a refresh token and at least one approved scope', async () => {
		const cases = [
			{
				response: {
					access_token: 'access-token',
					expires_in: 3600,
					scope: GOOGLE_HEALTH_READ_SCOPES[6],
					token_type: 'Bearer'
				}
			},
			{
				response: {
					access_token: 'access-token',
					refresh_token: 'refresh-token',
					expires_in: 3600,
					scope: 'https://www.googleapis.com/auth/unrelated.readonly',
					token_type: 'Bearer'
				}
			}
		];

		for (const testCase of cases) {
			const t = convexTest(schema, modules);
			const { authorizationUrl } = await t
				.withIdentity({ tokenIdentifier: 'clerk|user-a' })
				.action(beginConnection, { returnPath: '/dashboard/import' });
			const state = new URL(authorizationUrl).searchParams.get('state');
			if (!state) throw new Error('Missing state fixture');
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => jsonResponse(testCase.response))
			);

			const response = await t.fetch(
				`/google-health/oauth/callback?code=one-time-code&state=${encodeURIComponent(state)}`
			);
			expectPrivateRedirect(response, `${APP_URL}/dashboard/import?googleHealth=error`);
			const connection = await t.run(async (ctx) =>
				ctx.db
					.query('googleHealthConnections')
					.withIndex('by_userId', (q) => q.eq('userId', 'clerk|user-a'))
					.unique()
			);
			expect(connection).toBeNull();

			const stateDigest = await sha256Base64Url(state);
			const stateRecord = await t.run(async (ctx) =>
				ctx.db
					.query('googleHealthOAuthStates')
					.withIndex('by_stateDigest', (q) => q.eq('stateDigest', stateDigest))
					.unique()
			);
			expect(stateRecord?.consumedAt).toEqual(expect.any(Number));
			vi.unstubAllGlobals();
		}
	});

	it('uses only fixed callback redirects and rejects missing, duplicate, malformed, and replayed state', async () => {
		const t = convexTest(schema, modules);
		const errorLocation = `${APP_URL}/dashboard/import?googleHealth=error`;

		for (const path of [
			'/google-health/oauth/callback',
			'/google-health/oauth/callback?code=code-only',
			'/google-health/oauth/callback?state=state-only',
			'/google-health/oauth/callback?code=a&code=b&state=0123456789abcdefghijklmnopqrstuvwxyzABCDEFG',
			'/google-health/oauth/callback?code=a&state=short',
			'/google-health/oauth/callback?code=a&state=0123456789abcdefghijklmnopqrstuvwxyzABCDEFG&returnPath=https://attacker.example'
		]) {
			const response = await t.fetch(path);
			expectPrivateRedirect(response, errorLocation);
		}

		const { authorizationUrl } = await t
			.withIdentity({ tokenIdentifier: 'clerk|user-a' })
			.action(beginConnection, { returnPath: '/dashboard/import' });
		const state = new URL(authorizationUrl).searchParams.get('state');
		if (!state) throw new Error('Missing state fixture');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({
					access_token: 'access-token',
					refresh_token: 'refresh-token',
					expires_in: 3600,
					scope: GOOGLE_HEALTH_READ_SCOPES[0],
					token_type: 'Bearer'
				})
			)
		);
		const first = await t.fetch(
			`/google-health/oauth/callback?code=one-time-code&state=${encodeURIComponent(state)}`
		);
		const replay = await t.fetch(
			`/google-health/oauth/callback?code=one-time-code&state=${encodeURIComponent(state)}`
		);

		expectPrivateRedirect(first, errorLocation);
		expectPrivateRedirect(replay, errorLocation);
		expect(replay.headers.get('location')).not.toContain('one-time-code');
		expect(replay.headers.get('location')).not.toContain(state);
	});

	it('fails closed instead of redirecting when the configured app base URL is not a safe origin', async () => {
		for (const invalidAppUrl of [
			'https://homefit.example/tenant',
			'https://user:password@homefit.example',
			'https://homefit.example?next=https://attacker.example',
			'javascript:alert(1)',
			'http://homefit.example'
		]) {
			vi.stubEnv('HOMEFIT_APP_URL', invalidAppUrl);
			const t = convexTest(schema, modules);
			const response = await t.fetch('/google-health/oauth/callback');

			expect(response.status).toBe(500);
			expect(response.headers.get('location')).toBeNull();
			await expect(response.text()).resolves.toBe('Google Health callback configuration error');
		}
	});
});
