import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from '../_generated/server';
import { requireUserId } from '../helpers';
import type { EncryptedTokenEnvelope } from './crypto';
import { METRIC_DEFINITIONS } from './registry';
import { type ConnectionStatus, connectionStatusValidator } from './validators';

const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;

const tokenEnvelopeValidator = v.object({
	encryptedRefreshToken: v.string(),
	tokenNonce: v.string(),
	tokenTag: v.string(),
	tokenKeyVersion: v.string()
});

const connectionStatusResultValidator = v.object({
	status: connectionStatusValidator,
	grantedScopes: v.array(v.string()),
	backfillTotalTypes: v.number(),
	backfillCompletedTypes: v.number(),
	lastAttemptAt: v.optional(v.number()),
	lastSuccessfulSyncAt: v.optional(v.number()),
	lastErrorCode: v.optional(v.string()),
	lastErrorMessage: v.optional(v.string()),
	nextRetryAt: v.optional(v.number()),
	disconnectedAt: v.optional(v.number())
});

const connectionForSyncValidator = v.object({
	connectionId: v.id('googleHealthConnections'),
	userId: v.string(),
	healthUserId: v.optional(v.string()),
	status: connectionStatusValidator,
	grantedScopes: v.array(v.string()),
	generation: v.number(),
	tokenEnvelope: v.union(tokenEnvelopeValidator, v.null())
});

type StoredTokenFields = {
	encryptedRefreshToken?: string;
	tokenNonce?: string;
	tokenTag?: string;
	tokenKeyVersion?: string;
};

function readStoredTokenEnvelope(connection: StoredTokenFields): EncryptedTokenEnvelope | null {
	const encryptedRefreshToken = connection.encryptedRefreshToken;
	const tokenNonce = connection.tokenNonce;
	const tokenTag = connection.tokenTag;
	const tokenKeyVersion = connection.tokenKeyVersion;
	if (
		encryptedRefreshToken === undefined &&
		tokenNonce === undefined &&
		tokenTag === undefined &&
		tokenKeyVersion === undefined
	) {
		return null;
	}
	if (
		encryptedRefreshToken === undefined ||
		tokenNonce === undefined ||
		tokenTag === undefined ||
		tokenKeyVersion === undefined
	) {
		throw new Error('Incomplete Google Health token envelope');
	}

	return { encryptedRefreshToken, tokenNonce, tokenTag, tokenKeyVersion };
}

function isSyncableStatus(status: ConnectionStatus): boolean {
	return status === 'backfilling' || status === 'active' || status === 'delayed';
}

function tokenEnvelopesEqual(left: EncryptedTokenEnvelope, right: EncryptedTokenEnvelope): boolean {
	return (
		left.encryptedRefreshToken === right.encryptedRefreshToken &&
		left.tokenNonce === right.tokenNonce &&
		left.tokenTag === right.tokenTag &&
		left.tokenKeyVersion === right.tokenKeyVersion
	);
}

export const createOAuthState = internalMutation({
	args: {
		userId: v.string(),
		stateDigest: v.string(),
		returnPath: v.string()
	},
	returns: v.object({ expiresAt: v.number() }),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('googleHealthOAuthStates')
			.withIndex('by_stateDigest', (q) => q.eq('stateDigest', args.stateDigest))
			.unique();
		if (existing) {
			throw new Error('OAuth state already exists');
		}

		const expiresAt = Date.now() + OAUTH_STATE_LIFETIME_MS;
		await ctx.db.insert('googleHealthOAuthStates', {
			userId: args.userId,
			stateDigest: args.stateDigest,
			expiresAt,
			returnPath: args.returnPath
		});
		return { expiresAt };
	}
});

export const consumeOAuthState = internalMutation({
	args: { stateDigest: v.string() },
	returns: v.object({ userId: v.string(), returnPath: v.string() }),
	handler: async (ctx, args) => {
		const oauthState = await ctx.db
			.query('googleHealthOAuthStates')
			.withIndex('by_stateDigest', (q) => q.eq('stateDigest', args.stateDigest))
			.unique();
		const now = Date.now();
		if (!oauthState || oauthState.consumedAt !== undefined || oauthState.expiresAt <= now) {
			throw new Error('Invalid or expired OAuth state');
		}

		await ctx.db.patch('googleHealthOAuthStates', oauthState._id, { consumedAt: now });
		return { userId: oauthState.userId, returnPath: oauthState.returnPath };
	}
});

export const saveConnection = internalMutation({
	args: {
		userId: v.string(),
		healthUserId: v.string(),
		grantedScopes: v.array(v.string()),
		...tokenEnvelopeValidator.fields
	},
	returns: v.object({
		connectionId: v.id('googleHealthConnections'),
		generation: v.number()
	}),
	handler: async (ctx, args) => {
		const existing = await ctx.db
			.query('googleHealthConnections')
			.withIndex('by_userId', (q) => q.eq('userId', args.userId))
			.unique();
		const grantedScopes = [...new Set(args.grantedScopes)];
		const grantedScopeSet = new Set(grantedScopes);
		const backfillTotalTypes = METRIC_DEFINITIONS.filter((definition) =>
			grantedScopeSet.has(definition.scope)
		).length;
		const generation = (existing?.generation ?? 0) + 1;
		const syncLeaseVersion = existing ? (existing.syncLeaseVersion ?? 0) + 1 : undefined;
		const connection = {
			healthUserId: args.healthUserId,
			status: 'backfilling' as const,
			encryptedRefreshToken: args.encryptedRefreshToken,
			tokenNonce: args.tokenNonce,
			tokenTag: args.tokenTag,
			tokenKeyVersion: args.tokenKeyVersion,
			grantedScopes,
			generation,
			backfillTotalTypes,
			backfillCompletedTypes: 0,
			activeSyncCursorId: undefined,
			activeSyncRunId: undefined,
			syncLeaseExpiresAt: undefined,
			...(syncLeaseVersion === undefined ? {} : { syncLeaseVersion }),
			lastErrorCode: undefined,
			lastErrorMessage: undefined,
			nextRetryAt: undefined,
			disconnectedAt: undefined
		};

		if (existing) {
			const now = Date.now();
			const activeCursor =
				existing.activeSyncCursorId === undefined
					? null
					: await ctx.db.get('googleHealthSyncCursors', existing.activeSyncCursorId);
			const activeRun =
				existing.activeSyncRunId === undefined
					? null
					: await ctx.db.get('googleHealthSyncRuns', existing.activeSyncRunId);
			if (
				activeRun !== null &&
				activeRun.status === 'running' &&
				activeRun.connectionId === existing._id &&
				activeRun.generation === existing.generation
			) {
				await ctx.db.patch('googleHealthSyncRuns', activeRun._id, {
					status: 'failed',
					finishedAt: now,
					errorCode: 'stale_generation',
					errorMessage: 'Google Health connection generation changed'
				});
			}
			if (
				activeCursor !== null &&
				activeCursor.connectionId === existing._id &&
				activeCursor.generation === existing.generation
			) {
				await ctx.db.patch('googleHealthSyncCursors', activeCursor._id, {
					status: activeCursor.status === 'running' ? 'retry' : activeCursor.status,
					activeRunId: undefined,
					activeEpoch: undefined,
					leaseExpiresAt: undefined,
					leaseVersion: undefined,
					dispatchVersion: (activeCursor.dispatchVersion ?? 0) + 1,
					updatedAt: now
				});
			}
			await ctx.db.patch('googleHealthConnections', existing._id, connection);
			return { connectionId: existing._id, generation };
		}

		const connectionId = await ctx.db.insert('googleHealthConnections', {
			userId: args.userId,
			...connection
		});
		return { connectionId, generation };
	}
});

export const getConnectionForSync = internalQuery({
	args: { connectionId: v.id('googleHealthConnections') },
	returns: v.union(connectionForSyncValidator, v.null()),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get('googleHealthConnections', args.connectionId);
		if (!connection) {
			return null;
		}

		return {
			connectionId: connection._id,
			userId: connection.userId,
			...(connection.healthUserId === undefined ? {} : { healthUserId: connection.healthUserId }),
			status: connection.status,
			grantedScopes: connection.grantedScopes,
			generation: connection.generation,
			tokenEnvelope: readStoredTokenEnvelope(connection)
		};
	}
});

export const initializeCursors = internalMutation({
	args: { connectionId: v.id('googleHealthConnections') },
	returns: v.object({
		created: v.number(),
		total: v.number(),
		firstCursorId: v.union(v.id('googleHealthSyncCursors'), v.null())
	}),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get('googleHealthConnections', args.connectionId);
		if (!connection) {
			throw new Error('Google Health connection not found');
		}

		const grantedScopes = new Set(connection.grantedScopes);
		const definitions = METRIC_DEFINITIONS.filter((definition) =>
			grantedScopes.has(definition.scope)
		);
		let created = 0;
		let firstCursorId = null;
		const updatedAt = Date.now();
		for (const definition of definitions) {
			const existing = await ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
					q
						.eq('connectionId', connection._id)
						.eq('dataType', definition.dataType)
						.eq('mode', 'backfill')
				)
				.unique();
			if (existing) {
				firstCursorId ??= existing._id;
				if (existing.generation !== connection.generation) {
					if (existing.activeRunId !== undefined) {
						const staleRun = await ctx.db.get('googleHealthSyncRuns', existing.activeRunId);
						if (staleRun?.status === 'running') {
							await ctx.db.patch('googleHealthSyncRuns', staleRun._id, {
								status: 'failed',
								finishedAt: updatedAt,
								errorCode: 'stale_generation',
								errorMessage: 'Google Health connection generation changed'
							});
						}
					}
					if (connection.activeSyncCursorId === existing._id) {
						await ctx.db.patch('googleHealthConnections', connection._id, {
							activeSyncCursorId: undefined,
							activeSyncRunId: undefined,
							syncLeaseExpiresAt: undefined
						});
					}
					await ctx.db.patch('googleHealthSyncCursors', existing._id, {
						status: 'queued',
						activeRunId: undefined,
						activeEpoch: undefined,
						leaseExpiresAt: undefined,
						leaseVersion: undefined,
						hadMalformed: false,
						pageToken: undefined,
						windowStart: undefined,
						windowEnd: undefined,
						pendingWindowStart: undefined,
						pendingWindowEnd: undefined,
						pendingUnbounded: undefined,
						queuedTrigger: undefined,
						pendingTrigger: undefined,
						watermark: undefined,
						syncId: `backfill:${connection.generation}:${definition.dataType}`,
						attempt: 0,
						dispatchPending: false,
						generation: connection.generation,
						updatedAt
					});
				}
				continue;
			}

			const cursorId = await ctx.db.insert('googleHealthSyncCursors', {
				connectionId: connection._id,
				userId: connection.userId,
				dataType: definition.dataType,
				mode: 'backfill',
				status: 'queued',
				syncId: `backfill:${connection.generation}:${definition.dataType}`,
				attempt: 0,
				generation: connection.generation,
				updatedAt
			});
			firstCursorId ??= cursorId;
			created += 1;
		}

		return { created, total: definitions.length, firstCursorId };
	}
});

export const setConnectionError = internalMutation({
	args: {
		connectionId: v.id('googleHealthConnections'),
		expectedGeneration: v.number(),
		status: v.union(v.literal('delayed'), v.literal('action_required')),
		lastErrorCode: v.string(),
		nextRetryAt: v.optional(v.number())
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get('googleHealthConnections', args.connectionId);
		if (
			!connection ||
			connection.generation !== args.expectedGeneration ||
			!isSyncableStatus(connection.status)
		) {
			return false;
		}

		const safeErrorCode = /^[a-z0-9_.-]{1,80}$/.test(args.lastErrorCode)
			? args.lastErrorCode
			: 'sync_error';
		await ctx.db.patch('googleHealthConnections', connection._id, {
			status: args.status,
			lastAttemptAt: Date.now(),
			lastErrorCode: safeErrorCode,
			lastErrorMessage:
				args.status === 'action_required'
					? 'Google Health access needs to be renewed'
					: 'Google Health is temporarily unavailable',
			nextRetryAt: args.nextRetryAt
		});
		return true;
	}
});

export const replaceTokenEnvelope = internalMutation({
	args: {
		connectionId: v.id('googleHealthConnections'),
		expectedGeneration: v.number(),
		expectedEnvelope: tokenEnvelopeValidator,
		replacementEnvelope: tokenEnvelopeValidator,
		replacementGrantedScopes: v.optional(v.array(v.string()))
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get('googleHealthConnections', args.connectionId);
		if (!connection || connection.generation !== args.expectedGeneration) {
			return false;
		}
		if (!isSyncableStatus(connection.status)) {
			return false;
		}

		const storedEnvelope = readStoredTokenEnvelope(connection);
		if (storedEnvelope === null || !tokenEnvelopesEqual(storedEnvelope, args.expectedEnvelope)) {
			return false;
		}

		await ctx.db.patch('googleHealthConnections', connection._id, {
			...args.replacementEnvelope,
			...(args.replacementGrantedScopes === undefined
				? {}
				: { grantedScopes: [...new Set(args.replacementGrantedScopes)] })
		});
		return true;
	}
});

export const getConnectionStatus = query({
	args: {},
	returns: v.union(connectionStatusResultValidator, v.null()),
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const connection = await ctx.db
			.query('googleHealthConnections')
			.withIndex('by_userId', (q) => q.eq('userId', userId))
			.unique();

		if (!connection) {
			return null;
		}

		return {
			status: connection.status,
			grantedScopes: connection.grantedScopes,
			backfillTotalTypes: connection.backfillTotalTypes,
			backfillCompletedTypes: connection.backfillCompletedTypes,
			...(connection.lastAttemptAt === undefined
				? {}
				: { lastAttemptAt: connection.lastAttemptAt }),
			...(connection.lastSuccessfulSyncAt === undefined
				? {}
				: { lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt }),
			...(connection.lastErrorCode === undefined
				? {}
				: { lastErrorCode: connection.lastErrorCode }),
			...(connection.lastErrorMessage === undefined
				? {}
				: { lastErrorMessage: connection.lastErrorMessage }),
			...(connection.nextRetryAt === undefined ? {} : { nextRetryAt: connection.nextRetryAt }),
			...(connection.disconnectedAt === undefined
				? {}
				: { disconnectedAt: connection.disconnectedAt })
		};
	}
});
