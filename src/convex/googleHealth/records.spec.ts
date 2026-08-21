/// <reference types="vite/client" />

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import schema from '../schema';
import type { NormalizedHealthPoint } from './validators';

const modules = import.meta.glob('/src/convex/**/*.*s');
function testBackend() {
	return convexTest({ schema, modules, transactionLimits: true });
}

async function pumpReady(t: ReturnType<typeof testBackend>, times = 1): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		vi.advanceTimersByTime(0);
		await t.finishInProgressScheduledFunctions();
	}
}

function physicalKey(timestamp: number, extraNanos = 0): string {
	const date = new Date(timestamp);
	const nanos = date.getUTCMilliseconds() * 1_000_000 + extraNanos;
	return `${date.toISOString().slice(0, 19)}.${String(nanos).padStart(9, '0')}Z`;
}

function point(args: {
	recordKey: string;
	timestamp: number;
	value: number;
	digest?: string;
	dataType?: string;
}): NormalizedHealthPoint {
	const dataType = args.dataType ?? 'steps';
	return {
		provider: 'google_health',
		recordKey: args.recordKey,
		dataType,
		category: 'activity',
		recordTimestamp: args.timestamp,
		startTime: args.timestamp,
		endTime: args.timestamp + 60_000,
		localDate: '2026-08-14',
		physicalCoverageKey: physicalKey(args.timestamp),
		primaryValue: args.value,
		primaryUnit: dataType === 'steps' ? 'steps' : 'm',
		payloadDigest: args.digest ?? `digest-${args.value}`,
		payloadJson: JSON.stringify({ [dataType]: { value: args.value } })
	};
}

async function seedConnection(t: ReturnType<typeof testBackend>, userId: string) {
	return await t.run(async (ctx) =>
		ctx.db.insert('googleHealthConnections', {
			userId,
			status: 'backfilling',
			grantedScopes: [],
			generation: 1,
			backfillTotalTypes: 1,
			backfillCompletedTypes: 0
		})
	);
}

async function seedRecord(
	t: ReturnType<typeof testBackend>,
	args: {
		connectionId: Id<'googleHealthConnections'>;
		userId: string;
		point: NormalizedHealthPoint;
		epoch: number;
	}
) {
	return await t.run(async (ctx) => {
		const dataPointId = await ctx.db.insert('healthDataPoints', {
			connectionId: args.connectionId,
			userId: args.userId,
			...args.point,
			lastSeenSyncId: `epoch-${args.epoch}`,
			seenEpoch: args.epoch
		});
		await ctx.db.insert('healthDataPointContributions', {
			connectionId: args.connectionId,
			dataPointId,
			userId: args.userId,
			recordKey: args.point.recordKey,
			dataType: args.point.dataType,
			category: args.point.category,
			localDate: args.point.localDate,
			recordTimestamp: args.point.recordTimestamp,
			...(args.point.primaryValue === undefined ? {} : { primaryValue: args.point.primaryValue }),
			durationSeconds: 60,
			...(args.point.physicalCoverageKey === undefined
				? {}
				: { physicalCoverageKey: args.point.physicalCoverageKey }),
			...(args.point.civilCoverageTime === undefined
				? {}
				: { civilCoverageTime: args.point.civilCoverageTime }),
			seenEpoch: args.epoch
		});
		return dataPointId;
	});
}

async function seedOwnedRun(
	t: ReturnType<typeof testBackend>,
	connectionId: Id<'googleHealthConnections'>,
	epoch: number
) {
	return await t.run(async (ctx) => {
		const cursorId = await ctx.db.insert('googleHealthSyncCursors', {
			connectionId,
			userId: 'user-a',
			dataType: 'steps',
			mode: 'incremental',
			status: 'running',
			windowStart: '2026-08-14T10:00:00Z',
			windowEnd: '2026-08-14T12:00:00Z',
			syncId: 'owned-sync',
			attempt: 0,
			generation: 1,
			reconciliationEpoch: epoch,
			activeEpoch: epoch,
			updatedAt: Date.now()
		});
		const runId = await ctx.db.insert('googleHealthSyncRuns', {
			connectionId,
			userId: 'user-a',
			cursorId,
			generation: 1,
			reconciliationEpoch: epoch,
			trigger: 'reconciliation',
			dataType: 'steps',
			startedAt: Date.now(),
			pages: 0,
			fetched: 0,
			inserted: 0,
			updated: 0,
			deleted: 0,
			skipped: 0,
			status: 'running'
		});
		const leaseExpiresAt = Date.now() + 5 * 60 * 1000;
		await ctx.db.patch('googleHealthSyncCursors', cursorId, {
			activeRunId: runId,
			leaseExpiresAt,
			leaseVersion: 1
		});
		await ctx.db.patch('googleHealthConnections', connectionId, {
			activeSyncCursorId: cursorId,
			activeSyncRunId: runId,
			syncLeaseExpiresAt: leaseExpiresAt,
			syncLeaseVersion: 1
		});
		return { cursorId, runId };
	});
}

describe('bounded Google Health record reconciliation', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('idempotently replaces corrected payloads and rebuilds exact summaries from compact contributions', async () => {
		vi.useFakeTimers();
		const t = testBackend();
		const connectionId = await seedConnection(t, 'user-a');
		const first = point({
			recordKey: 'first',
			timestamp: Date.parse('2026-08-14T09:00:00Z'),
			value: 100
		});
		const second = point({
			recordKey: 'second',
			timestamp: Date.parse('2026-08-14T10:00:00Z'),
			value: 200
		});
		expect(
			await t.mutation(internal.googleHealth.records.applyReconciledPage, {
				connectionId,
				expectedGeneration: 1,
				dataType: 'steps',
				points: [first, second],
				syncId: 'sync-1',
				seenEpoch: 1
			})
		).toEqual({ inserted: 2, updated: 0, skipped: 0 });
		expect(
			await t.mutation(internal.googleHealth.records.applyReconciledPage, {
				connectionId,
				expectedGeneration: 1,
				dataType: 'steps',
				points: [first, second],
				syncId: 'sync-1',
				seenEpoch: 1
			})
		).toEqual({ inserted: 0, updated: 0, skipped: 2 });
		expect(
			await t.mutation(internal.googleHealth.records.applyReconciledPage, {
				connectionId,
				expectedGeneration: 1,
				dataType: 'steps',
				points: [{ ...first, primaryValue: 120, payloadDigest: 'corrected' }],
				syncId: 'sync-2',
				seenEpoch: 2
			})
		).toEqual({ inserted: 0, updated: 1, skipped: 0 });
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const stored = await t.run(async (ctx) => ({
			points: await ctx.db
				.query('healthDataPoints')
				.withIndex('by_connectionId', (q) => q.eq('connectionId', connectionId))
				.take(10),
			contributions: await ctx.db
				.query('healthDataPointContributions')
				.withIndex('by_userId_and_dataType_and_localDate', (q) =>
					q.eq('userId', 'user-a').eq('dataType', 'steps').eq('localDate', '2026-08-14')
				)
				.take(10),
			summary: await ctx.db
				.query('healthDailySummaries')
				.withIndex('by_userId_and_dataType_and_localDate', (q) =>
					q.eq('userId', 'user-a').eq('dataType', 'steps').eq('localDate', '2026-08-14')
				)
				.unique()
		}));
		expect(stored.points).toHaveLength(2);
		expect(stored.contributions).toHaveLength(2);
		expect(stored.summary).toMatchObject({
			count: 2,
			sum: 320,
			average: 160,
			min: 120,
			max: 200,
			latestValue: 200
		});
	});

	it("renews the same active run after a summary heartbeat advances the action's observed lease", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
		const t = testBackend();
		const connectionId = await seedConnection(t, 'user-a');
		const { cursorId, runId } = await seedOwnedRun(t, connectionId, 2);
		await t.mutation(internal.googleHealth.records.applyReconciledPage, {
			connectionId,
			expectedGeneration: 1,
			cursorId,
			runId,
			dataType: 'steps',
			points: [
				point({
					recordKey: 'heartbeat-race',
					timestamp: Date.parse('2026-08-14T10:00:00Z'),
					value: 1
				})
			],
			syncId: 'race',
			seenEpoch: 2
		});
		const rebuildId = await t.run(
			async (ctx) =>
				(
					await ctx.db
						.query('healthSummaryRebuilds')
						.withIndex('by_userId_and_dataType_and_localDate', (q) =>
							q.eq('userId', 'user-a').eq('dataType', 'steps').eq('localDate', '2026-08-14')
						)
						.unique()
				)?._id
		);
		if (rebuildId === undefined) throw new Error('expected summary rebuild');
		await t.mutation(internal.googleHealth.records.rebuildSummaryBatch, { rebuildId });
		const renewed = await t.mutation(internal.googleHealth.sync.renewRunLease, {
			cursorId,
			generation: 1,
			runId,
			expectedLeaseVersion: 1
		});
		expect(renewed).toMatchObject({ leaseVersion: 3 });
		expect(await t.run(async (ctx) => ctx.db.get('googleHealthSyncRuns', runId))).toMatchObject({
			status: 'running'
		});
	});

	it('does not heartbeat an active run that has no dependency on the summary rebuild', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
		const t = testBackend();
		const connectionId = await seedConnection(t, 'user-a');
		await t.mutation(internal.googleHealth.records.applyReconciledPage, {
			connectionId,
			expectedGeneration: 1,
			dataType: 'steps',
			points: [
				point({
					recordKey: 'unrelated-heartbeat',
					timestamp: Date.parse('2026-08-14T10:00:00Z'),
					value: 1
				})
			],
			syncId: 'unrelated-heartbeat',
			seenEpoch: 1
		});
		const { cursorId, runId } = await seedOwnedRun(t, connectionId, 2);
		const rebuildId = await t.run(async (ctx) => {
			const rebuild = await ctx.db
				.query('healthSummaryRebuilds')
				.withIndex('by_userId_and_dataType_and_localDate', (q) =>
					q.eq('userId', 'user-a').eq('dataType', 'steps').eq('localDate', '2026-08-14')
				)
				.unique();
			if (!rebuild) throw new Error('expected summary rebuild');
			const staleCursorId = await ctx.db.insert('googleHealthSyncCursors', {
				connectionId,
				userId: 'user-a',
				dataType: 'steps',
				mode: 'incremental',
				status: 'retry',
				syncId: 'stale-summary-owner',
				attempt: 1,
				generation: 1,
				updatedAt: Date.now()
			});
			for (let index = 0; index < 33; index += 1) {
				const staleRunId = await ctx.db.insert('googleHealthSyncRuns', {
					connectionId,
					userId: 'user-a',
					cursorId: staleCursorId,
					generation: 1,
					reconciliationEpoch: 1,
					trigger: 'reconciliation',
					dataType: 'steps',
					startedAt: Date.now() - 1_000 - index,
					finishedAt: Date.now(),
					pages: 1,
					fetched: 0,
					inserted: 0,
					updated: 0,
					deleted: 0,
					skipped: 0,
					status: 'failed',
					errorCode: 'stale_summary_dependency',
					errorMessage: 'Google Health synchronization abandoned'
				});
				await ctx.db.insert('healthSummaryDependencies', {
					connectionId,
					cursorId: staleCursorId,
					runId: staleRunId,
					rebuildId: rebuild._id,
					userId: 'user-a',
					dataType: 'steps',
					localDate: '2026-08-14',
					targetVersion: rebuild.version
				});
			}
			return rebuild._id;
		});
		await t.mutation(internal.googleHealth.records.rebuildSummaryBatch, { rebuildId });
		await t.mutation(internal.googleHealth.records.rebuildSummaryBatch, { rebuildId });
		const stored = await t.run(async (ctx) => ({
			connection: await ctx.db.get('googleHealthConnections', connectionId),
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			run: await ctx.db.get('googleHealthSyncRuns', runId)
		}));
		expect(stored.connection).toMatchObject({ syncLeaseVersion: 1 });
		expect(stored.cursor).toMatchObject({ leaseVersion: 1 });
		expect(stored.run).toMatchObject({ status: 'running' });
	});

	it('drains stale and current summary dependencies in bounded pages while heartbeating the live owner', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
		const t = testBackend();
		const connectionId = await seedConnection(t, 'user-a');
		const { cursorId, runId } = await seedOwnedRun(t, connectionId, 2);
		const first = point({
			recordKey: 'drain-first',
			timestamp: Date.parse('2026-08-14T10:00:00Z'),
			value: 1
		});
		await t.mutation(internal.googleHealth.records.applyReconciledPage, {
			connectionId,
			expectedGeneration: 1,
			dataType: 'steps',
			points: [first],
			syncId: 'direct-base',
			seenEpoch: 2
		});
		const rebuildId = await t.run(async (ctx) => {
			const rebuild = await ctx.db
				.query('healthSummaryRebuilds')
				.withIndex('by_userId_and_dataType_and_localDate', (q) =>
					q.eq('userId', 'user-a').eq('dataType', 'steps').eq('localDate', '2026-08-14')
				)
				.unique();
			if (!rebuild) throw new Error('expected summary rebuild');
			const staleCursorId = await ctx.db.insert('googleHealthSyncCursors', {
				connectionId,
				userId: 'user-a',
				dataType: 'steps',
				mode: 'incremental',
				status: 'retry',
				syncId: 'stale-summary-owner',
				attempt: 1,
				generation: 1,
				updatedAt: Date.now()
			});
			for (let index = 0; index < 40; index += 1) {
				const staleRunId = await ctx.db.insert('googleHealthSyncRuns', {
					connectionId,
					userId: 'user-a',
					cursorId: staleCursorId,
					generation: 1,
					reconciliationEpoch: 1,
					trigger: 'reconciliation',
					dataType: 'steps',
					startedAt: Date.now() - 1_000 - index,
					finishedAt: Date.now(),
					pages: 1,
					fetched: 0,
					inserted: 0,
					updated: 0,
					deleted: 0,
					skipped: 0,
					status: 'failed',
					errorCode: 'stale_summary_dependency',
					errorMessage: 'Google Health synchronization abandoned'
				});
				await ctx.db.insert('healthSummaryDependencies', {
					connectionId,
					cursorId: staleCursorId,
					runId: staleRunId,
					rebuildId: rebuild._id,
					userId: 'user-a',
					dataType: 'steps',
					localDate: '2026-08-14',
					targetVersion: 2
				});
			}
			return rebuild._id;
		});
		await t.mutation(internal.googleHealth.records.applyReconciledPage, {
			connectionId,
			expectedGeneration: 1,
			cursorId,
			runId,
			dataType: 'steps',
			points: [
				point({
					recordKey: 'drain-second',
					timestamp: Date.parse('2026-08-14T10:01:00Z'),
					value: 2
				})
			],
			syncId: 'owned-second',
			seenEpoch: 2
		});
		await pumpReady(t);
		expect(
			await t.run(async (ctx) => ctx.db.get('healthSummaryRebuilds', rebuildId))
		).toMatchObject({ status: 'running', workingVersion: 2 });
		await t.mutation(internal.googleHealth.records.applyReconciledPage, {
			connectionId,
			expectedGeneration: 1,
			cursorId,
			runId,
			dataType: 'steps',
			points: [
				point({ recordKey: 'drain-third', timestamp: Date.parse('2026-08-14T10:02:00Z'), value: 3 })
			],
			syncId: 'owned-third',
			seenEpoch: 2
		});
		await pumpReady(t, 5);
		const stored = await t.run(async (ctx) => ({
			connection: await ctx.db.get('googleHealthConnections', connectionId),
			run: await ctx.db.get('googleHealthSyncRuns', runId),
			rebuild: await ctx.db.get('healthSummaryRebuilds', rebuildId),
			dependencies: await ctx.db
				.query('healthSummaryDependencies')
				.withIndex('by_rebuildId', (q) => q.eq('rebuildId', rebuildId))
				.take(100),
			summary: await ctx.db
				.query('healthDailySummaries')
				.withIndex('by_userId_and_dataType_and_localDate', (q) =>
					q.eq('userId', 'user-a').eq('dataType', 'steps').eq('localDate', '2026-08-14')
				)
				.unique()
		}));
		expect(stored.dependencies).toHaveLength(0);
		expect(stored.rebuild).toMatchObject({ status: 'complete', workingVersion: 3 });
		expect(stored.summary).toMatchObject({ count: 3, sum: 6 });
		expect(stored.connection?.syncLeaseVersion).toBeGreaterThan(1);
		expect(stored.run).toMatchObject({ status: 'running' });
	});

	it('rebuilds exact aggregates and latest across more than 10,001 compact rows under transaction limits', async () => {
		vi.useFakeTimers();
		const t = testBackend();
		const connectionId = await seedConnection(t, 'user-a');
		const start = Date.parse('2026-08-14T00:00:00Z');
		const fixtures = [
			point({ recordKey: 'created-first-latest', timestamp: start + 1_000_000, value: 777 })
		];
		for (let index = 1; index <= 10_000; index += 1)
			fixtures.push(point({ recordKey: `dense-${index}`, timestamp: start + index, value: index }));
		for (let offset = 0; offset < fixtures.length; offset += 100) {
			await t.run(async (ctx) => {
				for (const item of fixtures.slice(offset, offset + 100)) {
					const dataPointId = await ctx.db.insert('healthDataPoints', {
						connectionId,
						userId: 'user-a',
						...item,
						lastSeenSyncId: 'old',
						seenEpoch: 1
					});
					await ctx.db.insert('healthDataPointContributions', {
						connectionId,
						dataPointId,
						userId: 'user-a',
						recordKey: item.recordKey,
						dataType: 'steps',
						category: 'activity',
						localDate: item.localDate,
						recordTimestamp: item.recordTimestamp,
						primaryValue: item.primaryValue,
						durationSeconds: 60,
						physicalCoverageKey: item.physicalCoverageKey,
						seenEpoch: 1
					});
				}
			});
		}
		await t.mutation(internal.googleHealth.records.applyReconciledPage, {
			connectionId,
			expectedGeneration: 1,
			dataType: 'steps',
			points: [{ ...fixtures[1], primaryValue: -5, payloadDigest: 'corrected-low-timestamp' }],
			syncId: 'new',
			seenEpoch: 2
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const summary = await t.run(async (ctx) =>
			ctx.db
				.query('healthDailySummaries')
				.withIndex('by_userId_and_dataType_and_localDate', (q) =>
					q.eq('userId', 'user-a').eq('dataType', 'steps').eq('localDate', '2026-08-14')
				)
				.unique()
		);
		expect(summary).toMatchObject({
			count: 10_001,
			sum: 50_005_771,
			average: 50_005_771 / 10_001,
			min: -5,
			max: 10_000,
			latestValue: 777,
			latestTimestamp: start + 1_000_000,
			durationSeconds: 10_001 * 60
		});
	}, 30_000);

	it('pages run-owned cleanup and an older epoch cannot delete newer or out-of-scope records', async () => {
		vi.useFakeTimers();
		const t = testBackend();
		const alice = await seedConnection(t, 'user-a');
		const bob = await seedConnection(t, 'user-b');
		const start = Date.parse('2026-08-14T10:00:00Z');
		const end = Date.parse('2026-08-14T12:00:00Z');
		const protectedPoint = point({ recordKey: 'newer-inside', timestamp: start + 1, value: 1 });
		for (let offset = 0; offset < 140; offset += 20) {
			await Promise.all(
				Array.from({ length: Math.min(20, 140 - offset) }, (_, index) =>
					seedRecord(t, {
						connectionId: alice,
						userId: 'user-a',
						point: point({
							recordKey: `stale-${offset + index}`,
							timestamp: start + 100 + offset + index,
							value: offset + index
						}),
						epoch: 1
					})
				)
			);
		}
		await seedRecord(t, { connectionId: alice, userId: 'user-a', point: protectedPoint, epoch: 1 });
		await seedRecord(t, {
			connectionId: alice,
			userId: 'user-a',
			point: point({ recordKey: 'outside', timestamp: end + 1, value: 9 }),
			epoch: 1
		});
		await seedRecord(t, {
			connectionId: bob,
			userId: 'user-b',
			point: point({ recordKey: 'bob-inside', timestamp: start + 2, value: 8 }),
			epoch: 1
		});
		const { cursorId, runId } = await seedOwnedRun(t, alice, 2);
		await t.mutation(internal.googleHealth.records.applyReconciledPage, {
			connectionId: alice,
			expectedGeneration: 1,
			dataType: 'steps',
			points: [{ ...protectedPoint, primaryValue: 2, payloadDigest: 'newer' }],
			syncId: 'newer',
			seenEpoch: 2
		});
		expect(
			await t.mutation(internal.googleHealth.records.applyReconciledPage, {
				connectionId: alice,
				expectedGeneration: 1,
				dataType: 'steps',
				points: [{ ...protectedPoint, primaryValue: 999, payloadDigest: 'late-old-page' }],
				syncId: 'older-arrived-late',
				seenEpoch: 1
			})
		).toEqual({ inserted: 0, updated: 0, skipped: 1 });
		expect(
			await t.mutation(internal.googleHealth.records.beginCleanup, {
				connectionId: alice,
				cursorId,
				runId,
				expectedGeneration: 1,
				dataType: 'steps',
				cleanupEpoch: 2,
				coveredRange: {
					kind: 'physical',
					startKey: physicalKey(start),
					endKeyExclusive: physicalKey(end)
				},
				completion: {
					trigger: 'reconciliation',
					counts: { fetched: 1, inserted: 0, updated: 1, skipped: 0 },
					finish: true,
					hadMalformed: false
				}
			})
		).toBe(true);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const stored = await t.run(async (ctx) => ({
			aliceRows: await ctx.db
				.query('healthDataPoints')
				.withIndex('by_connectionId', (q) => q.eq('connectionId', alice))
				.take(200),
			alice: (
				await ctx.db
					.query('healthDataPoints')
					.withIndex('by_connectionId', (q) => q.eq('connectionId', alice))
					.take(200)
			)
				.map((row) => row.recordKey)
				.sort(),
			bob: await ctx.db
				.query('healthDataPoints')
				.withIndex('by_connectionId', (q) => q.eq('connectionId', bob))
				.take(10),
			cursor: await ctx.db.get('googleHealthSyncCursors', cursorId),
			run: await ctx.db.get('googleHealthSyncRuns', runId)
		}));
		expect(stored.alice).toEqual(['newer-inside', 'outside']);
		expect(stored.aliceRows.find((row) => row.recordKey === 'newer-inside')).toMatchObject({
			primaryValue: 2,
			seenEpoch: 2
		});
		expect(stored.bob.map((row) => row.recordKey)).toEqual(['bob-inside']);
		expect(stored.cursor).toMatchObject({ status: 'complete' });
		expect(stored.run).toMatchObject({ status: 'succeeded', deleted: 140 });
	});

	it('uses nanosecond-exact closed-open physical cleanup bounds', async () => {
		vi.useFakeTimers();
		const t = testBackend();
		const connectionId = await seedConnection(t, 'user-a');
		const timestamp = Date.parse('2026-08-14T10:00:00Z');
		for (const [recordKey, physicalCoverageKey] of [
			['before', '2026-08-14T10:00:00.000000099Z'],
			['inside', '2026-08-14T10:00:00.000000100Z'],
			['exclusive-end', '2026-08-14T10:00:00.000000150Z']
		] as const) {
			await seedRecord(t, {
				connectionId,
				userId: 'user-a',
				point: {
					...point({ recordKey, timestamp, value: 1 }),
					physicalCoverageKey
				},
				epoch: 1
			});
		}
		const { cursorId, runId } = await seedOwnedRun(t, connectionId, 2);
		expect(
			await t.mutation(internal.googleHealth.records.beginCleanup, {
				connectionId,
				cursorId,
				runId,
				expectedGeneration: 1,
				dataType: 'steps',
				cleanupEpoch: 2,
				coveredRange: {
					kind: 'physical',
					startKey: '2026-08-14T10:00:00.000000100Z',
					endKeyExclusive: '2026-08-14T10:00:00.000000150Z'
				},
				completion: {
					trigger: 'reconciliation',
					counts: { fetched: 0, inserted: 0, updated: 0, skipped: 0 },
					finish: true,
					hadMalformed: false
				}
			})
		).toBe(true);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const keys = await t.run(async (ctx) =>
			(
				await ctx.db
					.query('healthDataPoints')
					.withIndex('by_connectionId', (q) => q.eq('connectionId', connectionId))
					.take(10)
			)
				.map((row) => row.recordKey)
				.sort()
		);
		expect(keys).toEqual(['before', 'exclusive-end']);
	});

	it('renews ownership from a healthy cleanup batch even after the previous lease duration', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
		const t = testBackend();
		const connectionId = await seedConnection(t, 'user-a');
		const { cursorId, runId } = await seedOwnedRun(t, connectionId, 2);
		vi.setSystemTime(new Date('2026-08-14T12:06:00Z'));
		await t.mutation(internal.googleHealth.records.cleanupCoveredRange, {
			connectionId,
			cursorId,
			runId,
			expectedGeneration: 1,
			dataType: 'steps',
			cleanupEpoch: 2,
			coveredRange: {
				kind: 'physical',
				startKey: '2026-08-14T10:00:00.000000000Z',
				endKeyExclusive: '2026-08-14T11:00:00.000000000Z'
			},
			completion: {
				trigger: 'reconciliation',
				counts: { fetched: 0, inserted: 0, updated: 0, skipped: 0 },
				finish: true,
				hadMalformed: false
			},
			paginationOpts: { numItems: 64, cursor: null }
		});
		const renewed = await t.run(async (ctx) => ctx.db.get('googleHealthSyncCursors', cursorId));
		expect(renewed).toMatchObject({
			leaseVersion: 2,
			leaseExpiresAt: Date.parse('2026-08-14T12:11:00Z')
		});
		expect(
			await t.mutation(internal.googleHealth.sync.recoverStaleRun, {
				cursorId,
				generation: 1,
				runId,
				leaseVersion: 1,
				leaseExpiresAt: Date.parse('2026-08-14T12:05:00Z')
			})
		).toBe(false);
	});

	it('rejects a late older insertion after a newer empty reconciliation has completed', async () => {
		vi.useFakeTimers();
		const t = testBackend();
		const connectionId = await seedConnection(t, 'user-a');
		const old = await seedOwnedRun(t, connectionId, 1);
		await t.run(async (ctx) => {
			await ctx.db.patch('googleHealthSyncRuns', old.runId, {
				status: 'failed',
				finishedAt: Date.now(),
				errorCode: 'superseded',
				errorMessage: 'Google Health synchronization abandoned'
			});
			await ctx.db.patch('googleHealthSyncCursors', old.cursorId, {
				status: 'queued',
				activeRunId: undefined,
				activeEpoch: undefined,
				leaseExpiresAt: undefined,
				leaseVersion: undefined
			});
			await ctx.db.patch('googleHealthConnections', connectionId, {
				activeSyncCursorId: undefined,
				activeSyncRunId: undefined,
				syncLeaseExpiresAt: undefined
			});
		});
		const newer = await t.mutation(internal.googleHealth.sync.markCursorRunning, {
			cursorId: old.cursorId,
			generation: 1,
			trigger: 'reconciliation',
			expectedDispatchVersion: 0
		});
		if (newer === null) throw new Error('expected newer reconciliation');
		expect(
			await t.mutation(internal.googleHealth.records.beginCleanup, {
				connectionId,
				cursorId: newer.cursorId,
				runId: newer.runId,
				expectedGeneration: 1,
				dataType: 'steps',
				cleanupEpoch: newer.reconciliationEpoch,
				coveredRange: {
					kind: 'physical',
					startKey: '2026-08-14T10:00:00.000000000Z',
					endKeyExclusive: '2026-08-14T11:00:00.000000000Z'
				},
				completion: {
					trigger: 'reconciliation',
					counts: { fetched: 0, inserted: 0, updated: 0, skipped: 0 },
					finish: true,
					hadMalformed: false
				}
			})
		).toBe(true);
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		await expect(
			t.mutation(internal.googleHealth.records.applyReconciledPage, {
				connectionId,
				expectedGeneration: 1,
				cursorId: old.cursorId,
				runId: old.runId,
				dataType: 'steps',
				points: [
					point({
						recordKey: 'late-absent',
						timestamp: Date.parse('2026-08-14T10:30:00Z'),
						value: 1
					})
				],
				syncId: 'late-old',
				seenEpoch: 1
			})
		).rejects.toThrow('stale Google Health');
		expect(
			await t.run(async (ctx) =>
				ctx.db
					.query('healthDataPoints')
					.withIndex('by_userId_and_recordKey', (q) =>
						q.eq('userId', 'user-a').eq('recordKey', 'late-absent')
					)
					.unique()
			)
		).toBeNull();
	});
});

async function seedReadConnection(
	t: ReturnType<typeof testBackend>,
	userId: string,
	status: 'active' | 'disconnected' = 'active'
) {
	return await t.run(async (ctx) =>
		ctx.db.insert('googleHealthConnections', {
			userId,
			status,
			grantedScopes: [],
			generation: 1,
			backfillTotalTypes: 0,
			backfillCompletedTypes: 0,
			...(status === 'disconnected' ? { disconnectedAt: Date.parse('2026-03-01T00:00:00Z') } : {})
		})
	);
}

async function seedReadSummary(
	t: ReturnType<typeof testBackend>,
	args: {
		connectionId: Id<'googleHealthConnections'>;
		userId: string;
		dataType: string;
		category: 'activity' | 'vitals' | 'sleep' | 'body' | 'nutrition' | 'other';
		localDate: string;
		count?: number;
		latestValue?: number;
		durationSeconds?: number;
	}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('healthDailySummaries', {
			connectionId: args.connectionId,
			userId: args.userId,
			dataType: args.dataType,
			category: args.category,
			localDate: args.localDate,
			count: args.count ?? 1,
			...(args.latestValue === undefined
				? {}
				: {
						latestValue: args.latestValue,
						latestTimestamp: Date.parse(`${args.localDate}T12:00:00Z`),
						sum: args.latestValue,
						average: args.latestValue,
						min: args.latestValue,
						max: args.latestValue
					}),
			...(args.durationSeconds === undefined ? {} : { durationSeconds: args.durationSeconds }),
			computedAt: Date.parse(`${args.localDate}T23:00:00Z`)
		});
	});
}

async function seedReadPoint(
	t: ReturnType<typeof testBackend>,
	args: {
		connectionId: Id<'googleHealthConnections'>;
		userId: string;
		recordKey: string;
		dataType?: string;
		category?: 'activity' | 'vitals' | 'sleep' | 'body' | 'nutrition' | 'other';
		recordTimestamp: number;
		primaryValue?: number;
		primaryUnit?: string;
		payloadJson: string;
	}
): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('healthDataPoints', {
			connectionId: args.connectionId,
			userId: args.userId,
			provider: 'google_health',
			recordKey: args.recordKey,
			googleDataPointName: `google/${args.recordKey}`,
			dataType: args.dataType ?? 'steps',
			category: args.category ?? 'activity',
			recordTimestamp: args.recordTimestamp,
			startTime: args.recordTimestamp - 60_000,
			endTime: args.recordTimestamp,
			localDate: new Date(args.recordTimestamp).toISOString().slice(0, 10),
			...(args.primaryValue === undefined ? {} : { primaryValue: args.primaryValue }),
			...(args.primaryUnit === undefined ? {} : { primaryUnit: args.primaryUnit }),
			sourcePlatform: 'wearable',
			sourceApplication: 'Health App',
			sourceDevice: 'Watch',
			recordingMethod: 'automatic',
			sourceFamily: 'watch-family',
			googleCreateTime: args.recordTimestamp - 30_000,
			googleUpdateTime: args.recordTimestamp - 10_000,
			payloadDigest: `private-digest-${args.recordKey}`,
			payloadJson: args.payloadJson,
			lastSeenSyncId: `private-sync-${args.recordKey}`,
			seenEpoch: 41
		});
	});
}

describe('Google Health read APIs', () => {
	it('requires authentication on every public read query', async () => {
		const t = testBackend();
		const calls = [
			() => t.query(api.googleHealth.records.getOverview, { days: 30 }),
			() => t.query(api.googleHealth.records.listCategories, {}),
			() => t.query(api.googleHealth.records.listMetrics, { category: null }),
			() =>
				t.query(api.googleHealth.records.getMetricTrend, {
					dataType: 'steps',
					fromDate: '2026-01-01',
					toDate: '2026-01-31'
				}),
			() =>
				t.query(api.googleHealth.records.listMetricRecords, {
					dataType: 'steps',
					paginationOpts: { numItems: 2, cursor: null }
				})
		];

		for (const call of calls) await expect(call()).rejects.toThrow('Not authenticated');
	});

	it('lists distinct imported metrics with authoritative categories and isolates owners', async () => {
		const t = testBackend();
		const aliceId = 'clerk|alice';
		const bobId = 'clerk|bob';
		const aliceConnectionId = await seedReadConnection(t, aliceId, 'disconnected');
		const bobConnectionId = await seedReadConnection(t, bobId);
		const summaries = [
			['steps', 'body', '2026-03-01', 1_000],
			['steps', 'body', '2026-03-02', 2_000],
			['distance', 'activity', '2026-03-02', 500],
			['daily-resting-heart-rate', 'nutrition', '2026-03-02', 58],
			['sleep', 'activity', '2026-03-02', undefined],
			['weight', 'vitals', '2026-03-02', 72],
			['nutrition-log', 'sleep', '2026-03-02', 600],
			['future-signal', 'vitals', '2026-03-02', 7]
		] as const;
		for (const [dataType, category, localDate, latestValue] of summaries) {
			await seedReadSummary(t, {
				connectionId: aliceConnectionId,
				userId: aliceId,
				dataType,
				category,
				localDate,
				...(latestValue === undefined ? { durationSeconds: 28_800 } : { latestValue })
			});
		}
		await seedReadSummary(t, {
			connectionId: bobConnectionId,
			userId: bobId,
			dataType: 'steps',
			category: 'activity',
			localDate: '2026-04-01',
			latestValue: 99_999
		});

		const alice = t.withIdentity({ tokenIdentifier: aliceId });
		const categories = await alice.query(api.googleHealth.records.listCategories, {});
		expect(categories).toEqual([
			{ category: 'activity', count: 2 },
			{ category: 'vitals', count: 1 },
			{ category: 'sleep', count: 1 },
			{ category: 'body', count: 1 },
			{ category: 'nutrition', count: 1 },
			{ category: 'other', count: 1 }
		]);

		const metrics = await alice.query(api.googleHealth.records.listMetrics, { category: null });
		expect(metrics.map((metric) => metric.dataType)).toEqual([
			'daily-resting-heart-rate',
			'distance',
			'future-signal',
			'nutrition-log',
			'sleep',
			'steps',
			'weight'
		]);
		expect(metrics.find((metric) => metric.dataType === 'steps')).toMatchObject({
			provider: 'google_health',
			sourceLabel: 'Google Health',
			known: true,
			category: 'activity',
			recordKind: 'interval',
			aggregation: 'sum',
			primaryUnit: 'steps',
			latestSummary: { localDate: '2026-03-02', latestValue: 2_000 }
		});
		expect(metrics.find((metric) => metric.dataType === 'future-signal')).toMatchObject({
			known: false,
			category: 'other',
			recordKind: null,
			aggregation: null,
			primaryUnit: null
		});
		expect(metrics.some((metric) => metric.latestSummary.latestValue === 99_999)).toBe(false);
		expect(
			(await alice.query(api.googleHealth.records.listMetrics, { category: 'activity' })).map(
				(metric) => metric.dataType
			)
		).toEqual(['distance', 'steps']);
		expect(
			(await alice.query(api.googleHealth.records.listMetrics, { category: 'other' })).map(
				(metric) => metric.dataType
			)
		).toEqual(['future-signal']);
	});

	it('anchors the overview to owned summaries and applies exact representative fallback order', async () => {
		const t = testBackend();
		const aliceId = 'clerk|overview-alice';
		const bobId = 'clerk|overview-bob';
		const aliceConnectionId = await seedReadConnection(t, aliceId, 'disconnected');
		const bobConnectionId = await seedReadConnection(t, bobId);
		for (const [dataType, category, localDate, latestValue] of [
			['steps', 'body', '2026-03-13', 1_300],
			['steps', 'body', '2026-03-14', 1_400],
			['sleep', 'activity', '2026-03-14', undefined],
			['daily-resting-heart-rate', 'nutrition', '2026-03-15', 57],
			['weight', 'vitals', '2026-03-12', 71],
			['alpha-signal', 'sleep', '2026-03-15', 1],
			['zeta-signal', 'activity', '2026-03-15', 2]
		] as const) {
			await seedReadSummary(t, {
				connectionId: aliceConnectionId,
				userId: aliceId,
				dataType,
				category,
				localDate,
				...(latestValue === undefined ? { durationSeconds: 27_000 } : { latestValue })
			});
		}
		for (const [dataType, category] of [
			['zeta-signal', 'activity'],
			['weight', 'vitals'],
			['beta-signal', 'sleep'],
			['alpha-signal', 'nutrition']
		] as const) {
			await seedReadSummary(t, {
				connectionId: bobConnectionId,
				userId: bobId,
				dataType,
				category,
				localDate: '2027-01-20',
				latestValue: 777
			});
		}

		const overview = await t
			.withIdentity({ tokenIdentifier: aliceId })
			.query(api.googleHealth.records.getOverview, { days: 3 });
		expect(overview).toMatchObject({
			anchorDate: '2026-03-15',
			fromDate: '2026-03-13',
			toDate: '2026-03-15'
		});
		expect(overview.metrics.map((metric) => metric.dataType)).toEqual([
			'steps',
			'sleep',
			'daily-resting-heart-rate',
			'weight'
		]);
		expect(overview.metrics[0]).toMatchObject({
			category: 'activity',
			latestSummary: { localDate: '2026-03-14', latestValue: 1_400 },
			trend: [
				{ localDate: '2026-03-13', latestValue: 1_300 },
				{ localDate: '2026-03-14', latestValue: 1_400 }
			]
		});
		expect(overview.metrics[1]).toMatchObject({
			latestSummary: { localDate: '2026-03-14', latestValue: null, durationSeconds: 27_000 }
		});
		expect(JSON.stringify(overview)).not.toContain('777');
		expect(JSON.stringify(overview)).not.toContain('payloadJson');

		const fallback = await t
			.withIdentity({ tokenIdentifier: bobId })
			.query(api.googleHealth.records.getOverview, { days: 30 });
		expect(fallback.metrics.map((metric) => metric.dataType)).toEqual([
			'weight',
			'alpha-signal',
			'beta-signal',
			'zeta-signal'
		]);
	});

	it('keeps the overview range inside the supported calendar at the earliest valid anchor', async () => {
		const t = testBackend();
		const userId = 'clerk|earliest-overview';
		const connectionId = await seedReadConnection(t, userId);
		await seedReadSummary(t, {
			connectionId,
			userId,
			dataType: 'steps',
			category: 'activity',
			localDate: '0001-01-01',
			latestValue: 321
		});

		const overview = await t
			.withIdentity({ tokenIdentifier: userId })
			.query(api.googleHealth.records.getOverview, { days: 365 });
		expect(overview).toMatchObject({
			anchorDate: '0001-01-01',
			fromDate: '0001-01-01',
			toDate: '0001-01-01',
			metrics: [
				{
					dataType: 'steps',
					latestSummary: { localDate: '0001-01-01', latestValue: 321 },
					trend: [{ localDate: '0001-01-01', latestValue: 321 }]
				}
			]
		});
	});

	it('returns inclusive bounded trends with strict calendar and data-type validation', async () => {
		const t = testBackend();
		const aliceId = 'clerk|trend-alice';
		const bobId = 'clerk|trend-bob';
		const aliceConnectionId = await seedReadConnection(t, aliceId);
		const bobConnectionId = await seedReadConnection(t, bobId);
		for (const [localDate, latestValue] of [
			['2024-02-28', 10],
			['2024-02-29', 20],
			['2024-03-01', 30]
		] as const) {
			await seedReadSummary(t, {
				connectionId: aliceConnectionId,
				userId: aliceId,
				dataType: 'steps',
				category: 'body',
				localDate,
				latestValue
			});
		}
		await seedReadSummary(t, {
			connectionId: bobConnectionId,
			userId: bobId,
			dataType: 'steps',
			category: 'activity',
			localDate: '2024-02-29',
			latestValue: 999
		});
		const alice = t.withIdentity({ tokenIdentifier: aliceId });
		const trend = await alice.query(api.googleHealth.records.getMetricTrend, {
			dataType: 'steps',
			fromDate: '2024-02-29',
			toDate: '2024-03-01'
		});
		expect(trend).toMatchObject({
			kind: 'found',
			metric: {
				provider: 'google_health',
				sourceLabel: 'Google Health',
				dataType: 'steps',
				known: true,
				category: 'activity'
			}
		});
		if (trend.kind !== 'found') throw new Error('expected owned metric trend');
		expect(trend.metric).toMatchObject({
			dataType: 'steps',
			known: true,
			category: 'activity'
		});
		expect(trend.summaries.map((summary) => [summary.localDate, summary.latestValue])).toEqual([
			['2024-02-29', 20],
			['2024-03-01', 30]
		]);
		await expect(
			alice.query(api.googleHealth.records.getMetricTrend, {
				dataType: 'steps',
				fromDate: '2024-01-01',
				toDate: '2024-12-31'
			})
		).resolves.toBeDefined();
		expect(
			await alice.query(api.googleHealth.records.getMetricTrend, {
				dataType: 'weight',
				fromDate: '2024-01-01',
				toDate: '2024-01-02'
			})
		).toEqual({ kind: 'not_found' });

		for (const [fromDate, toDate] of [
			['2023-02-29', '2023-03-01'],
			['2026-02-30', '2026-03-01'],
			['2026-1-01', '2026-01-02'],
			['2026-03-02', '2026-03-01'],
			['2024-01-01', '2025-01-01']
		]) {
			await expect(
				alice.query(api.googleHealth.records.getMetricTrend, {
					dataType: 'steps',
					fromDate,
					toDate
				})
			).rejects.toThrow('Invalid Google Health date range');
		}
		for (const dataType of ['', 'Steps', '-steps', 'steps/value', 'a'.repeat(97)]) {
			await expect(
				alice.query(api.googleHealth.records.getMetricTrend, {
					dataType,
					fromDate: '2024-01-01',
					toDate: '2024-01-02'
				})
			).rejects.toThrow('Invalid Google Health data type');
		}
		for (const days of [0, 366, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(alice.query(api.googleHealth.records.getOverview, { days })).rejects.toThrow(
				'Invalid Google Health overview range'
			);
		}
	});

	it('paginates owned records in deterministic native order without internal fields', async () => {
		const t = testBackend();
		const aliceId = 'clerk|records-alice';
		const bobId = 'clerk|records-bob';
		const aliceConnectionId = await seedReadConnection(t, aliceId, 'disconnected');
		const bobConnectionId = await seedReadConnection(t, bobId);
		const latest = Date.parse('2026-05-03T12:00:00Z');
		await seedReadPoint(t, {
			connectionId: aliceConnectionId,
			userId: aliceId,
			recordKey: 'latest',
			category: 'body',
			recordTimestamp: latest,
			primaryValue: 1,
			primaryUnit: 'conflicting-unit',
			payloadJson: JSON.stringify({ marker: 'latest', nested: { flag: true }, samples: [null, 2] })
		});
		await seedReadPoint(t, {
			connectionId: aliceConnectionId,
			userId: aliceId,
			recordKey: 'equal-first',
			recordTimestamp: latest - 60_000,
			primaryValue: 2,
			payloadJson: JSON.stringify({ marker: 'equal-first' })
		});
		await seedReadPoint(t, {
			connectionId: aliceConnectionId,
			userId: aliceId,
			recordKey: 'equal-second',
			recordTimestamp: latest - 60_000,
			primaryValue: 3,
			payloadJson: JSON.stringify({ marker: 'equal-second' })
		});
		await seedReadPoint(t, {
			connectionId: bobConnectionId,
			userId: bobId,
			recordKey: 'bob-secret',
			recordTimestamp: latest + 60_000,
			primaryValue: 999,
			payloadJson: JSON.stringify({ marker: 'bob-secret' })
		});

		const alice = t.withIdentity({ tokenIdentifier: aliceId });
		const first = await alice.query(api.googleHealth.records.listMetricRecords, {
			dataType: 'steps',
			paginationOpts: { numItems: 2, cursor: null }
		});
		expect(first.isDone).toBe(false);
		expect(first.continueCursor).not.toBe('');
		expect(first.page.map((record) => record.primaryValue)).toEqual([1, 3]);
		expect(first.page[0]).toEqual({
			provider: 'google_health',
			dataType: 'steps',
			category: 'activity',
			recordTimestamp: latest,
			startTime: latest - 60_000,
			endTime: latest,
			localDate: '2026-05-03',
			primaryValue: 1,
			primaryUnit: 'steps',
			sourcePlatform: 'wearable',
			sourceApplication: 'Health App',
			sourceDevice: 'Watch',
			recordingMethod: 'automatic',
			sourceFamily: 'watch-family',
			googleCreateTime: latest - 30_000,
			googleUpdateTime: latest - 10_000,
			payload: {
				kind: 'fields',
				fields: [
					{ path: ['marker'], value: 'latest' },
					{ path: ['nested', 'flag'], value: true },
					{ path: ['samples', '0'], value: null },
					{ path: ['samples', '1'], value: 2 }
				]
			}
		});
		const second = await alice.query(api.googleHealth.records.listMetricRecords, {
			dataType: 'steps',
			paginationOpts: { numItems: 2, cursor: first.continueCursor }
		});
		expect(second.isDone).toBe(true);
		expect(second.page.map((record) => record.primaryValue)).toEqual([2]);
		const serialized = JSON.stringify([first, second]);
		expect(serialized).not.toContain('bob-secret');
		expect(serialized).not.toContain('private-digest');
		expect(serialized).not.toContain('private-sync');
		expect(serialized).not.toContain('google/latest');
	});

	it('flattens inert payload leaves and rejects corrupt or over-complex JSON', async () => {
		const t = testBackend();
		const userId = 'clerk|payload-safety';
		const connectionId = await seedReadConnection(t, userId);
		const malicious =
			'{"__proto__":{"polluted":"no"},"$html":"<img src=x onerror=alert(1)>","array":[null,true,2,"ok"]}';
		const payloads = [
			malicious,
			'{broken',
			JSON.stringify({ a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } }),
			'{"notFinite":1e999}',
			JSON.stringify({ long: 'x'.repeat(513) }),
			JSON.stringify(
				Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`f${index}`, index]))
			),
			JSON.stringify({ ['k'.repeat(97)]: true })
		];
		for (const [index, payloadJson] of payloads.entries()) {
			await seedReadPoint(t, {
				connectionId,
				userId,
				recordKey: `payload-${index}`,
				dataType: 'future-complex',
				category: 'activity',
				recordTimestamp: Date.parse('2026-06-01T12:00:00Z') - index,
				primaryValue: index,
				payloadJson
			});
		}
		expect(Object.prototype).not.toHaveProperty('polluted');
		const page = await t
			.withIdentity({ tokenIdentifier: userId })
			.query(api.googleHealth.records.listMetricRecords, {
				dataType: 'future-complex',
				paginationOpts: { numItems: 8, cursor: null }
			});
		expect(Object.prototype).not.toHaveProperty('polluted');
		const maliciousRecord = page.page.find((record) => record.primaryValue === 0);
		expect(maliciousRecord).toMatchObject({
			category: 'other',
			payload: {
				kind: 'fields',
				fields: [
					{ path: ['__proto__', 'polluted'], value: 'no' },
					{ path: ['$html'], value: '<img src=x onerror=alert(1)>' },
					{ path: ['array', '0'], value: null },
					{ path: ['array', '1'], value: true },
					{ path: ['array', '2'], value: 2 },
					{ path: ['array', '3'], value: 'ok' }
				]
			}
		});
		for (let index = 1; index < payloads.length; index += 1) {
			expect(page.page.find((record) => record.primaryValue === index)?.payload).toEqual({
				kind: 'unavailable'
			});
		}
	});

	it('bounds detail reads for near-limit payloads and validates pagination arguments', async () => {
		const t = testBackend();
		const userId = 'clerk|large-records';
		const connectionId = await seedReadConnection(t, userId, 'disconnected');
		const payloadJson = JSON.stringify({ huge: 'x'.repeat(748_800) });
		for (let index = 0; index < 8; index += 1) {
			await seedReadPoint(t, {
				connectionId,
				userId,
				recordKey: `large-${index}`,
				recordTimestamp: Date.parse('2026-07-01T12:00:00Z') - index,
				primaryValue: index,
				payloadJson
			});
		}
		const user = t.withIdentity({ tokenIdentifier: userId });
		const page = await user.query(api.googleHealth.records.listMetricRecords, {
			dataType: 'steps',
			paginationOpts: { numItems: 8, cursor: null }
		});
		expect(page.page).toHaveLength(8);
		expect(page.page.every((record) => record.payload.kind === 'unavailable')).toBe(true);

		for (const numItems of [0, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			await expect(
				user.query(api.googleHealth.records.listMetricRecords, {
					dataType: 'steps',
					paginationOpts: { numItems, cursor: null }
				})
			).rejects.toThrow('Invalid Google Health page size');
		}
		for (const dataType of ['', 'Steps', 'steps/value', 'x'.repeat(97)]) {
			await expect(
				user.query(api.googleHealth.records.listMetricRecords, {
					dataType,
					paginationOpts: { numItems: 1, cursor: null }
				})
			).rejects.toThrow('Invalid Google Health data type');
		}
	});
});
