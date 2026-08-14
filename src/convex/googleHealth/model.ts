import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from '../_generated/server';
import { requireUserId } from '../helpers';
import { METRIC_DEFINITIONS } from './registry';
import { connectionStatusValidator } from './validators';

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
	encryptedRefreshToken: v.optional(v.string()),
	tokenNonce: v.optional(v.string()),
	tokenTag: v.optional(v.string()),
	tokenKeyVersion: v.optional(v.string())
});

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
			lastErrorCode: undefined,
			lastErrorMessage: undefined,
			nextRetryAt: undefined,
			disconnectedAt: undefined
		};

		if (existing) {
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
			...(connection.encryptedRefreshToken === undefined
				? {}
				: { encryptedRefreshToken: connection.encryptedRefreshToken }),
			...(connection.tokenNonce === undefined ? {} : { tokenNonce: connection.tokenNonce }),
			...(connection.tokenTag === undefined ? {} : { tokenTag: connection.tokenTag }),
			...(connection.tokenKeyVersion === undefined
				? {}
				: { tokenKeyVersion: connection.tokenKeyVersion })
		};
	}
});

export const initializeCursors = internalMutation({
	args: { connectionId: v.id('googleHealthConnections') },
	returns: v.object({ created: v.number(), total: v.number() }),
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
				continue;
			}

			await ctx.db.insert('googleHealthSyncCursors', {
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
			created += 1;
		}

		return { created, total: definitions.length };
	}
});

export const setConnectionError = internalMutation({
	args: {
		connectionId: v.id('googleHealthConnections'),
		status: v.union(v.literal('delayed'), v.literal('action_required')),
		lastErrorCode: v.string(),
		nextRetryAt: v.optional(v.number())
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get('googleHealthConnections', args.connectionId);
		if (!connection) {
			throw new Error('Google Health connection not found');
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
		return null;
	}
});

export const replaceTokenEnvelope = internalMutation({
	args: {
		connectionId: v.id('googleHealthConnections'),
		expectedKeyVersion: v.string(),
		envelope: tokenEnvelopeValidator
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const connection = await ctx.db.get('googleHealthConnections', args.connectionId);
		if (
			!connection ||
			connection.encryptedRefreshToken === undefined ||
			connection.tokenKeyVersion !== args.expectedKeyVersion
		) {
			return false;
		}

		await ctx.db.patch('googleHealthConnections', connection._id, args.envelope);
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
