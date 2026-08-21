/// <reference types="vite/client" />

import { makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../_generated/dataModel';
import crons from '../crons';
import schema from '../schema';
import { encryptRefreshToken } from './crypto';
import { GOOGLE_HEALTH_READ_SCOPES, METRIC_DEFINITIONS, getMetricDefinition } from './registry';

const modules = import.meta.glob('/src/convex/**/*.*s');
const ACTIVE_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const NOW = Date.parse('2026-08-14T12:00:00Z');

const syncNow = makeFunctionReference<'mutation', Record<string, never>, { queued: number }>(
	'googleHealth/account:syncNow'
);
const disconnect = makeFunctionReference<
	'action',
	Record<string, never>,
	{ status: 'disconnected' }
>('googleHealth/account:disconnect');
const deleteImportedData = makeFunctionReference<
	'action',
	{ confirmation: string },
	{ status: 'deleting' }
>('googleHealth/account:deleteImportedData');
type ReconciliationCursor = { statusIndex: number; afterUserId?: string };
const scheduleDailyReconciliation = makeFunctionReference<
	'mutation',
	{ cursor?: ReconciliationCursor; anchorMs?: number },
	{ scheduled: number; continuationCursor?: ReconciliationCursor }
>('googleHealth/maintenance:scheduleDailyReconciliation');
const queueConnectionReconciliation = makeFunctionReference<
	'mutation',
	{
		connectionId: Id<'googleHealthConnections'>;
		generation: number;
		trigger: 'manual' | 'reconciliation';
		anchorMs: number;
	},
	{ queued: number; dispatched: boolean }
>('googleHealth/account:queueConnectionReconciliation');
const cleanupOperationalData = makeFunctionReference<
	'mutation',
	{ cursor?: unknown; anchorMs?: number },
	{ processed: number; complete: boolean }
>('googleHealth/maintenance:cleanupOperationalData');
const markCursorRunning = makeFunctionReference<
	'mutation',
	{
		cursorId: Id<'googleHealthSyncCursors'>;
		generation: number;
		trigger: 'manual';
		expectedDispatchVersion: number;
	},
	unknown
>('googleHealth/sync:markCursorRunning');
const finishDataType = makeFunctionReference<
	'mutation',
	{
		cursorId: Id<'googleHealthSyncCursors'>;
		generation: number;
		runId: Id<'googleHealthSyncRuns'>;
		counts: { fetched: number; inserted: number; updated: number; skipped: number };
	},
	boolean
>('googleHealth/sync:finishDataType');
const tryFinalizeRun = makeFunctionReference<
	'mutation',
	{ runId: Id<'googleHealthSyncRuns'> },
	boolean
>('googleHealth/sync:tryFinalizeRun');

function backend() {
	return convexTest({ schema, modules, transactionLimits: true });
}

async function seedConnection(
	t: ReturnType<typeof backend>,
	args: {
		userId?: string;
		status?: 'backfilling' | 'active' | 'delayed' | 'disconnected';
		grantedScopes?: readonly string[];
		generation?: number;
	} = {}
): Promise<Id<'googleHealthConnections'>> {
	const userId = args.userId ?? 'clerk|alice';
	const envelope = await encryptRefreshToken('refresh-token', userId, ACTIVE_KEY, 'v1');
	return await t.run(async (ctx) =>
		ctx.db.insert('googleHealthConnections', {
			userId,
			healthUserId: `${userId}-health`,
			status: args.status ?? 'active',
			...envelope,
			grantedScopes: [...(args.grantedScopes ?? GOOGLE_HEALTH_READ_SCOPES)],
			generation: args.generation ?? 1,
			reconciliationEpoch: 4,
			backfillTotalTypes: METRIC_DEFINITIONS.length,
			backfillCompletedTypes: METRIC_DEFINITIONS.length
		})
	);
}

describe('Google Health account lifecycle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		vi.stubEnv('GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY', ACTIVE_KEY);
		vi.stubEnv('GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION', 'v1');
		vi.stubEnv('GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS', '');
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it('authenticates manual sync and coalesces all 40 granted metrics with one dispatch', async () => {
		const t = backend();
		const connectionId = await seedConnection(t);
		const alice = t.withIdentity({ tokenIdentifier: 'clerk|alice' });
		const bob = t.withIdentity({ tokenIdentifier: 'clerk|bob' });

		await expect(t.mutation(syncNow, {})).rejects.toThrow('Not authenticated');
		await expect(bob.mutation(syncNow, {})).rejects.toThrow('Google Health connection not found');
		await expect(alice.mutation(syncNow, {})).resolves.toEqual({ queued: 40 });
		await expect(alice.mutation(syncNow, {})).resolves.toEqual({ queued: 40 });

		const stored = await t.run(async (ctx) => ({
			cursors: await ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|alice'))
				.take(50),
			scheduled: await ctx.db.system.query('_scheduled_functions').take(100)
		}));
		expect(stored.cursors).toHaveLength(40);
		expect(new Set(stored.cursors.map((cursor) => cursor.dataType)).size).toBe(40);
		expect(stored.cursors.every((cursor) => cursor.connectionId === connectionId)).toBe(true);
		expect(stored.cursors.every((cursor) => cursor.mode === 'incremental')).toBe(true);
		expect(stored.cursors.every((cursor) => cursor.status === 'queued')).toBe(true);
		expect(stored.cursors.every((cursor) => cursor.generation === 1)).toBe(true);
		expect(stored.cursors.every((cursor) => cursor.queuedTrigger === 'manual')).toBe(true);
		expect(
			stored.scheduled.filter((job) => job.name.endsWith(':ensureCursorDispatched'))
		).toHaveLength(1);

		const steps = stored.cursors.find((cursor) => cursor.dataType === 'steps');
		expect(steps).toMatchObject({
			windowStart: '2026-08-07T12:00:00.000000000Z',
			windowEnd: '2026-08-14T12:00:00.000000000Z'
		});
		const daily = stored.cursors.find((cursor) => cursor.dataType === 'total-calories');
		expect(daily).toMatchObject({ windowStart: '2026-08-08', windowEnd: '2026-08-15' });
		const reference = stored.cursors.find((cursor) => cursor.dataType === 'food');
		expect(reference?.windowStart).toBeUndefined();
		expect(reference?.windowEnd).toBeUndefined();
	});

	it('chains the next queued metric with its manual trigger instead of starting competing actions', async () => {
		const t = backend();
		const connectionId = await seedConnection(t);
		await t.withIdentity({ tokenIdentifier: 'clerk|alice' }).mutation(syncNow, {});
		const first = await t.run(async (ctx) => {
			const cursors = await ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
					q.eq('connectionId', connectionId)
				)
				.take(100);
			const cursor = cursors.find((candidate) => candidate.dispatchPending === true);
			if (cursor === undefined || cursor.dispatchVersion === undefined) {
				throw new Error('expected one dispatched cursor');
			}
			return { cursorId: cursor._id, dispatchVersion: cursor.dispatchVersion };
		});
		await t.mutation(markCursorRunning, {
			cursorId: first.cursorId,
			generation: 1,
			trigger: 'manual',
			expectedDispatchVersion: first.dispatchVersion
		});
		const runId = await t.run(async (ctx) => {
			const cursor = await ctx.db.get('googleHealthSyncCursors', first.cursorId);
			if (cursor?.activeRunId === undefined) throw new Error('expected active run');
			return cursor.activeRunId;
		});
		await expect(
			t.mutation(finishDataType, {
				cursorId: first.cursorId,
				generation: 1,
				runId,
				counts: { fetched: 0, inserted: 0, updated: 0, skipped: 0 }
			})
		).resolves.toBe(true);
		await expect(t.mutation(tryFinalizeRun, { runId })).resolves.toBe(true);

		const chained = await t.run(async (ctx) => ({
			cursors: await ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
					q.eq('connectionId', connectionId)
				)
				.take(100),
			jobs: await ctx.db.system.query('_scheduled_functions').take(100)
		}));
		expect(
			chained.cursors.filter(
				(cursor) => cursor.status === 'queued' && cursor.dispatchPending === true
			)
		).toHaveLength(1);
		const runJobs = chained.jobs.filter((job) => job.name === 'googleHealth/sync:runCursor');
		expect(runJobs).toHaveLength(2);
		expect(runJobs.every((job) => job.args[0]?.trigger === 'manual')).toBe(true);
	});

	it('disconnects locally despite revoke failure, invalidates active work, and retains imported data', async () => {
		const t = backend();
		const aliceConnectionId = await seedConnection(t);
		const bobConnectionId = await seedConnection(t, { userId: 'clerk|bob' });
		const seeded = await t.run(async (ctx) => {
			const cursorId = await ctx.db.insert('googleHealthSyncCursors', {
				connectionId: aliceConnectionId,
				userId: 'clerk|alice',
				dataType: 'steps',
				mode: 'incremental',
				status: 'running',
				windowStart: '2026-08-13T00:00:00.000000000Z',
				windowEnd: '2026-08-14T00:00:00.000000000Z',
				syncId: 'manual:1:steps',
				attempt: 0,
				generation: 1,
				dispatchVersion: 5,
				dispatchPending: true,
				updatedAt: NOW
			});
			const runId = await ctx.db.insert('googleHealthSyncRuns', {
				connectionId: aliceConnectionId,
				userId: 'clerk|alice',
				trigger: 'manual',
				dataType: 'steps',
				cursorId,
				generation: 1,
				reconciliationEpoch: 5,
				startedAt: NOW,
				pages: 0,
				fetched: 0,
				inserted: 0,
				updated: 0,
				deleted: 0,
				skipped: 0,
				status: 'running'
			});
			await ctx.db.patch('googleHealthSyncCursors', cursorId, {
				activeRunId: runId,
				activeEpoch: 5,
				leaseVersion: 8,
				leaseExpiresAt: NOW + 60_000
			});
			await ctx.db.patch('googleHealthConnections', aliceConnectionId, {
				activeSyncCursorId: cursorId,
				activeSyncRunId: runId,
				syncLeaseVersion: 8,
				syncLeaseExpiresAt: NOW + 60_000,
				lastErrorCode: 'temporary',
				lastErrorMessage: 'temporary',
				nextRetryAt: NOW + 5_000
			});
			const pointId = await ctx.db.insert('healthDataPoints', {
				connectionId: aliceConnectionId,
				userId: 'clerk|alice',
				provider: 'google_health',
				recordKey: 'alice-point',
				dataType: 'steps',
				category: 'activity',
				recordTimestamp: NOW,
				localDate: '2026-08-14',
				primaryValue: 100,
				primaryUnit: 'steps',
				payloadDigest: 'digest',
				payloadJson: '{}',
				lastSeenSyncId: 'manual:1:steps'
			});
			const summaryId = await ctx.db.insert('healthDailySummaries', {
				connectionId: aliceConnectionId,
				userId: 'clerk|alice',
				dataType: 'steps',
				category: 'activity',
				localDate: '2026-08-14',
				count: 1,
				sum: 100,
				computedAt: NOW
			});
			return { cursorId, runId, pointId, summaryId };
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Promise.reject(new Error('offline')))
		);

		await expect(
			t.withIdentity({ tokenIdentifier: 'clerk|alice' }).action(disconnect, {})
		).resolves.toEqual({ status: 'disconnected' });
		await expect(
			t.mutation(markCursorRunning, {
				cursorId: seeded.cursorId,
				generation: 1,
				trigger: 'manual',
				expectedDispatchVersion: 5
			})
		).resolves.toBeNull();

		const stored = await t.run(async (ctx) => ({
			alice: await ctx.db.get('googleHealthConnections', aliceConnectionId),
			bob: await ctx.db.get('googleHealthConnections', bobConnectionId),
			cursor: await ctx.db.get('googleHealthSyncCursors', seeded.cursorId),
			run: await ctx.db.get('googleHealthSyncRuns', seeded.runId),
			point: await ctx.db.get('healthDataPoints', seeded.pointId),
			summary: await ctx.db.get('healthDailySummaries', seeded.summaryId)
		}));
		expect(stored.alice).toMatchObject({
			status: 'disconnected',
			generation: 2,
			disconnectedAt: NOW
		});
		expect(stored.alice?.encryptedRefreshToken).toBeUndefined();
		expect(stored.alice?.tokenNonce).toBeUndefined();
		expect(stored.alice?.tokenTag).toBeUndefined();
		expect(stored.alice?.tokenKeyVersion).toBeUndefined();
		expect(stored.alice?.activeSyncCursorId).toBeUndefined();
		expect(stored.alice?.activeSyncRunId).toBeUndefined();
		expect(stored.alice?.nextRetryAt).toBeUndefined();
		expect(stored.run).toMatchObject({ status: 'failed', errorCode: 'stale_generation' });
		expect(stored.cursor).toMatchObject({
			status: 'retry',
			generation: 1,
			dispatchVersion: 6,
			dispatchPending: false
		});
		expect(stored.cursor?.activeRunId).toBeUndefined();
		expect(stored.point).not.toBeNull();
		expect(stored.summary).not.toBeNull();
		expect(stored.bob).toMatchObject({ status: 'active', generation: 1 });
	});

	it('requires exact confirmation and deletes only owned Google artifacts in bounded idempotent phases', async () => {
		const t = backend();
		const aliceConnectionId = await seedConnection(t);
		const bobConnectionId = await seedConnection(t, { userId: 'clerk|bob' });
		const retained = await t.run(async (ctx) => {
			const aliceCursorId = await ctx.db.insert('googleHealthSyncCursors', {
				connectionId: aliceConnectionId,
				userId: 'clerk|alice',
				dataType: 'steps',
				mode: 'incremental',
				status: 'complete',
				syncId: 'manual:1:steps',
				attempt: 0,
				generation: 1,
				updatedAt: NOW
			});
			const aliceRunId = await ctx.db.insert('googleHealthSyncRuns', {
				connectionId: aliceConnectionId,
				userId: 'clerk|alice',
				trigger: 'manual',
				dataType: 'steps',
				cursorId: aliceCursorId,
				generation: 1,
				startedAt: NOW,
				finishedAt: NOW,
				pages: 1,
				fetched: 1,
				inserted: 1,
				updated: 0,
				deleted: 0,
				skipped: 0,
				status: 'succeeded'
			});
			const alicePointId = await ctx.db.insert('healthDataPoints', {
				connectionId: aliceConnectionId,
				userId: 'clerk|alice',
				provider: 'google_health',
				recordKey: 'alice-large-point',
				dataType: 'steps',
				category: 'activity',
				recordTimestamp: NOW,
				localDate: '2026-08-14',
				primaryValue: 1,
				primaryUnit: 'steps',
				payloadDigest: 'digest',
				payloadJson: 'x'.repeat(749_000),
				lastSeenSyncId: 'manual:1:steps'
			});
			await ctx.db.insert('healthDataPointContributions', {
				connectionId: aliceConnectionId,
				dataPointId: alicePointId,
				userId: 'clerk|alice',
				recordKey: 'alice-large-point',
				dataType: 'steps',
				category: 'activity',
				localDate: '2026-08-14',
				recordTimestamp: NOW,
				primaryValue: 1,
				physicalCoverageKey: '2026-08-14T12:00:00.000000000Z',
				seenEpoch: 1
			});
			const rebuildId = await ctx.db.insert('healthSummaryRebuilds', {
				connectionId: aliceConnectionId,
				userId: 'clerk|alice',
				dataType: 'steps',
				category: 'activity',
				localDate: '2026-08-14',
				version: 1,
				status: 'queued',
				count: 0,
				valueCount: 0,
				sum: 0,
				durationSeconds: 0,
				updatedAt: NOW
			});
			await ctx.db.insert('healthSummaryDependencies', {
				connectionId: aliceConnectionId,
				cursorId: aliceCursorId,
				runId: aliceRunId,
				rebuildId,
				userId: 'clerk|alice',
				dataType: 'steps',
				localDate: '2026-08-14',
				targetVersion: 1
			});
			await ctx.db.insert('healthDailySummaries', {
				connectionId: aliceConnectionId,
				userId: 'clerk|alice',
				dataType: 'steps',
				category: 'activity',
				localDate: '2026-08-14',
				count: 1,
				sum: 1,
				computedAt: NOW
			});
			await ctx.db.insert('googleHealthOAuthStates', {
				userId: 'clerk|alice',
				stateDigest: 'alice-oauth',
				expiresAt: NOW + 60_000,
				returnPath: '/dashboard/import'
			});
			await ctx.db.insert('googleHealthRecordTombstones', {
				connectionId: aliceConnectionId,
				userId: 'clerk|alice',
				generation: 1,
				dataType: 'steps',
				recordKey: 'alice-tombstone',
				blockedThroughEpoch: 4,
				updatedAt: NOW
			});
			const bobPointId = await ctx.db.insert('healthDataPoints', {
				connectionId: bobConnectionId,
				userId: 'clerk|bob',
				provider: 'google_health',
				recordKey: 'bob-point',
				dataType: 'steps',
				category: 'activity',
				recordTimestamp: NOW,
				localDate: '2026-08-14',
				primaryValue: 2,
				primaryUnit: 'steps',
				payloadDigest: 'digest',
				payloadJson: '{}',
				lastSeenSyncId: 'manual:1:steps'
			});
			const workoutId = await ctx.db.insert('workouts', {
				userId: 'clerk|alice',
				title: 'Hevy workout',
				startTime: NOW,
				endTime: NOW + 3_600_000,
				description: 'keep'
			});
			const sleepId = await ctx.db.insert('sleepRecords', {
				userId: 'clerk|alice',
				wentToBed: NOW - 28_800_000,
				wokeUp: NOW,
				sleepQuality: 90,
				timeInBedSeconds: 28_800,
				timeAsleepSeconds: 27_000,
				asleepAfterSeconds: 600,
				didSnore: false,
				snoreTimeSeconds: 0,
				notes: []
			});
			return { bobPointId, workoutId, sleepId };
		});
		const alice = t.withIdentity({ tokenIdentifier: 'clerk|alice' });
		await expect(
			alice.action(deleteImportedData, { confirmation: 'delete google data' })
		).rejects.toThrow('Type DELETE GOOGLE DATA to confirm');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 200 }))
		);

		await expect(
			alice.action(deleteImportedData, { confirmation: 'DELETE GOOGLE DATA' })
		).resolves.toEqual({ status: 'deleting' });
		await expect(
			alice.action(deleteImportedData, { confirmation: 'DELETE GOOGLE DATA' })
		).resolves.toEqual({ status: 'deleting' });
		const deleting = await t.run(async (ctx) => ({
			connection: await ctx.db.get('googleHealthConnections', aliceConnectionId),
			jobs: await ctx.db.system.query('_scheduled_functions').take(10)
		}));
		expect(deleting.connection).toMatchObject({ status: 'deleting', generation: 2 });
		expect(
			deleting.jobs.filter((job) => job.name === 'googleHealth/account:deleteGoogleDataBatch')
		).toHaveLength(1);

		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const stored = await t.run(async (ctx) => ({
			aliceConnection: await ctx.db.get('googleHealthConnections', aliceConnectionId),
			bobConnection: await ctx.db.get('googleHealthConnections', bobConnectionId),
			bobPoint: await ctx.db.get('healthDataPoints', retained.bobPointId),
			workout: await ctx.db.get('workouts', retained.workoutId),
			sleep: await ctx.db.get('sleepRecords', retained.sleepId),
			alicePoints: await ctx.db
				.query('healthDataPoints')
				.withIndex('by_connectionId', (q) => q.eq('connectionId', aliceConnectionId))
				.take(1),
			aliceSummaries: await ctx.db
				.query('healthDailySummaries')
				.withIndex('by_connectionId', (q) => q.eq('connectionId', aliceConnectionId))
				.take(1),
			aliceContributions: await ctx.db
				.query('healthDataPointContributions')
				.withIndex('by_connectionId_and_dataType_and_physicalCoverageKey', (q) =>
					q.eq('connectionId', aliceConnectionId)
				)
				.take(1),
			aliceRebuilds: await ctx.db
				.query('healthSummaryRebuilds')
				.withIndex('by_connectionId', (q) => q.eq('connectionId', aliceConnectionId))
				.take(1),
			aliceDependencies: await ctx.db
				.query('healthSummaryDependencies')
				.withIndex('by_connectionId', (q) => q.eq('connectionId', aliceConnectionId))
				.take(1),
			aliceTombstones: await ctx.db
				.query('googleHealthRecordTombstones')
				.withIndex('by_connectionId_and_generation_and_recordKey', (q) =>
					q.eq('connectionId', aliceConnectionId)
				)
				.take(1),
			aliceOAuth: await ctx.db
				.query('googleHealthOAuthStates')
				.withIndex('by_userId', (q) => q.eq('userId', 'clerk|alice'))
				.take(1),
			aliceCursors: await ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
					q.eq('connectionId', aliceConnectionId)
				)
				.take(1),
			aliceRuns: await ctx.db
				.query('googleHealthSyncRuns')
				.withIndex('by_connectionId_and_startedAt', (q) => q.eq('connectionId', aliceConnectionId))
				.take(1)
		}));
		expect(stored.aliceConnection).toBeNull();
		expect(stored.alicePoints).toHaveLength(0);
		expect(stored.aliceSummaries).toHaveLength(0);
		expect(stored.aliceContributions).toHaveLength(0);
		expect(stored.aliceRebuilds).toHaveLength(0);
		expect(stored.aliceDependencies).toHaveLength(0);
		expect(stored.aliceTombstones).toHaveLength(0);
		expect(stored.aliceOAuth).toHaveLength(0);
		expect(stored.aliceCursors).toHaveLength(0);
		expect(stored.aliceRuns).toHaveLength(0);
		expect(stored.bobConnection).toMatchObject({ status: 'active' });
		expect(stored.bobPoint).not.toBeNull();
		expect(stored.workout).not.toBeNull();
		expect(stored.sleep).not.toBeNull();
	});
});

describe('Google Health maintenance', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it('coordinates 51 connections in batches of 50 and queues exact overlap without stale dispatch blockage', async () => {
		const t = backend();
		const stepsScope = getMetricDefinition('steps')?.scope;
		if (stepsScope === undefined) throw new Error('steps metric missing');
		const connectionIds = await t.run(async (ctx) => {
			const ids: Id<'googleHealthConnections'>[] = [];
			for (let index = 0; index < 51; index += 1) {
				ids.push(
					await ctx.db.insert('googleHealthConnections', {
						userId: `clerk|daily-${String(index).padStart(3, '0')}`,
						healthUserId: `health-daily-${index}`,
						status: index === 49 ? 'delayed' : index === 50 ? 'backfilling' : 'active',
						grantedScopes: [stepsScope],
						generation: 2,
						backfillTotalTypes: 1,
						backfillCompletedTypes: index === 50 ? 0 : 1
					})
				);
			}
			await ctx.db.insert('googleHealthSyncCursors', {
				connectionId: ids[0],
				userId: 'clerk|daily-000',
				dataType: 'sleep',
				mode: 'incremental',
				status: 'queued',
				queuedTrigger: 'webhook',
				dispatchVersion: 9,
				dispatchPending: true,
				syncId: 'webhook:1:sleep:old',
				attempt: 0,
				generation: 1,
				updatedAt: NOW - 1
			});
			return ids;
		});

		const first = await t.mutation(scheduleDailyReconciliation, { anchorMs: NOW });
		expect(first.scheduled).toBe(50);
		expect(first.continuationCursor).toBeDefined();
		const scheduledAfterFirst = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').take(100)
		);
		expect(
			scheduledAfterFirst.filter(
				(job) => job.name === 'googleHealth/account:queueConnectionReconciliation'
			)
		).toHaveLength(50);
		expect(
			scheduledAfterFirst.filter(
				(job) => job.name === 'googleHealth/maintenance:scheduleDailyReconciliation'
			)
		).toHaveLength(1);

		const second = await t.mutation(scheduleDailyReconciliation, {
			cursor: first.continuationCursor,
			anchorMs: NOW
		});
		expect(second).toEqual({ scheduled: 1 });

		await expect(
			t.mutation(queueConnectionReconciliation, {
				connectionId: connectionIds[0],
				generation: 2,
				trigger: 'reconciliation',
				anchorMs: NOW
			})
		).resolves.toEqual({
			queued: METRIC_DEFINITIONS.filter((definition) => definition.scope === stepsScope).length,
			dispatched: true
		});
		const queued = await t.run(async (ctx) => ({
			steps: await ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
					q.eq('connectionId', connectionIds[0]).eq('dataType', 'steps').eq('mode', 'incremental')
				)
				.unique(),
			currentCursors: await ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
					q.eq('connectionId', connectionIds[0])
				)
				.take(100),
			jobs: await ctx.db.system.query('_scheduled_functions').take(200)
		}));
		expect(queued.steps).toMatchObject({
			status: 'queued',
			generation: 2,
			queuedTrigger: 'reconciliation',
			windowStart: '2026-08-07T12:00:00.000000000Z',
			windowEnd: '2026-08-14T12:00:00.000000000Z'
		});
		expect(
			queued.currentCursors.filter(
				(cursor) => cursor.generation === 2 && cursor.dispatchPending === true
			)
		).toHaveLength(1);
		expect(queued.jobs.filter((job) => job.name === 'googleHealth/sync:runCursor')).toHaveLength(1);
	});

	it('revives a deterministic unscheduled retry during daily reconciliation', async () => {
		const t = backend();
		const stepsScope = getMetricDefinition('steps')?.scope;
		if (stepsScope === undefined) throw new Error('steps metric missing');
		const connectionId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('googleHealthConnections', {
				userId: 'clerk|delayed',
				healthUserId: 'health-delayed',
				status: 'delayed',
				grantedScopes: [stepsScope],
				generation: 4,
				backfillTotalTypes: 18,
				backfillCompletedTypes: 18,
				lastErrorCode: 'deterministic_failure',
				lastErrorMessage: 'Google Health synchronization failed'
			});
			await ctx.db.insert('googleHealthSyncCursors', {
				connectionId: id,
				userId: 'clerk|delayed',
				dataType: 'steps',
				mode: 'incremental',
				status: 'retry',
				windowStart: '2026-08-01T00:00:00.000000000Z',
				windowEnd: '2026-08-02T00:00:00.000000000Z',
				syncId: 'retry:4:steps',
				attempt: 3,
				generation: 4,
				dispatchPending: false,
				updatedAt: NOW - 1
			});
			return id;
		});

		await t.mutation(queueConnectionReconciliation, {
			connectionId,
			generation: 4,
			trigger: 'reconciliation',
			anchorMs: NOW
		});
		const cursor = await t.run(async (ctx) =>
			ctx.db
				.query('googleHealthSyncCursors')
				.withIndex('by_connectionId_and_dataType_and_mode', (q) =>
					q.eq('connectionId', connectionId).eq('dataType', 'steps').eq('mode', 'incremental')
				)
				.unique()
		);
		expect(cursor).toMatchObject({
			status: 'queued',
			attempt: 0,
			queuedTrigger: 'reconciliation'
		});
		expect(cursor?.pendingWindowStart).toBeUndefined();
	});

	it('cleans exact operational cutoffs, terminalizes seven-day raw deliveries, and removes stale tombstones', async () => {
		const t = backend();
		const day = 24 * 60 * 60 * 1000;
		const seeded = await t.run(async (ctx) => {
			const connectionId = await ctx.db.insert('googleHealthConnections', {
				userId: 'clerk|maintenance',
				healthUserId: 'health-maintenance',
				status: 'active',
				grantedScopes: [],
				generation: 2,
				backfillTotalTypes: 0,
				backfillCompletedTypes: 0
			});
			for (let index = 0; index < 101; index += 1) {
				await ctx.db.insert('googleHealthOAuthStates', {
					userId: `expired-${index}`,
					stateDigest: `expired-${index}`,
					expiresAt: NOW,
					returnPath: '/dashboard/import'
				});
			}
			const liveOAuthId = await ctx.db.insert('googleHealthOAuthStates', {
				userId: 'live',
				stateDigest: 'live',
				expiresAt: NOW + 1,
				returnPath: '/dashboard/import'
			});
			const insertRun = async (status: 'running' | 'succeeded' | 'failed', startedAt: number) =>
				await ctx.db.insert('googleHealthSyncRuns', {
					connectionId,
					userId: 'clerk|maintenance',
					trigger: 'reconciliation',
					dataType: 'steps',
					generation: 2,
					startedAt,
					...(status === 'running' ? {} : { finishedAt: startedAt + 1 }),
					pages: 1,
					fetched: 0,
					inserted: 0,
					updated: 0,
					deleted: 0,
					skipped: 0,
					status
				});
			const oldSucceededId = await insertRun('succeeded', NOW - 30 * day - 1);
			const cutoffSucceededId = await insertRun('succeeded', NOW - 30 * day);
			const oldFailedId = await insertRun('failed', NOW - 90 * day - 1);
			const cutoffFailedId = await insertRun('failed', NOW - 90 * day);
			const oldRunningId = await insertRun('running', NOW - 365 * day);
			const notification = [
				{
					healthUserId: 'health-maintenance',
					dataType: 'steps',
					operation: 'UPSERT' as const,
					windowStart: '2026-08-01T00:00:00.000000000Z',
					windowEnd: '2026-08-02T00:00:00.000000000Z'
				}
			];
			const staleRawId = await ctx.db.insert('googleHealthWebhookDeliveries', {
				deliveryDigest: 'stale-raw',
				status: 'verifying',
				rawBody: '{"secret":"raw"}',
				signature: 'signature',
				notifications: notification,
				nextNotificationIndex: 0,
				attempt: 3,
				leaseVersion: 4,
				leaseExpiresAt: NOW + day,
				nextAttemptAt: NOW + day,
				updatedAt: NOW - 7 * day - 1
			});
			const recentRawId = await ctx.db.insert('googleHealthWebhookDeliveries', {
				deliveryDigest: 'recent-raw',
				status: 'retry',
				rawBody: '{"recent":true}',
				signature: 'recent-signature',
				attempt: 1,
				leaseVersion: 1,
				updatedAt: NOW - 7 * day
			});
			const oldCompleteId = await ctx.db.insert('googleHealthWebhookDeliveries', {
				deliveryDigest: 'old-complete',
				status: 'complete',
				attempt: 0,
				leaseVersion: 0,
				updatedAt: NOW - 8 * day - 1
			});
			const cutoffRejectedId = await ctx.db.insert('googleHealthWebhookDeliveries', {
				deliveryDigest: 'cutoff-rejected',
				status: 'rejected',
				attempt: 0,
				leaseVersion: 0,
				updatedAt: NOW - 8 * day
			});
			const staleTombstoneId = await ctx.db.insert('googleHealthRecordTombstones', {
				connectionId,
				userId: 'clerk|maintenance',
				generation: 1,
				dataType: 'steps',
				recordKey: 'stale-generation',
				blockedThroughEpoch: 1,
				updatedAt: NOW - 8 * day - 1
			});
			const currentTombstoneId = await ctx.db.insert('googleHealthRecordTombstones', {
				connectionId,
				userId: 'clerk|maintenance',
				generation: 2,
				dataType: 'steps',
				recordKey: 'current-generation',
				blockedThroughEpoch: 2,
				updatedAt: NOW - 8 * day - 1
			});
			return {
				liveOAuthId,
				oldSucceededId,
				cutoffSucceededId,
				oldFailedId,
				cutoffFailedId,
				oldRunningId,
				staleRawId,
				recentRawId,
				oldCompleteId,
				cutoffRejectedId,
				staleTombstoneId,
				currentTombstoneId
			};
		});

		await expect(t.mutation(cleanupOperationalData, { anchorMs: NOW })).resolves.toMatchObject({
			processed: 100,
			complete: false
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const stored = await t.run(async (ctx) => ({
			expiredOAuth: await ctx.db
				.query('googleHealthOAuthStates')
				.withIndex('by_expiresAt', (q) => q.lte('expiresAt', NOW))
				.take(1),
			liveOAuth: await ctx.db.get('googleHealthOAuthStates', seeded.liveOAuthId),
			oldSucceeded: await ctx.db.get('googleHealthSyncRuns', seeded.oldSucceededId),
			cutoffSucceeded: await ctx.db.get('googleHealthSyncRuns', seeded.cutoffSucceededId),
			oldFailed: await ctx.db.get('googleHealthSyncRuns', seeded.oldFailedId),
			cutoffFailed: await ctx.db.get('googleHealthSyncRuns', seeded.cutoffFailedId),
			oldRunning: await ctx.db.get('googleHealthSyncRuns', seeded.oldRunningId),
			staleRaw: await ctx.db.get('googleHealthWebhookDeliveries', seeded.staleRawId),
			recentRaw: await ctx.db.get('googleHealthWebhookDeliveries', seeded.recentRawId),
			oldComplete: await ctx.db.get('googleHealthWebhookDeliveries', seeded.oldCompleteId),
			cutoffRejected: await ctx.db.get('googleHealthWebhookDeliveries', seeded.cutoffRejectedId),
			staleTombstone: await ctx.db.get('googleHealthRecordTombstones', seeded.staleTombstoneId),
			currentTombstone: await ctx.db.get('googleHealthRecordTombstones', seeded.currentTombstoneId)
		}));
		expect(stored.expiredOAuth).toHaveLength(0);
		expect(stored.liveOAuth).not.toBeNull();
		expect(stored.oldSucceeded).toBeNull();
		expect(stored.cutoffSucceeded).not.toBeNull();
		expect(stored.oldFailed).toBeNull();
		expect(stored.cutoffFailed).not.toBeNull();
		expect(stored.oldRunning).not.toBeNull();
		expect(stored.staleRaw).toMatchObject({
			status: 'rejected',
			lastErrorCode: 'delivery_retention_expired',
			updatedAt: NOW
		});
		expect(stored.staleRaw?.rawBody).toBeUndefined();
		expect(stored.staleRaw?.signature).toBeUndefined();
		expect(stored.staleRaw?.notifications).toBeUndefined();
		expect(stored.staleRaw?.nextAttemptAt).toBeUndefined();
		expect(stored.recentRaw).toMatchObject({ status: 'retry', rawBody: '{"recent":true}' });
		expect(stored.oldComplete).toBeNull();
		expect(stored.cutoffRejected).not.toBeNull();
		expect(stored.staleTombstone).toBeNull();
		expect(stored.currentTombstone).not.toBeNull();
	});

	it('registers only internal maintenance targets at the approved UTC times', () => {
		expect(crons.crons).toEqual({
			'reconcile Google Health': {
				name: 'googleHealth/maintenance:scheduleDailyReconciliation',
				args: [{}],
				schedule: { type: 'cron', cron: '15 3 * * *' }
			},
			'clean Google Health operational data': {
				name: 'googleHealth/maintenance:cleanupOperationalData',
				args: [{}],
				schedule: { type: 'cron', cron: '15 4 * * *' }
			}
		});
	});
});
