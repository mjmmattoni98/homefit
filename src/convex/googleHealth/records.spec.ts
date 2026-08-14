/// <reference types="vite/client" />

import { type FunctionReference, makeFunctionReference } from 'convex/server';
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { summarizeHealthRows } from './records';
import type { NormalizedHealthPoint } from './validators';

const modules = import.meta.glob('/src/convex/**/*.*s');

type CoveredRange =
	| { kind: 'physical'; startMs: number; endMsExclusive: number }
	| { kind: 'civil'; startDate: string; endDateExclusive: string };

type ApplyArgs = {
	connectionId: Id<'googleHealthConnections'>;
	expectedGeneration: number;
	dataType: string;
	points: NormalizedHealthPoint[];
	syncId: string;
	nextPageToken?: string;
	coveredRange?: CoveredRange;
};

const applyReconciledPage = makeFunctionReference<
	'mutation',
	ApplyArgs,
	{
		inserted: number;
		updated: number;
		skipped: number;
	}
>('googleHealth/records:applyReconciledPage') as unknown as FunctionReference<
	'mutation',
	'internal',
	ApplyArgs,
	{ inserted: number; updated: number; skipped: number }
>;

function point(args: {
	recordKey: string;
	timestamp: number;
	value: number;
	digest?: string;
	name?: string;
	dataType?: string;
	localDate?: string;
}): NormalizedHealthPoint {
	const dataType = args.dataType ?? 'steps';
	return {
		provider: 'google_health',
		recordKey: args.recordKey,
		...(args.name === undefined ? {} : { googleDataPointName: args.name }),
		dataType,
		category: 'activity',
		recordTimestamp: args.timestamp,
		startTime: args.timestamp,
		endTime: args.timestamp + 60_000,
		localDate: args.localDate ?? '2026-08-14',
		primaryValue: args.value,
		primaryUnit: 'steps',
		payloadDigest: args.digest ?? `digest-${args.value}`,
		payloadJson: JSON.stringify({ dataType, value: args.value })
	};
}

async function seedConnection(
	t: ReturnType<typeof convexTest>,
	userId: string,
	generation = 1
): Promise<Id<'googleHealthConnections'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('googleHealthConnections', {
			userId,
			healthUserId: `health-${userId}`,
			status: 'backfilling',
			encryptedRefreshToken: 'ciphertext',
			tokenNonce: 'nonce',
			tokenTag: 'tag',
			tokenKeyVersion: 'v1',
			grantedScopes: [],
			generation,
			backfillTotalTypes: 1,
			backfillCompletedTypes: 0
		})
	);
}

describe('Google Health reconciled record application', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('idempotently upserts named and unnamed records and replaces corrected payloads', async () => {
		const t = convexTest(schema, modules);
		const connectionId = await seedConnection(t, 'user-a');
		const named = point({
			recordKey: 'named-key',
			name: 'users/me/dataTypes/steps/dataPoints/named',
			timestamp: Date.parse('2026-08-14T09:00:00Z'),
			value: 100
		});
		const unnamed = point({
			recordKey: 'unnamed-key',
			timestamp: Date.parse('2026-08-14T10:00:00Z'),
			value: 200
		});

		const first = await t.mutation(applyReconciledPage, {
			connectionId,
			expectedGeneration: 1,
			dataType: 'steps',
			points: [named, unnamed],
			syncId: 'sync-1'
		});
		const replay = await t.mutation(applyReconciledPage, {
			connectionId,
			expectedGeneration: 1,
			dataType: 'steps',
			points: [named, unnamed],
			syncId: 'sync-1'
		});
		const correctedNamed = { ...named, primaryValue: 120, payloadDigest: 'corrected-digest' };
		const correction = await t.mutation(applyReconciledPage, {
			connectionId,
			expectedGeneration: 1,
			dataType: 'steps',
			points: [correctedNamed],
			syncId: 'sync-2'
		});

		expect(first).toEqual({ inserted: 2, updated: 0, skipped: 0 });
		expect(replay).toEqual({ inserted: 0, updated: 0, skipped: 2 });
		expect(correction).toEqual({ inserted: 0, updated: 1, skipped: 0 });
		const stored = await t.run(async (ctx) => ({
			points: await ctx.db
				.query('healthDataPoints')
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
		expect(stored.points.find((row) => row.recordKey === 'named-key')).toMatchObject({
			primaryValue: 120,
			payloadDigest: 'corrected-digest',
			lastSeenSyncId: 'sync-2'
		});
		expect(stored.summary).toMatchObject({
			count: 2,
			sum: 320,
			average: 160,
			min: 120,
			max: 200,
			latestValue: 200,
			latestTimestamp: Date.parse('2026-08-14T10:00:00Z')
		});
	});

	it('cleans only an explicitly covered final physical window', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-15T00:00:00Z'));
		const t = convexTest(schema, modules);
		const aliceConnection = await seedConnection(t, 'user-a');
		const bobConnection = await seedConnection(t, 'user-b');
		const windowStart = Date.parse('2026-08-14T10:00:00Z');
		const windowEnd = Date.parse('2026-08-14T12:00:00Z');
		await t.run(async (ctx) => {
			for (const [connectionId, userId, value, recordKey, timestamp] of [
				[aliceConnection, 'user-a', 10, 'alice-stale-inside', windowStart + 1_000],
				[aliceConnection, 'user-a', 20, 'alice-outside', windowEnd + 1_000],
				[bobConnection, 'user-b', 30, 'bob-inside', windowStart + 1_000]
			] as const) {
				await ctx.db.insert('healthDataPoints', {
					connectionId,
					userId,
					...point({ recordKey, timestamp, value }),
					lastSeenSyncId: 'older-sync'
				});
			}
			await ctx.db.insert('healthDataPoints', {
				connectionId: aliceConnection,
				userId: 'user-a',
				...point({
					recordKey: 'alice-other-type-inside',
					timestamp: windowStart + 1_000,
					value: 55,
					dataType: 'distance'
				}),
				lastSeenSyncId: 'older-sync'
			});
		});

		await t.mutation(applyReconciledPage, {
			connectionId: aliceConnection,
			expectedGeneration: 1,
			dataType: 'steps',
			points: [
				point({ recordKey: 'alice-current-inside', timestamp: windowStart + 2_000, value: 40 })
			],
			syncId: 'final-sync',
			coveredRange: { kind: 'physical', startMs: windowStart, endMsExclusive: windowEnd }
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const keys = await t.run(async (ctx) => ({
			alice: (
				await ctx.db
					.query('healthDataPoints')
					.withIndex('by_userId_and_dataType_and_recordTimestamp', (q) =>
						q.eq('userId', 'user-a').eq('dataType', 'steps')
					)
					.take(10)
			).map((row) => row.recordKey),
			bob: (
				await ctx.db
					.query('healthDataPoints')
					.withIndex('by_userId_and_dataType_and_recordTimestamp', (q) =>
						q.eq('userId', 'user-b').eq('dataType', 'steps')
					)
					.take(10)
			).map((row) => row.recordKey),
			otherType: await ctx.db
				.query('healthDataPoints')
				.withIndex('by_userId_and_recordKey', (q) =>
					q.eq('userId', 'user-a').eq('recordKey', 'alice-other-type-inside')
				)
				.unique(),
			summary: await ctx.db
				.query('healthDailySummaries')
				.withIndex('by_userId_and_dataType_and_localDate', (q) =>
					q.eq('userId', 'user-a').eq('dataType', 'steps').eq('localDate', '2026-08-14')
				)
				.unique()
		}));
		expect(keys.alice).toEqual(['alice-current-inside', 'alice-outside']);
		expect(keys.bob).toEqual(['bob-inside']);
		expect(keys.otherType).not.toBeNull();
		expect(keys.summary).toMatchObject({
			count: 2,
			sum: 60,
			average: 30,
			min: 20,
			max: 40,
			latestValue: 20
		});
	});

	it('never cleans a non-final page even when a caller supplies a range', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		const connectionId = await seedConnection(t, 'user-a');
		const timestamp = Date.parse('2026-08-14T10:00:00Z');
		await t.run(async (ctx) => {
			await ctx.db.insert('healthDataPoints', {
				connectionId,
				userId: 'user-a',
				...point({ recordKey: 'must-remain', timestamp, value: 10 }),
				lastSeenSyncId: 'older-sync'
			});
		});

		await expect(
			t.mutation(applyReconciledPage, {
				connectionId,
				expectedGeneration: 1,
				dataType: 'steps',
				points: [],
				syncId: 'partial-sync',
				nextPageToken: 'next-page',
				coveredRange: {
					kind: 'physical',
					startMs: timestamp - 1_000,
					endMsExclusive: timestamp + 1_000
				}
			})
		).rejects.toThrow('covered range requires a final page');
		vi.runAllTimers();
		await t.finishInProgressScheduledFunctions();
		const remaining = await t.run(async (ctx) =>
			ctx.db
				.query('healthDataPoints')
				.withIndex('by_userId_and_recordKey', (q) =>
					q.eq('userId', 'user-a').eq('recordKey', 'must-remain')
				)
				.unique()
		);
		expect(remaining).not.toBeNull();
	});

	it('pages fully covered cleanup without retaining stale rows past the first batch', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-15T00:00:00Z'));
		const t = convexTest(schema, modules);
		const connectionId = await seedConnection(t, 'user-a');
		const start = Date.parse('2026-08-14T00:00:00Z');
		await t.run(async (ctx) => {
			for (let index = 0; index < 300; index += 1) {
				await ctx.db.insert('healthDataPoints', {
					connectionId,
					userId: 'user-a',
					...point({
						recordKey: `stale-${index}`,
						timestamp: start + index * 1000,
						value: index
					}),
					lastSeenSyncId: 'old-sync'
				});
			}
		});

		await t.mutation(applyReconciledPage, {
			connectionId,
			expectedGeneration: 1,
			dataType: 'steps',
			points: [],
			syncId: 'new-sync',
			coveredRange: {
				kind: 'physical',
				startMs: start,
				endMsExclusive: start + 300_000
			}
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const remaining = await t.run(async (ctx) =>
			ctx.db
				.query('healthDataPoints')
				.withIndex('by_userId_and_dataType_and_recordTimestamp', (q) =>
					q.eq('userId', 'user-a').eq('dataType', 'steps')
				)
				.take(1)
		);
		expect(remaining).toEqual([]);
	});

	it('bounds days above 10k rows to count and latest without approximate aggregates', () => {
		const rows = Array.from({ length: 10_001 }, (_, index) => ({
			recordTimestamp: index,
			primaryValue: index + 1
		}));

		expect(summarizeHealthRows(rows)).toEqual({
			count: 10_001,
			latestValue: 10_001,
			latestTimestamp: 10_000
		});
	});

	it('looks up exact latest timestamp when creation order falls outside the 10,001-row sentinel', async () => {
		const t = convexTest(schema, modules);
		const connectionId = await seedConnection(t, 'user-a');
		const start = Date.parse('2026-08-14T00:00:00Z');
		for (let batchStart = 0; batchStart < 10_001; batchStart += 500) {
			await t.run(async (ctx) => {
				for (let index = batchStart; index < Math.min(batchStart + 500, 10_001); index += 1) {
					await ctx.db.insert('healthDataPoints', {
						connectionId,
						userId: 'user-a',
						...point({
							recordKey: `dense-${index}`,
							timestamp: start + index,
							value: index
						}),
						lastSeenSyncId: 'old-sync'
					});
				}
			});
		}
		const exactLatestTimestamp = start + 1_000_000;
		await t.run(async (ctx) => {
			await ctx.db.insert('healthDataPoints', {
				connectionId,
				userId: 'user-a',
				...point({
					recordKey: 'created-last-and-latest',
					timestamp: exactLatestTimestamp,
					value: 777
				}),
				lastSeenSyncId: 'old-sync'
			});
		});

		await t.mutation(applyReconciledPage, {
			connectionId,
			expectedGeneration: 1,
			dataType: 'steps',
			points: [
				{
					...point({ recordKey: 'dense-0', timestamp: start, value: -1 }),
					payloadDigest: 'corrected-dense-zero'
				}
			],
			syncId: 'new-sync'
		});
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
			latestValue: 777,
			latestTimestamp: exactLatestTimestamp
		});
		expect(summary).not.toHaveProperty('sum');
		expect(summary).not.toHaveProperty('average');
		expect(summary).not.toHaveProperty('min');
		expect(summary).not.toHaveProperty('max');
	}, 30_000);
});
