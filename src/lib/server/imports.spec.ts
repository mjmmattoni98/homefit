import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { googleHealthConnection, healthDataPoint } from './db/schema';
import { normalizeGooglePoint } from './google-health/normalize';
import { getMetricDefinition } from './google-health/registry';
import { backfillSleepDurations } from './google-health/sleep-durations';
import { applyPoints } from './google-health/store';
import {
	importSleepRecords,
	listGoogleSleepNights,
	listNights,
	removeAllSleepRecords,
	type SleepRecordInput
} from './sleep';
import { createTestDatabase, createUser, type TestDatabase } from './testing/database';
import {
	estimateOneRepMax,
	exerciseSessions,
	getWorkoutDetail,
	importWorkouts,
	listExercises,
	listTrainingDays,
	listWorkouts,
	removeAllWorkouts,
	type WorkoutInput
} from './workouts';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.close();
});

function night(wokeUp: number, overrides: Partial<SleepRecordInput> = {}): SleepRecordInput {
	return {
		wentToBed: wokeUp - 8 * 3600_000,
		wokeUp,
		sleepQuality: 80,
		timeInBedSeconds: 8 * 3600,
		timeAsleepSeconds: 7 * 3600,
		asleepAfterSeconds: 600,
		didSnore: false,
		snoreTimeSeconds: 0,
		notes: ['Coffee'],
		...overrides
	};
}

const pushDay: WorkoutInput = {
	title: 'Push',
	startTime: Date.UTC(2026, 9, 10, 18),
	endTime: Date.UTC(2026, 9, 10, 19),
	sets: [
		{ exerciseTitle: 'Bench Press', setIndex: 0, setType: 'normal', weightKg: 60, reps: 8 },
		{ exerciseTitle: 'Bench Press', setIndex: 1, setType: 'normal', weightKg: 65, reps: 6 },
		{ exerciseTitle: 'Push Up', setIndex: 0, setType: 'normal', reps: 20 }
	]
};

describe('sleep imports', () => {
	it('deduplicates nights by wake-up time and isolates owners', async () => {
		const { db } = database;
		const owner = await createUser(db);
		const other = await createUser(db);
		const first = Date.UTC(2026, 9, 11, 7);
		const second = Date.UTC(2026, 9, 12, 7);

		expect(
			await importSleepRecords(db, owner, [
				night(first, { regularity: 88, city: 'Madrid', movementsPerHour: 12 }),
				night(second),
				night(second)
			])
		).toEqual({ imported: 2, skipped: 1 });
		expect(await importSleepRecords(db, owner, [night(first, { sleepQuality: 10 })])).toEqual({
			imported: 0,
			skipped: 1
		});
		expect(await importSleepRecords(db, other, [night(first)])).toEqual({
			imported: 1,
			skipped: 0
		});

		const records = await listNights(db, owner, 'UTC');
		expect(records.map((record) => record.wokeUp)).toEqual([first, second]);
		expect(records[0]).toEqual({
			night: '2026-10-10',
			wentToBed: first - 8 * 3600_000,
			wokeUp: first,
			sleepQuality: 80,
			timeInBedSeconds: 8 * 3600,
			timeAsleepSeconds: 7 * 3600,
			asleepAfterSeconds: 600,
			regularity: 88,
			snoreTimeSeconds: 0,
			movementsPerHour: 12,
			city: 'Madrid',
			notes: ['Coffee']
		});

		await removeAllSleepRecords(db, owner);
		expect(await listNights(db, owner, 'UTC')).toEqual([]);
		expect(await listNights(db, other, 'UTC')).toHaveLength(1);
	});

	it('dates each night by the evening it began, in the given time zone', async () => {
		const { db } = database;
		const owner = await createUser(db);
		await importSleepRecords(db, owner, [
			// 22:30 UTC: still the 10th in UTC, already the 11th in Tokyo (07:30).
			night(Date.UTC(2026, 9, 11, 6), { wentToBed: Date.UTC(2026, 9, 10, 22, 30) }),
			// 01:00 UTC: after midnight, so it belongs to the evening before in UTC.
			night(Date.UTC(2026, 9, 12, 8), { wentToBed: Date.UTC(2026, 9, 12, 1) })
		]);

		expect((await listNights(db, owner, 'UTC')).map((record) => record.night)).toEqual([
			'2026-10-10',
			'2026-10-11'
		]);
		expect((await listNights(db, owner, 'Asia/Tokyo')).map((record) => record.night)).toEqual([
			'2026-10-11',
			'2026-10-12'
		]);
	});

	it('limits nights to an evening-date window', async () => {
		const { db } = database;
		const owner = await createUser(db);
		await importSleepRecords(db, owner, [
			night(Date.UTC(2026, 9, 1, 7)),
			night(Date.UTC(2026, 9, 12, 7)),
			night(Date.UTC(2026, 9, 20, 7))
		]);

		expect(
			(await listNights(db, owner, 'UTC', { from: '2026-10-10', to: '2026-10-12' })).map(
				(record) => record.night
			)
		).toEqual(['2026-10-11']);
	});

	it('lists Google Health sleep sessions with asleep duration, in-bed span and stage breakdown', async () => {
		const { db } = database;
		const owner = await createUser(db);
		const [connection] = await db
			.insert(googleHealthConnection)
			.values({
				userId: owner,
				status: 'active'
			})
			.returning({ id: googleHealthConnection.id });

		const start = new Date(Date.UTC(2026, 9, 12, 0, 15));
		const end = new Date(Date.UTC(2026, 9, 12, 8, 15));
		await db.insert(healthDataPoint).values({
			connectionId: connection.id,
			userId: owner,
			provider: 'google_health',
			recordKey: 'gh-sleep-1',
			dataType: 'sleep',
			category: 'sleep',
			recordTimestamp: start,
			startTime: start,
			endTime: end,
			localDate: '2026-10-12',
			primaryValue: 430,
			primaryUnit: 'min',
			sourceApplication: 'Pixel Watch',
			payloadDigest: 'digest-1',
			payload: {
				summary: {
					minutesAsleep: 430,
					minutesAwake: 50,
					minutesDeep: 85,
					minutesLight: 245,
					minutesRem: 100
				}
			},
			lastSeenSyncId: 'sync-1'
		});
		await backfillSleepDurations(db);

		const ghNights = await listGoogleSleepNights(db, owner, 'UTC');
		expect(ghNights).toEqual([
			{
				// Started 00:15 UTC on Oct 12 -> attributed to the evening of Oct 11 (-5h rule).
				night: '2026-10-11',
				startTime: start.getTime(),
				endTime: end.getTime(),
				timeInBedSeconds: 8 * 3600,
				timeAsleepSeconds: 430 * 60,
				awakeSeconds: 50 * 60,
				deepSeconds: 85 * 60,
				lightSeconds: 245 * 60,
				remSeconds: 100 * 60,
				sourceApplication: 'Pixel Watch',
				sourceDevice: undefined
			}
		]);
	});

	it('copies stage totals onto the row when a Google sleep session is stored', async () => {
		const { db } = database;
		const owner = await createUser(db);
		const [connection] = await db
			.insert(googleHealthConnection)
			.values({ userId: owner, status: 'active' })
			.returning({ id: googleHealthConnection.id });
		const definition = getMetricDefinition('sleep');
		if (definition === null) throw new Error('sleep metric is missing');
		const point = normalizeGooglePoint(definition, {
			sleep: {
				interval: {
					startTime: '2026-10-11T22:00:00Z',
					endTime: '2026-10-12T06:00:00Z'
				},
				type: 'STAGES',
				summary: {
					minutesAsleep: 430,
					minutesInBed: 500,
					minutesAwake: 50,
					minutesDeep: 85,
					minutesLight: 245,
					minutesRem: 100
				}
			}
		});

		await applyPoints(
			db,
			{ connectionId: connection.id, userId: owner, generation: 1 },
			'sleep',
			[point],
			{
				syncId: 'sync-stored',
				seenEpoch: 1
			}
		);

		const [stored] = await listGoogleSleepNights(db, owner, 'UTC');
		expect(stored).toMatchObject({
			night: '2026-10-11',
			timeInBedSeconds: 500 * 60,
			timeAsleepSeconds: 430 * 60,
			awakeSeconds: 50 * 60,
			deepSeconds: 85 * 60,
			lightSeconds: 245 * 60,
			remSeconds: 100 * 60
		});
	});
});

describe('workout imports', () => {
	it('imports sets once and summarizes working volume, reps and exercises', async () => {
		const { db } = database;
		const owner = await createUser(db);

		expect(await importWorkouts(db, owner, [pushDay])).toEqual({
			imported: 1,
			skipped: 0,
			setsImported: 3
		});
		expect(await importWorkouts(db, owner, [pushDay])).toEqual({
			imported: 0,
			skipped: 1,
			setsImported: 0
		});

		const [summary] = await listWorkouts(db, owner, 10);
		expect(summary).toMatchObject({
			title: 'Push',
			startTime: pushDay.startTime,
			setsCount: 3,
			workingSets: 3,
			hardSets: 0,
			volume: 60 * 8 + 65 * 6,
			totalReps: 34
		});
		expect(summary.exerciseTitles.sort()).toEqual(['Bench Press', 'Push Up']);
	});

	it('summarizes only the newest workouts when the list is limited', async () => {
		const { db } = database;
		const owner = await createUser(db);
		const earlier = Date.UTC(2026, 8, 1, 18);
		const later = Date.UTC(2026, 9, 10, 18);
		await importWorkouts(db, owner, [
			{
				title: 'Earlier',
				startTime: earlier,
				endTime: earlier + 3600_000,
				sets: [{ exerciseTitle: 'Squat', setIndex: 0, setType: 'normal', weightKg: 100, reps: 5 }]
			},
			{
				title: 'Later',
				startTime: later,
				endTime: later + 3600_000,
				sets: [{ exerciseTitle: 'Row', setIndex: 0, setType: 'normal', weightKg: 40, reps: 8 }]
			}
		]);

		const listed = await listWorkouts(db, owner, 1);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ title: 'Later', setsCount: 1, volume: 320 });
	});

	it('sums every workout per local day, excluding warmups from working volume', async () => {
		const { db } = database;
		const owner = await createUser(db);
		const morning = Date.UTC(2026, 9, 10, 8);
		const evening = Date.UTC(2026, 9, 10, 23);
		await importWorkouts(db, owner, [
			{
				...pushDay,
				startTime: morning,
				endTime: morning + 3600_000,
				sets: [
					{ exerciseTitle: 'Bench Press', setIndex: 0, setType: 'warmup', weightKg: 40, reps: 10 },
					...pushDay.sets
				]
			},
			{ ...pushDay, title: 'Push 2', startTime: evening, endTime: evening + 3600_000 }
		]);

		expect(await listTrainingDays(db, owner, 'UTC')).toEqual([
			{
				day: '2026-10-10',
				workouts: 2,
				volume: 2 * 870,
				workingSets: 6,
				hardSets: 0,
				meanRpe: undefined,
				latestEndTime: evening + 3600_000
			}
		]);
		// 23:00 UTC is already the next day in Madrid (UTC+2 in October).
		expect(await listTrainingDays(db, owner, 'Europe/Madrid')).toEqual([
			expect.objectContaining({ day: '2026-10-10', workouts: 1, volume: 870 }),
			expect.objectContaining({ day: '2026-10-11', workouts: 1, volume: 870 })
		]);
		expect(await listWorkouts(db, owner, 1)).toHaveLength(1);
	});

	it('returns one of the owner\u2019s workouts with sets grouped by exercise', async () => {
		const { db } = database;
		const owner = await createUser(db);
		const other = await createUser(db);
		await importWorkouts(db, owner, [pushDay]);
		const [{ id }] = await listWorkouts(db, owner, 1);

		expect(await getWorkoutDetail(db, owner, id)).toEqual({
			id,
			title: 'Push',
			startTime: pushDay.startTime,
			endTime: pushDay.endTime,
			description: undefined,
			exercises: [
				{
					exerciseTitle: 'Bench Press',
					notes: undefined,
					sets: [
						expect.objectContaining({ setIndex: 0, weightKg: 60, reps: 8 }),
						expect.objectContaining({ setIndex: 1, weightKg: 65, reps: 6 })
					]
				},
				{
					exerciseTitle: 'Push Up',
					notes: undefined,
					sets: [expect.objectContaining({ setIndex: 0, weightKg: undefined, reps: 20 })]
				}
			]
		});
		expect(await getWorkoutDetail(db, other, id)).toBeNull();
	});

	it('classifies weighted, bodyweight and cardio exercises and summarizes sessions with e1RM and rep maxes', async () => {
		const { db } = database;
		const owner = await createUser(db);
		await importWorkouts(db, owner, [
			pushDay,
			{
				...pushDay,
				startTime: pushDay.startTime + 86_400_000,
				endTime: pushDay.endTime + 86_400_000,
				sets: [
					...pushDay.sets,
					{
						exerciseTitle: 'Running',
						setIndex: 0,
						setType: 'normal',
						distanceKm: 5,
						durationSeconds: 1500
					}
				]
			}
		]);

		expect(await listExercises(db, owner)).toEqual([
			{
				exerciseTitle: 'Bench Press',
				setsCount: 4,
				lastPerformed: pushDay.startTime + 86_400_000,
				mode: 'weighted'
			},
			{
				exerciseTitle: 'Push Up',
				setsCount: 2,
				lastPerformed: pushDay.startTime + 86_400_000,
				mode: 'bodyweight'
			},
			{
				exerciseTitle: 'Running',
				setsCount: 1,
				lastPerformed: pushDay.startTime + 86_400_000,
				mode: 'cardio'
			}
		]);
		const sessions = await exerciseSessions(db, owner, 'Bench Press');
		const expectedE1rm = Math.max(estimateOneRepMax(60, 8), estimateOneRepMax(65, 6));
		expect(sessions).toEqual([
			{
				workoutId: expect.any(String),
				startTime: pushDay.startTime,
				sets: 2,
				workingSets: 2,
				hardSets: 0,
				maxWeight: 65,
				e1rm: expectedE1rm,
				volume: 60 * 8 + 65 * 6,
				maxReps: 8,
				totalReps: 14,
				distanceKm: 0,
				durationSeconds: 0,
				meanRpe: undefined,
				repMaxes: [
					{ reps: 6, weight: 65 },
					{ reps: 8, weight: 60 }
				]
			},
			{
				workoutId: expect.any(String),
				startTime: pushDay.startTime + 86_400_000,
				sets: 2,
				workingSets: 2,
				hardSets: 0,
				maxWeight: 65,
				e1rm: expectedE1rm,
				volume: 60 * 8 + 65 * 6,
				maxReps: 8,
				totalReps: 14,
				distanceKm: 0,
				durationSeconds: 0,
				meanRpe: undefined,
				repMaxes: [
					{ reps: 6, weight: 65 },
					{ reps: 8, weight: 60 }
				]
			}
		]);
		// Bodyweight sets count reps without weight or volume.
		expect(await exerciseSessions(db, owner, 'Push Up')).toEqual([
			expect.objectContaining({ sets: 1, maxWeight: 0, volume: 0, maxReps: 20, totalReps: 20 }),
			expect.objectContaining({ sets: 1, maxWeight: 0, volume: 0, maxReps: 20, totalReps: 20 })
		]);

		await removeAllWorkouts(db, owner);
		expect(await listWorkouts(db, owner, 10)).toEqual([]);
		expect(await exerciseSessions(db, owner, 'Bench Press')).toEqual([]);
	});
});
