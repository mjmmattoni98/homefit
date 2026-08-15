/// <reference types="vite/client" />

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import schema from '../schema';
import type { NormalizedHealthPoint } from './validators';

const modules = import.meta.glob('/src/convex/**/*.*s');
function testBackend() {
	return convexTest({ schema, modules, transactionLimits: true });
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
			trigger: 'reconciliation'
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
