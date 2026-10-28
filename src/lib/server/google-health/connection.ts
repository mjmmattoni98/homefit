import { randomBytes } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Database, Executor } from '../db/types';
import {
	googleHealthConnection,
	googleHealthOAuthState,
	googleHealthSyncRun,
	healthDataPoint
} from '../db/schema';
import {
	GoogleHealthError,
	buildAuthorizationUrl,
	exchangeAuthorizationCode,
	getHealthIdentity,
	revokeGoogleToken
} from './api-client';
import type { GoogleHealthConfig } from './config';
import { decryptRefreshToken, encryptRefreshToken, type EncryptedTokenEnvelope } from './crypto';
import { initializeBackfillCursors, queueReconciliation } from './cursors';
import { sha256Base64Url } from './normalize';
import { METRIC_DEFINITIONS } from './registry';
import type { ConnectionStatus } from './types';

export const IMPORT_RETURN_PATH = '/dashboard/import';
export const DELETE_CONFIRMATION = 'DELETE GOOGLE DATA';
const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IMPORTABLE_SCOPES = new Set(METRIC_DEFINITIONS.map((definition) => definition.scope));
const DELETE_BATCH_SIZE = 5_000;

type ConnectionRow = typeof googleHealthConnection.$inferSelect;

export interface ConnectionStatusView {
	status: ConnectionStatus;
	grantedScopes: string[];
	backfillTotalTypes: number;
	backfillCompletedTypes: number;
	lastAttemptAt?: number;
	lastSuccessfulSyncAt?: number;
	lastErrorCode?: string;
	lastErrorMessage?: string;
	nextRetryAt?: number;
	disconnectedAt?: number;
}

function flowError(code: string): GoogleHealthError {
	return new GoogleHealthError(code, null, false);
}

export function storedTokenEnvelope(connection: ConnectionRow): EncryptedTokenEnvelope | null {
	const { encryptedRefreshToken, tokenNonce, tokenTag, tokenKeyVersion } = connection;
	if (
		encryptedRefreshToken === null &&
		tokenNonce === null &&
		tokenTag === null &&
		tokenKeyVersion === null
	) {
		return null;
	}
	if (
		encryptedRefreshToken === null ||
		tokenNonce === null ||
		tokenTag === null ||
		tokenKeyVersion === null
	) {
		throw new Error('Incomplete Google Health token envelope');
	}
	return { encryptedRefreshToken, tokenNonce, tokenTag, tokenKeyVersion };
}

const CLEARED_TOKEN = {
	encryptedRefreshToken: null,
	tokenNonce: null,
	tokenTag: null,
	tokenKeyVersion: null
} as const;

async function connectionForUpdate(tx: Executor, userId: string): Promise<ConnectionRow | null> {
	const [connection] = await tx
		.select()
		.from(googleHealthConnection)
		.where(eq(googleHealthConnection.userId, userId))
		.for('update');
	return connection ?? null;
}

export async function getConnectionStatus(
	db: Database,
	userId: string
): Promise<ConnectionStatusView | null> {
	const [connection] = await db
		.select()
		.from(googleHealthConnection)
		.where(eq(googleHealthConnection.userId, userId));
	if (connection === undefined) return null;
	const ms = (value: Date | null) => (value === null ? undefined : value.getTime());
	return {
		status: connection.status,
		grantedScopes: connection.grantedScopes,
		backfillTotalTypes: connection.backfillTotalTypes,
		backfillCompletedTypes: connection.backfillCompletedTypes,
		lastAttemptAt: ms(connection.lastAttemptAt),
		lastSuccessfulSyncAt: ms(connection.lastSuccessfulSyncAt),
		lastErrorCode: connection.lastErrorCode ?? undefined,
		lastErrorMessage: connection.lastErrorMessage ?? undefined,
		nextRetryAt: ms(connection.nextRetryAt),
		disconnectedAt: ms(connection.disconnectedAt)
	};
}

/** Starts the OAuth flow, storing only a digest of the single-use state. */
export async function beginConnection(
	db: Database,
	config: GoogleHealthConfig,
	userId: string,
	returnPath: string
): Promise<{ authorizationUrl: string }> {
	if (returnPath !== IMPORT_RETURN_PATH) throw new Error('Invalid Google Health return path');
	const state = randomBytes(32).toString('base64url');
	const authorizationUrl = buildAuthorizationUrl({
		clientId: config.clientId,
		redirectUri: config.redirectUri,
		state
	});
	const [connection] = await db
		.select({
			id: googleHealthConnection.id,
			status: googleHealthConnection.status,
			generation: googleHealthConnection.generation
		})
		.from(googleHealthConnection)
		.where(eq(googleHealthConnection.userId, userId));
	if (connection?.status === 'deleting') {
		throw new Error('Google Health data deletion is in progress');
	}
	await db.insert(googleHealthOAuthState).values({
		userId,
		stateDigest: sha256Base64Url(state),
		returnPath,
		expectedConnectionId: connection?.id ?? null,
		expectedGeneration: connection?.generation ?? null,
		expiresAt: new Date(Date.now() + OAUTH_STATE_LIFETIME_MS)
	});
	return { authorizationUrl };
}

/**
 * Completes the OAuth callback: consumes the state, exchanges the code, stores the encrypted
 * refresh token and queues the historical import. Throws a {@link GoogleHealthError} on failure.
 */
export async function completeConnection(
	db: Database,
	config: GoogleHealthConfig,
	args: { code: string; state: string; userId: string }
): Promise<{ connectionId: string }> {
	if (!STATE_PATTERN.test(args.state)) throw flowError('invalid_state');
	// Claim the state once, but keep it until the connection is saved: deleting the connection
	// meanwhile removes the user's states, which cancels this callback.
	const [oauthState] = await db
		.update(googleHealthOAuthState)
		.set({ consumedAt: new Date() })
		.where(
			and(
				eq(googleHealthOAuthState.stateDigest, sha256Base64Url(args.state)),
				isNull(googleHealthOAuthState.consumedAt),
				sql`${googleHealthOAuthState.expiresAt} > now()`
			)
		)
		.returning();
	// The callback must land in the same HomeFit session that started the authorization.
	if (oauthState === undefined || oauthState.userId !== args.userId)
		throw flowError('invalid_state');
	if (oauthState.returnPath !== IMPORT_RETURN_PATH) throw flowError('invalid_return_path');

	const tokens = await exchangeAuthorizationCode({
		code: args.code,
		clientId: config.clientId,
		clientSecret: config.clientSecret,
		redirectUri: config.redirectUri
	});
	if (tokens.refreshToken === undefined) throw flowError('missing_refresh_token');
	if (tokens.grantedScopes.length === 0) throw flowError('invalid_granted_scopes');
	if (!tokens.grantedScopes.some((scope) => IMPORTABLE_SCOPES.has(scope))) {
		throw flowError('no_importable_scopes');
	}
	const { healthUserId } = await getHealthIdentity(tokens.accessToken);
	const envelope = await encryptRefreshToken(
		tokens.refreshToken,
		oauthState.userId,
		config.keyring.activeKey,
		config.keyring.activeVersion
	);
	const grantedScopes = [...new Set(tokens.grantedScopes)];

	try {
		return await db.transaction(async (tx) => {
			const existing = await connectionForUpdate(tx, oauthState.userId);
			const [claimed] = await tx
				.delete(googleHealthOAuthState)
				.where(eq(googleHealthOAuthState.id, oauthState.id))
				.returning({ id: googleHealthOAuthState.id });
			if (claimed === undefined) {
				throw new Error('Google Health authorization was cancelled');
			}
			if (
				(existing?.id ?? null) !== oauthState.expectedConnectionId ||
				(existing?.generation ?? null) !== oauthState.expectedGeneration
			) {
				throw new Error('Google Health connection changed during authorization');
			}
			if (existing?.status === 'deleting') {
				throw new Error('Google Health data deletion is in progress');
			}
			const generation = (existing?.generation ?? 0) + 1;
			const values = {
				healthUserId,
				status: 'backfilling' as const,
				...envelope,
				grantedScopes,
				generation,
				backfillTotalTypes: 0,
				backfillCompletedTypes: 0,
				lastErrorCode: null,
				lastErrorMessage: null,
				nextRetryAt: null,
				disconnectedAt: null
			};
			let connectionId: string;
			if (existing === null) {
				const [created] = await tx
					.insert(googleHealthConnection)
					.values({ userId: oauthState.userId, ...values })
					.returning({ id: googleHealthConnection.id });
				connectionId = created.id;
			} else {
				connectionId = existing.id;
				await tx
					.update(googleHealthConnection)
					.set(values)
					.where(eq(googleHealthConnection.id, connectionId));
				await failRunningRuns(tx, connectionId, 'stale_generation');
			}
			const total = await initializeBackfillCursors(tx, {
				connectionId,
				generation,
				grantedScopes
			});
			await tx
				.update(googleHealthConnection)
				.set({ backfillTotalTypes: total })
				.where(eq(googleHealthConnection.id, connectionId));
			return { connectionId };
		});
	} catch {
		await revokeEnvelope(config, oauthState.userId, envelope);
		throw flowError('connection_lifecycle_changed');
	}
}

/** Queues an overlapping reconciliation of every granted metric. */
export async function requestManualSync(
	db: Database,
	userId: string
): Promise<{ connectionId: string; queued: number }> {
	return await db.transaction(async (tx) => {
		const connection = await connectionForUpdate(tx, userId);
		if (connection === null) throw new Error('Google Health connection not found');
		if (connection.status !== 'active' && connection.status !== 'backfilling') {
			throw new Error('Google Health connection is not ready to sync');
		}
		const queued = await queueReconciliation(tx, toCursorOwner(connection), 'manual', Date.now());
		return { connectionId: connection.id, queued };
	});
}

export function toCursorOwner(connection: ConnectionRow) {
	return {
		connectionId: connection.id,
		generation: connection.generation,
		grantedScopes: connection.grantedScopes
	};
}

async function failRunningRuns(
	tx: Executor,
	connectionId: string,
	errorCode: string
): Promise<void> {
	await tx
		.update(googleHealthSyncRun)
		.set({
			status: 'failed',
			finishedAt: new Date(),
			errorCode,
			errorMessage: 'Google Health connection generation changed'
		})
		.where(
			and(
				eq(googleHealthSyncRun.connectionId, connectionId),
				eq(googleHealthSyncRun.status, 'running')
			)
		);
}

/**
 * Stops synchronization and removes the usable credential while retaining imported data.
 * Remote revocation is best effort: local invalidation is authoritative.
 */
export async function disconnect(
	db: Database,
	config: GoogleHealthConfig,
	userId: string
): Promise<void> {
	const envelope = await db.transaction(async (tx) => {
		const connection = await connectionForUpdate(tx, userId);
		if (connection === null) throw new Error('Google Health connection not found');
		if (connection.status === 'deleting')
			throw new Error('Google Health data deletion is in progress');
		if (connection.status === 'disconnected') return null;
		await failRunningRuns(tx, connection.id, 'disconnected');
		await tx
			.update(googleHealthConnection)
			.set({
				status: 'disconnected',
				generation: connection.generation + 1,
				...CLEARED_TOKEN,
				lastErrorCode: null,
				lastErrorMessage: null,
				nextRetryAt: null,
				disconnectedAt: new Date()
			})
			.where(eq(googleHealthConnection.id, connection.id));
		return storedTokenEnvelope(connection);
	});
	if (envelope !== null) await revokeEnvelope(config, userId, envelope);
}

/**
 * Marks the connection for deletion and invalidates its credential. The caller must schedule
 * {@link deleteConnectionDataBatch} until it reports completion.
 */
export async function beginDeletion(
	db: Database,
	config: GoogleHealthConfig,
	userId: string,
	confirmation: string
): Promise<{ connectionId: string; generation: number }> {
	if (confirmation !== DELETE_CONFIRMATION)
		throw new Error(`Type ${DELETE_CONFIRMATION} to confirm`);
	const { connectionId, generation, envelope } = await db.transaction(async (tx) => {
		const connection = await connectionForUpdate(tx, userId);
		if (connection === null) throw new Error('Google Health connection not found');
		if (connection.status === 'deleting') {
			return { connectionId: connection.id, generation: connection.generation, envelope: null };
		}
		await failRunningRuns(tx, connection.id, 'deleting');
		await tx
			.update(googleHealthConnection)
			.set({
				status: 'deleting',
				generation: connection.generation + 1,
				...CLEARED_TOKEN,
				lastErrorCode: null,
				lastErrorMessage: null,
				nextRetryAt: null,
				disconnectedAt: new Date()
			})
			.where(eq(googleHealthConnection.id, connection.id));
		return {
			connectionId: connection.id,
			generation: connection.generation + 1,
			envelope: storedTokenEnvelope(connection)
		};
	});
	if (envelope !== null) await revokeEnvelope(config, userId, envelope);
	return { connectionId, generation };
}

/**
 * Deletes one bounded batch of Google-imported points. Once none remain the connection row is
 * removed, which cascades to summaries, cursors, runs and tombstones. CSV imports are untouched.
 */
export async function deleteConnectionDataBatch(
	db: Database,
	connectionId: string,
	generation: number
): Promise<'continue' | 'done' | 'stale'> {
	return await db.transaction(async (tx) => {
		const [connection] = await tx
			.select()
			.from(googleHealthConnection)
			.where(eq(googleHealthConnection.id, connectionId))
			.for('update');
		if (connection === undefined) return 'done';
		if (connection.status !== 'deleting' || connection.generation !== generation) return 'stale';
		const batch = tx
			.select({ id: healthDataPoint.id })
			.from(healthDataPoint)
			.where(eq(healthDataPoint.connectionId, connectionId))
			.limit(DELETE_BATCH_SIZE);
		const deleted = await tx
			.delete(healthDataPoint)
			.where(inArray(healthDataPoint.id, batch))
			.returning({ id: healthDataPoint.id });
		if (deleted.length > 0) return 'continue';
		await tx
			.delete(googleHealthOAuthState)
			.where(eq(googleHealthOAuthState.userId, connection.userId));
		await tx.delete(googleHealthConnection).where(eq(googleHealthConnection.id, connectionId));
		return 'done';
	});
}

/** Connections whose deletion was requested, so an interrupted deletion can be resumed. */
export async function findPendingDeletions(
	db: Database
): Promise<{ connectionId: string; generation: number }[]> {
	return await db
		.select({
			connectionId: googleHealthConnection.id,
			generation: googleHealthConnection.generation
		})
		.from(googleHealthConnection)
		.where(eq(googleHealthConnection.status, 'deleting'));
}

async function revokeEnvelope(
	config: GoogleHealthConfig,
	userId: string,
	envelope: EncryptedTokenEnvelope
): Promise<void> {
	try {
		const { refreshToken } = await decryptRefreshToken(envelope, userId, config.keyring);
		await revokeGoogleToken(refreshToken);
	} catch {
		// Local invalidation already committed; remote revocation is best effort.
	}
}

/** Best-effort revocation of a user's Google grant, used before their account is deleted. */
export async function revokeUserAccess(
	db: Database,
	config: GoogleHealthConfig,
	userId: string
): Promise<void> {
	const [connection] = await db
		.select()
		.from(googleHealthConnection)
		.where(eq(googleHealthConnection.userId, userId));
	if (connection === undefined) return;
	const envelope = storedTokenEnvelope(connection);
	if (envelope !== null) await revokeEnvelope(config, userId, envelope);
}
