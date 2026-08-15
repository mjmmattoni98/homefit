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
		physicalCoverageTime: args.timestamp,
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
			...(args.point.physicalCoverageTime === undefined
				? {}
				: { physicalCoverageTime: args.point.physicalCoverageTime }),
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
		await ctx.db.patch('googleHealthSyncCursors', cursorId, { activeRunId: runId });
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
						physicalCoverageTime: item.physicalCoverageTime,
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
				coveredRange: { kind: 'physical', startMs: start, endMsExclusive: end },
				completion: {
					trigger: 'reconciliation',
					counts: { fetched: 1, inserted: 0, updated: 1, skipped: 0 },
					finish: true
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
});
