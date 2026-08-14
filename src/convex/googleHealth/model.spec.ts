/// <reference types="vite/client" />

import type { Id } from '../_generated/dataModel';
import { type FunctionReference, makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import {
	createTokenKeyring,
	decryptRefreshToken,
	encryptRefreshToken,
	rotateRefreshTokenEnvelope
} from './crypto';
import { GOOGLE_HEALTH_READ_SCOPES, METRIC_DEFINITIONS } from './registry';

const modules = import.meta.glob('/src/convex/**/*.*s');
const NOW = new Date('2026-08-14T12:00:00.000Z').getTime();
const ACTIVE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const PREVIOUS_KEY = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=';

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
		expectedGeneration: number;
		status: 'delayed' | 'action_required';
		lastErrorCode: string;
		nextRetryAt?: number;
	},
	boolean
>('googleHealth/model:setConnectionError');
const replaceTokenEnvelope = internalMutation<
	{
		connectionId: Id<'googleHealthConnections'>;
		expectedGeneration: number;
		expectedEnvelope: EnvelopeArgs;
		replacementEnvelope: EnvelopeArgs;
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
		tokenEnvelope: EnvelopeArgs | null;
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
			expectedGeneration: first.generation,
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
			tokenEnvelope: {
				encryptedRefreshToken: 'ciphertext-v2',
				tokenNonce: 'nonce-v2',
				tokenTag: 'tag-v2',
				tokenKeyVersion: 'v2'
			}
		});
		expect(publicStatus).not.toHaveProperty('lastErrorCode');
		expect(publicStatus).not.toHaveProperty('lastErrorMessage');
		expect(publicStatus).not.toHaveProperty('nextRetryAt');
		expect(retainedPointCount).toHaveLength(1);
	});

	it('initializes scoped cursors and resets only stale-generation cursors on reconnect', async () => {
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
		await t.run(async (ctx) => {
			for (const dataType of ['sleep', 'steps']) {
				const cursor = await ctx.db
					.query('googleHealthSyncCursors')
					.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
						q.eq('connectionId', connectionId).eq('dataType', dataType).eq('mode', 'backfill')
					)
					.unique();
				if (!cursor) throw new Error(`Missing ${dataType} cursor fixture`);
				await ctx.db.patch('googleHealthSyncCursors', cursor._id, {
					status: 'complete',
					pageToken: `${dataType}-page`,
					windowStart: '2026-01-01T00:00:00Z',
					windowEnd: '2026-02-01T00:00:00Z',
					watermark: '2026-02-01T00:00:00Z',
					attempt: 3
				});
			}
		});
		const reconnected = await t.mutation(
			saveConnection,
			connectionArgs({ grantedScopes: [GOOGLE_HEALTH_READ_SCOPES[6]] })
		);
		vi.setSystemTime(NOW + 1_000);
		await expect(
			t.mutation(initializeCursors, { connectionId: reconnected.connectionId })
		).resolves.toEqual({ created: 0, total: 1 });
		vi.setSystemTime(NOW + 2_000);
		await expect(
			t.mutation(initializeCursors, { connectionId: reconnected.connectionId })
		).resolves.toEqual({ created: 0, total: 1 });
		const cursors = await t.run(async (ctx) =>
			ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|user-a'))
				.take(METRIC_DEFINITIONS.length + 1)
		);

		expect(cursors).toHaveLength(40);
		expect(new Set(cursors.map((cursor) => cursor.dataType)).size).toBe(40);
		const sleepCursor = cursors.find((cursor) => cursor.dataType === 'sleep');
		const stepsCursor = cursors.find((cursor) => cursor.dataType === 'steps');
		expect(sleepCursor).toMatchObject({
			status: 'queued',
			generation: 2,
			syncId: 'backfill:2:sleep',
			attempt: 0,
			updatedAt: NOW + 1_000
		});
		expect(sleepCursor).not.toHaveProperty('pageToken');
		expect(sleepCursor).not.toHaveProperty('windowStart');
		expect(sleepCursor).not.toHaveProperty('windowEnd');
		expect(sleepCursor).not.toHaveProperty('watermark');
		expect(stepsCursor).toMatchObject({
			status: 'complete',
			generation: 1,
			pageToken: 'steps-page',
			attempt: 3
		});
	});

	it('keeps token material internal and exposes redacted retry status publicly', async () => {
		const t = convexTest(schema, modules);
		const { connectionId } = await t.mutation(saveConnection, connectionArgs());
		const retryAt = NOW + 60_000;

		await t.mutation(setConnectionError, {
			connectionId,
			expectedGeneration: 1,
			status: 'delayed',
			lastErrorCode: 'rate_limited',
			nextRetryAt: retryAt
		});
		const syncConnection = await t.query(getConnectionForSync, { connectionId });
		const publicStatus = await t
			.withIdentity({ tokenIdentifier: 'clerk|user-a' })
			.query(getConnectionStatus, {});

		expect(syncConnection?.tokenEnvelope).toEqual(FIRST_ENVELOPE);
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
		expect(publicStatus).not.toHaveProperty('tokenEnvelope');
	});

	it('prevents stale workers and inactive connections from overwriting connection errors', async () => {
		const t = convexTest(schema, modules);
		const first = await t.mutation(saveConnection, connectionArgs());
		const reconnected = await t.mutation(saveConnection, connectionArgs());

		await expect(
			t.mutation(setConnectionError, {
				connectionId: first.connectionId,
				expectedGeneration: first.generation,
				status: 'action_required',
				lastErrorCode: 'invalid_grant'
			})
		).resolves.toBe(false);
		const statusAfterStaleWrite = await t
			.withIdentity({ tokenIdentifier: 'clerk|user-a' })
			.query(getConnectionStatus, {});
		expect(statusAfterStaleWrite).toMatchObject({ status: 'backfilling' });
		expect(statusAfterStaleWrite).not.toHaveProperty('lastErrorCode');

		for (const inactiveStatus of [
			'connecting',
			'action_required',
			'disconnected',
			'deleting'
		] as const) {
			await t.run(async (ctx) => {
				await ctx.db.patch('googleHealthConnections', reconnected.connectionId, {
					status: inactiveStatus
				});
			});
			await expect(
				t.mutation(setConnectionError, {
					connectionId: reconnected.connectionId,
					expectedGeneration: reconnected.generation,
					status: 'delayed',
					lastErrorCode: 'network_error'
				})
			).resolves.toBe(false);
		}
	});

	it('uses generation and the complete expected envelope as token replacement CAS guards', async () => {
		const t = convexTest(schema, modules);
		const first = await t.mutation(saveConnection, connectionArgs());
		const sameVersionReconnectEnvelope = {
			encryptedRefreshToken: 'same-version-new-ciphertext',
			tokenNonce: 'same-version-new-nonce',
			tokenTag: 'same-version-new-tag',
			tokenKeyVersion: 'v1'
		};
		const reconnected = await t.mutation(
			saveConnection,
			connectionArgs(sameVersionReconnectEnvelope)
		);
		const rotatedEnvelope = {
			encryptedRefreshToken: 'ciphertext-v2',
			tokenNonce: 'nonce-v2',
			tokenTag: 'tag-v2',
			tokenKeyVersion: 'v2'
		};

		await expect(
			t.mutation(replaceTokenEnvelope, {
				connectionId: first.connectionId,
				expectedGeneration: first.generation,
				expectedEnvelope: FIRST_ENVELOPE,
				replacementEnvelope: rotatedEnvelope
			})
		).resolves.toBe(false);
		await expect(
			t.mutation(replaceTokenEnvelope, {
				connectionId: reconnected.connectionId,
				expectedGeneration: reconnected.generation,
				expectedEnvelope: FIRST_ENVELOPE,
				replacementEnvelope: rotatedEnvelope
			})
		).resolves.toBe(false);
		await expect(
			t.mutation(replaceTokenEnvelope, {
				connectionId: reconnected.connectionId,
				expectedGeneration: reconnected.generation,
				expectedEnvelope: sameVersionReconnectEnvelope,
				replacementEnvelope: rotatedEnvelope
			})
		).resolves.toBe(true);
		await expect(
			t.query(getConnectionForSync, { connectionId: reconnected.connectionId })
		).resolves.toMatchObject({ tokenEnvelope: rotatedEnvelope });

		await t.run(async (ctx) => {
			await ctx.db.patch('googleHealthConnections', reconnected.connectionId, {
				status: 'disconnected'
			});
		});
		await expect(
			t.mutation(replaceTokenEnvelope, {
				connectionId: reconnected.connectionId,
				expectedGeneration: reconnected.generation,
				expectedEnvelope: rotatedEnvelope,
				replacementEnvelope: FIRST_ENVELOPE
			})
		).resolves.toBe(false);
	});

	it('fails closed for every partial token envelope and returns null for no token', async () => {
		const t = convexTest(schema, modules);
		const envelopeFields = Object.keys(FIRST_ENVELOPE) as (keyof EnvelopeArgs)[];
		const partialConnectionIds = await t.run(async (ctx) => {
			const ids: Id<'googleHealthConnections'>[] = [];
			for (let mask = 1; mask < 2 ** envelopeFields.length - 1; mask += 1) {
				const partialEnvelope = Object.fromEntries(
					envelopeFields
						.filter((_, index) => (mask & (1 << index)) !== 0)
						.map((field) => [field, FIRST_ENVELOPE[field]])
				) as Partial<EnvelopeArgs>;
				ids.push(
					await ctx.db.insert('googleHealthConnections', {
						userId: `clerk|partial-${mask}`,
						status: 'active',
						grantedScopes: [],
						generation: 1,
						backfillTotalTypes: 0,
						backfillCompletedTypes: 0,
						...partialEnvelope
					})
				);
			}
			return ids;
		});

		for (const connectionId of partialConnectionIds) {
			await expect(t.query(getConnectionForSync, { connectionId })).rejects.toThrow(
				'Incomplete Google Health token envelope'
			);
		}

		const disconnectedId = await t.run(async (ctx) =>
			ctx.db.insert('googleHealthConnections', {
				userId: 'clerk|disconnected',
				status: 'disconnected',
				grantedScopes: [],
				generation: 2,
				backfillTotalTypes: 0,
				backfillCompletedTypes: 0
			})
		);
		await expect(
			t.query(getConnectionForSync, { connectionId: disconnectedId })
		).resolves.toMatchObject({ status: 'disconnected', tokenEnvelope: null });
	});

	it('persists an old-key read only through guarded active-key replacement', async () => {
		const t = convexTest(schema, modules);
		const userId = 'clerk|user-a';
		const oldEnvelope = await encryptRefreshToken('refresh-token', userId, PREVIOUS_KEY, 'v1');
		const saved = await t.mutation(saveConnection, connectionArgs(oldEnvelope));
		const beforeRotation = await t.query(getConnectionForSync, {
			connectionId: saved.connectionId
		});
		if (!beforeRotation?.tokenEnvelope) throw new Error('Missing token envelope fixture');
		const keyring = createTokenKeyring(ACTIVE_KEY, 'v2', JSON.stringify({ v1: PREVIOUS_KEY }));
		const rotated = await rotateRefreshTokenEnvelope(beforeRotation.tokenEnvelope, userId, keyring);

		expect(rotated.reencrypted).toBe(true);
		await expect(
			t.mutation(replaceTokenEnvelope, {
				connectionId: saved.connectionId,
				expectedGeneration: beforeRotation.generation,
				expectedEnvelope: beforeRotation.tokenEnvelope,
				replacementEnvelope: rotated.envelope
			})
		).resolves.toBe(true);
		const afterRotation = await t.query(getConnectionForSync, {
			connectionId: saved.connectionId
		});
		expect(afterRotation?.tokenEnvelope).toEqual(rotated.envelope);
		await expect(
			decryptRefreshToken(afterRotation!.tokenEnvelope!, userId, keyring)
		).resolves.toEqual({ refreshToken: 'refresh-token', needsReencryption: false });
	});
});
