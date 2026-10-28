import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	importSleepRecords,
	listNights,
	removeAllSleepRecords,
	type SleepRecordInput
} from './sleep';
import { createTestDatabase, createUser, type TestDatabase } from './testing/database';
import {
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
			await importSleepRecords(db, owner, [night(first), night(second), night(second)])
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
			wokeUp: first,
			sleepQuality: 80,
			timeInBedSeconds: 8 * 3600,
			timeAsleepSeconds: 7 * 3600,
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
});

describe('workout imports', () => {
	it('imports sets once and summarizes volume, reps and exercises', async () => {
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
			volume: 60 * 8 + 65 * 6,
			totalReps: 34
		});
		expect(summary.exerciseTitles.sort()).toEqual(['Bench Press', 'Push Up']);
	});

	it('sums every workout per local day, without a cap on history', async () => {
		const { db } = database;
		const owner = await createUser(db);
		const morning = Date.UTC(2026, 9, 10, 8);
		const evening = Date.UTC(2026, 9, 10, 23);
		await importWorkouts(db, owner, [
			{ ...pushDay, startTime: morning, endTime: morning + 3600_000 },
			{ ...pushDay, title: 'Push 2', startTime: evening, endTime: evening + 3600_000 }
		]);

		expect(await listTrainingDays(db, owner, 'UTC')).toEqual([
			{ day: '2026-10-10', workouts: 2, volume: 2 * 870 }
		]);
		// 23:00 UTC is already the next day in Madrid (UTC+2 in October).
		expect(await listTrainingDays(db, owner, 'Europe/Madrid')).toEqual([
			{ day: '2026-10-10', workouts: 1, volume: 870 },
			{ day: '2026-10-11', workouts: 1, volume: 870 }
		]);
		expect(await listWorkouts(db, owner, 1)).toHaveLength(1);
	});

	it('returns one of the owner’s workouts with sets grouped by exercise', async () => {
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

	it('lists only loaded exercises and summarizes each session in order', async () => {
		const { db } = database;
		const owner = await createUser(db);
		await importWorkouts(db, owner, [
			pushDay,
			{
				...pushDay,
				startTime: pushDay.startTime + 86_400_000,
				endTime: pushDay.endTime + 86_400_000
			}
		]);

		expect(await listExercises(db, owner)).toEqual([
			{ exerciseTitle: 'Bench Press', setsCount: 4, lastPerformed: pushDay.startTime + 86_400_000 }
		]);
		const sessions = await exerciseSessions(db, owner, 'Bench Press');
		expect(sessions).toEqual([
			{
				workoutId: expect.any(String),
				startTime: pushDay.startTime,
				sets: 2,
				maxWeight: 65,
				volume: 60 * 8 + 65 * 6
			},
			{
				workoutId: expect.any(String),
				startTime: pushDay.startTime + 86_400_000,
				sets: 2,
				maxWeight: 65,
				volume: 60 * 8 + 65 * 6
			}
		]);
		// Bodyweight sets count, without weight or volume.
		expect(await exerciseSessions(db, owner, 'Push Up')).toEqual([
			expect.objectContaining({ sets: 1, maxWeight: 0, volume: 0 }),
			expect.objectContaining({ sets: 1, maxWeight: 0, volume: 0 })
		]);

		await removeAllWorkouts(db, owner);
		expect(await listWorkouts(db, owner, 10)).toEqual([]);
		expect(await exerciseSessions(db, owner, 'Bench Press')).toEqual([]);
	});
});
