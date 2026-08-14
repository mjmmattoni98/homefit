/// <reference types="vite/client" />

import type { FunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../_generated/api';
import schema from '../schema';

const modules = import.meta.glob('/src/convex/**/*.*s');

const googleHealthApi = api as typeof api & {
	googleHealth: {
		model: {
			getConnectionStatus: FunctionReference<
				'query',
				'public',
				Record<string, never>,
				{
					status:
						| 'connecting'
						| 'backfilling'
						| 'active'
						| 'delayed'
						| 'action_required'
						| 'disconnected'
						| 'deleting';
					grantedScopes: string[];
					backfillTotalTypes: number;
					backfillCompletedTypes: number;
					lastAttemptAt?: number;
					lastSuccessfulSyncAt?: number;
					lastErrorCode?: string;
					lastErrorMessage?: string;
					nextRetryAt?: number;
					disconnectedAt?: number;
				} | null
			>;
		};
	};
};

describe('Google Health ownership foundation', () => {
	it('rejects unauthenticated status reads', async () => {
		const t = convexTest(schema, modules);

		await expect(
			t.query(googleHealthApi.googleHealth.model.getConnectionStatus, {})
		).rejects.toThrow('Not authenticated');
	});

	it('isolates status reads by the authenticated token identifier', async () => {
		const t = convexTest(schema, modules);
		const aliceId = 'clerk|user-alice';
		const bobId = 'clerk|user-bob';

		await t.run(async (ctx) => {
			await ctx.db.insert('googleHealthConnections', {
				userId: aliceId,
				healthUserId: 'google-health-alice',
				status: 'active',
				encryptedRefreshToken: 'encrypted-alice',
				tokenNonce: 'nonce-alice',
				tokenTag: 'tag-alice',
				tokenKeyVersion: 'v1',
				grantedScopes: ['scope-alice'],
				generation: 1,
				backfillTotalTypes: 40,
				backfillCompletedTypes: 40,
				lastAttemptAt: 1_723_600_000_000,
				lastSuccessfulSyncAt: 1_723_600_000_000
			});
			await ctx.db.insert('googleHealthConnections', {
				userId: bobId,
				healthUserId: 'google-health-bob',
				status: 'backfilling',
				encryptedRefreshToken: 'encrypted-bob',
				tokenNonce: 'nonce-bob',
				tokenTag: 'tag-bob',
				tokenKeyVersion: 'v1',
				grantedScopes: ['scope-bob'],
				generation: 1,
				backfillTotalTypes: 40,
				backfillCompletedTypes: 7,
				lastAttemptAt: 1_723_600_100_000
			});
		});

		const sharedIdentity = {
			issuer: 'https://clerk.example.test',
			subject: 'same-subject'
		};
		const alice = t.withIdentity({
			...sharedIdentity,
			tokenIdentifier: aliceId
		});
		const bob = t.withIdentity({
			...sharedIdentity,
			tokenIdentifier: bobId
		});
		const userWithoutConnection = t.withIdentity({
			...sharedIdentity,
			tokenIdentifier: 'clerk|user-without-connection'
		});

		const statuses = await Promise.all([
			alice.query(googleHealthApi.googleHealth.model.getConnectionStatus, {}),
			bob.query(googleHealthApi.googleHealth.model.getConnectionStatus, {}),
			userWithoutConnection.query(googleHealthApi.googleHealth.model.getConnectionStatus, {})
		]);

		expect(statuses).toEqual([
			{
				status: 'active',
				grantedScopes: ['scope-alice'],
				backfillTotalTypes: 40,
				backfillCompletedTypes: 40,
				lastAttemptAt: 1_723_600_000_000,
				lastSuccessfulSyncAt: 1_723_600_000_000
			},
			{
				status: 'backfilling',
				grantedScopes: ['scope-bob'],
				backfillTotalTypes: 40,
				backfillCompletedTypes: 7,
				lastAttemptAt: 1_723_600_100_000
			},
			null
		]);
	});
});
