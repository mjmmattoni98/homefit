/// <reference types="vite/client" />

import type { Id } from '../_generated/dataModel';
import { type FunctionReference, makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { GOOGLE_HEALTH_READ_SCOPES, METRIC_DEFINITIONS } from './registry';

const modules = import.meta.glob('/src/convex/**/*.*s');
const NOW = new Date('2026-08-14T12:00:00.000Z').getTime();

type EnvelopeArgs = {
	encryptedRefreshToken: string;
	tokenNonce: string;
	tokenTag: string;
	tokenKeyVersion: string;
};

type SaveConnectionArgs = EnvelopeArgs & {
	userId: string;
	healthUserId: string;
	grantedScopes: string[];
};

function internalMutation<Args extends Record<string, unknown>, Return>(
	name: string
): FunctionReference<'mutation', 'internal', Args, Return> {
	return makeFunctionReference<'mutation', Args, Return>(name) as unknown as FunctionReference<
		'mutation',
		'internal',
		Args,
		Return
	>;
}

function internalQuery<Args extends Record<string, unknown>, Return>(
	name: string
): FunctionReference<'query', 'internal', Args, Return> {
	return makeFunctionReference<'query', Args, Return>(name) as unknown as FunctionReference<
		'query',
		'internal',
		Args,
		Return
	>;
}

const createOAuthState = internalMutation<
	{ userId: string; stateDigest: string; returnPath: string },
	{ expiresAt: number }
>('googleHealth/model:createOAuthState');
const consumeOAuthState = internalMutation<
	{ stateDigest: string },
	{ userId: string; returnPath: string }
>('googleHealth/model:consumeOAuthState');
const saveConnection = internalMutation<
	SaveConnectionArgs,
	{ connectionId: Id<'googleHealthConnections'>; generation: number }
>('googleHealth/model:saveConnection');
const initializeCursors = internalMutation<
	{ connectionId: Id<'googleHealthConnections'> },
	{ created: number; total: number }
>('googleHealth/model:initializeCursors');
const setConnectionError = internalMutation<
	{
		connectionId: Id<'googleHealthConnections'>;
		status: 'delayed' | 'action_required';
		lastErrorCode: string;
		nextRetryAt?: number;
	},
	null
>('googleHealth/model:setConnectionError');
const replaceTokenEnvelope = internalMutation<
	{
		connectionId: Id<'googleHealthConnections'>;
		expectedKeyVersion: string;
		envelope: EnvelopeArgs;
	},
	boolean
>('googleHealth/model:replaceTokenEnvelope');
const getConnectionForSync = internalQuery<
	{ connectionId: Id<'googleHealthConnections'> },
	{
		connectionId: Id<'googleHealthConnections'>;
		userId: string;
		healthUserId?: string;
		status: string;
		grantedScopes: string[];
		generation: number;
		encryptedRefreshToken?: string;
		tokenNonce?: string;
		tokenTag?: string;
		tokenKeyVersion?: string;
	} | null
>('googleHealth/model:getConnectionForSync');
const getConnectionStatus = makeFunctionReference<
	'query',
	Record<string, never>,
	Record<string, unknown> | null
>('googleHealth/model:getConnectionStatus');

const FIRST_ENVELOPE: EnvelopeArgs = {
	encryptedRefreshToken: 'ciphertext-v1',
	tokenNonce: 'nonce-v1',
	tokenTag: 'tag-v1',
	tokenKeyVersion: 'v1'
};

function connectionArgs(overrides: Partial<SaveConnectionArgs> = {}): SaveConnectionArgs {
	return {
		userId: 'clerk|user-a',
		healthUserId: 'google-health-user-a',
		grantedScopes: [...GOOGLE_HEALTH_READ_SCOPES],
		...FIRST_ENVELOPE,
		...overrides
	};
}

describe('Google Health connection model', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('creates an exact ten-minute OAuth state and consumes its digest once', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.mutation(createOAuthState, {
				userId: 'clerk|user-a',
				stateDigest: 'sha256-state-a',
				returnPath: '/dashboard/import'
			})
		).resolves.toEqual({ expiresAt: NOW + 10 * 60 * 1000 });
		await expect(t.mutation(consumeOAuthState, { stateDigest: 'sha256-state-a' })).resolves.toEqual(
			{
				userId: 'clerk|user-a',
				returnPath: '/dashboard/import'
			}
		);
		await expect(t.mutation(consumeOAuthState, { stateDigest: 'sha256-state-a' })).rejects.toThrow(
			'Invalid or expired OAuth state'
		);
	});

	it('rejects missing and exactly-expired OAuth states', async () => {
		const t = convexTest(schema, modules);

		await expect(t.mutation(consumeOAuthState, { stateDigest: 'missing' })).rejects.toThrow(
			'Invalid or expired OAuth state'
		);
		await t.mutation(createOAuthState, {
			userId: 'clerk|user-a',
			stateDigest: 'sha256-expiring-state',
			returnPath: '/dashboard/import'
		});
		vi.setSystemTime(NOW + 10 * 60 * 1000);

		await expect(
			t.mutation(consumeOAuthState, { stateDigest: 'sha256-expiring-state' })
		).rejects.toThrow('Invalid or expired OAuth state');
	});

	it('upserts one connection, increments its generation, and retains imported points', async () => {
		const t = convexTest(schema, modules);
		const first = await t.mutation(saveConnection, connectionArgs());

		expect(first.generation).toBe(1);
		await t.mutation(setConnectionError, {
			connectionId: first.connectionId,
			status: 'delayed',
			lastErrorCode: 'rate_limited',
			nextRetryAt: NOW + 60_000
		});
		await t.run(async (ctx) => {
			await ctx.db.insert('healthDataPoints', {
				connectionId: first.connectionId,
				userId: 'clerk|user-a',
				provider: 'google_health',
				recordKey: 'existing-record',
				dataType: 'steps',
				category: 'activity',
				recordTimestamp: NOW,
				localDate: '2026-08-14',
				payloadDigest: 'existing-digest',
				payloadJson: '{}',
				lastSeenSyncId: 'existing-sync'
			});
		});

		const second = await t.mutation(
			saveConnection,
			connectionArgs({
				healthUserId: 'google-health-user-a-reconnected',
				grantedScopes: [GOOGLE_HEALTH_READ_SCOPES[0]],
				encryptedRefreshToken: 'ciphertext-v2',
				tokenNonce: 'nonce-v2',
				tokenTag: 'tag-v2',
				tokenKeyVersion: 'v2'
			})
		);
		const stored = await t.query(getConnectionForSync, { connectionId: second.connectionId });
		const publicStatus = await t
			.withIdentity({ tokenIdentifier: 'clerk|user-a' })
			.query(getConnectionStatus, {});
		const retainedPointCount = await t.run(async (ctx) =>
			ctx.db
				.query('healthDataPoints')
				.withIndex('by_connectionId', (q) => q.eq('connectionId', second.connectionId))
				.take(2)
		);

		expect(second).toEqual({ connectionId: first.connectionId, generation: 2 });
		expect(stored).toMatchObject({
			connectionId: first.connectionId,
			healthUserId: 'google-health-user-a-reconnected',
			status: 'backfilling',
			generation: 2,
			grantedScopes: [GOOGLE_HEALTH_READ_SCOPES[0]],
			encryptedRefreshToken: 'ciphertext-v2',
			tokenNonce: 'nonce-v2',
			tokenTag: 'tag-v2',
			tokenKeyVersion: 'v2'
		});
		expect(publicStatus).not.toHaveProperty('lastErrorCode');
		expect(publicStatus).not.toHaveProperty('lastErrorMessage');
		expect(publicStatus).not.toHaveProperty('nextRetryAt');
		expect(retainedPointCount).toHaveLength(1);
	});

	it('initializes one backfill cursor per granted registry type without duplicates', async () => {
		const t = convexTest(schema, modules);
		const { connectionId } = await t.mutation(saveConnection, connectionArgs());

		await expect(t.mutation(initializeCursors, { connectionId })).resolves.toEqual({
			created: 40,
			total: 40
		});
		await expect(t.mutation(initializeCursors, { connectionId })).resolves.toEqual({
			created: 0,
			total: 40
		});
		const partialConnection = await t.mutation(
			saveConnection,
			connectionArgs({
				userId: 'clerk|user-b',
				healthUserId: 'google-health-user-b',
				grantedScopes: [GOOGLE_HEALTH_READ_SCOPES[6]]
			})
		);
		await expect(
			t.mutation(initializeCursors, { connectionId: partialConnection.connectionId })
		).resolves.toEqual({ created: 1, total: 1 });
		const cursors = await t.run(async (ctx) =>
			ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|user-a'))
				.take(METRIC_DEFINITIONS.length + 1)
		);

		expect(cursors).toHaveLength(40);
		expect(new Set(cursors.map((cursor) => cursor.dataType)).size).toBe(40);
		expect(cursors.every((cursor) => cursor.mode === 'backfill')).toBe(true);
		const partialCursors = await t.run(async (ctx) =>
			ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|user-b'))
				.take(2)
		);
		expect(partialCursors.map((cursor) => cursor.dataType)).toEqual(['sleep']);
	});

	it('keeps token material internal and exposes redacted retry status publicly', async () => {
		const t = convexTest(schema, modules);
		const { connectionId } = await t.mutation(saveConnection, connectionArgs());
		const retryAt = NOW + 60_000;

		await t.mutation(setConnectionError, {
			connectionId,
			status: 'delayed',
			lastErrorCode: 'rate_limited',
			nextRetryAt: retryAt
		});
		const syncConnection = await t.query(getConnectionForSync, { connectionId });
		const publicStatus = await t
			.withIdentity({ tokenIdentifier: 'clerk|user-a' })
			.query(getConnectionStatus, {});

		expect(syncConnection).toMatchObject(FIRST_ENVELOPE);
		expect(publicStatus).toEqual({
			status: 'delayed',
			grantedScopes: [...GOOGLE_HEALTH_READ_SCOPES],
			backfillTotalTypes: 40,
			backfillCompletedTypes: 0,
			lastAttemptAt: NOW,
			lastErrorCode: 'rate_limited',
			lastErrorMessage: 'Google Health is temporarily unavailable',
			nextRetryAt: retryAt
		});
		expect(publicStatus).not.toHaveProperty('encryptedRefreshToken');
		expect(publicStatus).not.toHaveProperty('tokenNonce');
		expect(publicStatus).not.toHaveProperty('tokenTag');
		expect(publicStatus).not.toHaveProperty('tokenKeyVersion');
	});

	it('replaces an old token envelope only when its stored version still matches', async () => {
		const t = convexTest(schema, modules);
		const { connectionId } = await t.mutation(saveConnection, connectionArgs());
		const rotatedEnvelope = {
			encryptedRefreshToken: 'ciphertext-v2',
			tokenNonce: 'nonce-v2',
			tokenTag: 'tag-v2',
			tokenKeyVersion: 'v2'
		};

		await expect(
			t.mutation(replaceTokenEnvelope, {
				connectionId,
				expectedKeyVersion: 'unexpected',
				envelope: rotatedEnvelope
			})
		).resolves.toBe(false);
		await expect(
			t.mutation(replaceTokenEnvelope, {
				connectionId,
				expectedKeyVersion: 'v1',
				envelope: rotatedEnvelope
			})
		).resolves.toBe(true);
		await expect(t.query(getConnectionForSync, { connectionId })).resolves.toMatchObject(
			rotatedEnvelope
		);
	});
});
