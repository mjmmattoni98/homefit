import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { action, env, internalAction } from '../_generated/server';
import { type FunctionReference, makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { requireUserId } from '../helpers';
import {
	GoogleHealthError,
	buildAuthorizationUrl,
	exchangeAuthorizationCode,
	getHealthIdentity
} from './apiClient';
import { createTokenKeyring, encryptRefreshToken } from './crypto';
import { sha256Base64Url } from './normalize';

const IMPORT_RETURN_PATH = '/dashboard/import';
const STATE_BYTE_LENGTH = 32;

function internalActionReference<Args extends Record<string, unknown>, Return>(
	name: string
): FunctionReference<'action', 'internal', Args, Return> {
	return makeFunctionReference<'action', Args, Return>(name) as unknown as FunctionReference<
		'action',
		'internal',
		Args,
		Return
	>;
}

const runCursor = internalActionReference<
	{
		cursorId: Id<'googleHealthSyncCursors'>;
		generation: number;
		trigger: 'oauth';
	},
	null
>('googleHealth/sync:runCursor');

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function createRawState(): string {
	return encodeBase64Url(crypto.getRandomValues(new Uint8Array(STATE_BYTE_LENGTH)));
}

function oauthFlowError(code: string): GoogleHealthError {
	return new GoogleHealthError(code, null, false);
}

export const beginConnection = action({
	args: { returnPath: v.string() },
	returns: v.object({ authorizationUrl: v.string() }),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		if (args.returnPath !== IMPORT_RETURN_PATH) {
			throw new Error('Invalid Google Health return path');
		}

		const state = createRawState();
		const authorizationUrl = buildAuthorizationUrl({
			clientId: env.GOOGLE_HEALTH_CLIENT_ID,
			redirectUri: env.GOOGLE_HEALTH_REDIRECT_URI,
			state
		});
		await ctx.runMutation(internal.googleHealth.model.createOAuthState, {
			userId,
			stateDigest: sha256Base64Url(state),
			returnPath: IMPORT_RETURN_PATH
		});
		return { authorizationUrl };
	}
});

export const completeOAuth = internalAction({
	args: { code: v.string(), state: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		if (!/^[A-Za-z0-9_-]{43}$/.test(args.state)) throw oauthFlowError('invalid_state');
		const oauthState = await ctx.runMutation(internal.googleHealth.model.consumeOAuthState, {
			stateDigest: sha256Base64Url(args.state)
		});
		if (oauthState.returnPath !== IMPORT_RETURN_PATH) throw oauthFlowError('invalid_return_path');

		const tokens = await exchangeAuthorizationCode({
			code: args.code,
			clientId: env.GOOGLE_HEALTH_CLIENT_ID,
			clientSecret: env.GOOGLE_HEALTH_CLIENT_SECRET,
			redirectUri: env.GOOGLE_HEALTH_REDIRECT_URI
		});
		if (tokens.refreshToken === undefined) throw oauthFlowError('missing_refresh_token');
		if (tokens.grantedScopes.length === 0) throw oauthFlowError('invalid_granted_scopes');

		const { healthUserId } = await getHealthIdentity(tokens.accessToken);
		const keyring = createTokenKeyring(
			env.GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY,
			env.GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION,
			env.GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS
		);
		const tokenEnvelope = await encryptRefreshToken(
			tokens.refreshToken,
			oauthState.userId,
			keyring.activeKey,
			keyring.activeVersion
		);
		const connection = await ctx.runMutation(internal.googleHealth.model.saveConnection, {
			userId: oauthState.userId,
			healthUserId,
			grantedScopes: tokens.grantedScopes,
			...tokenEnvelope
		});
		const cursors = await ctx.runMutation(internal.googleHealth.model.initializeCursors, {
			connectionId: connection.connectionId
		});
		if (cursors.firstCursorId !== null) {
			await ctx.scheduler.runAfter(0, runCursor, {
				cursorId: cursors.firstCursorId,
				generation: connection.generation,
				trigger: 'oauth'
			});
		}
		return null;
	}
});
