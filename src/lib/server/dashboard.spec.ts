import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDashboard, localDate, resolveTimeZone } from './dashboard';
import { importSleepRecords } from './sleep';
import { createTestDatabase, createUser, type TestDatabase } from './testing/database';
import { importWorkouts } from './workouts';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.close();
});

describe('resolveTimeZone', () => {
	it('accepts IANA names and falls back to UTC', () => {
		expect(resolveTimeZone('Europe/Madrid')).toBe('Europe/Madrid');
		expect(resolveTimeZone(undefined)).toBe('UTC');
		expect(resolveTimeZone('Not/AZone')).toBe('UTC');
		expect(resolveTimeZone("UTC'; drop table workout; --")).toBe('UTC');
	});
});

describe('localDate', () => {
	it('returns the calendar date in the time zone', () => {
		const lateEvening = new Date(Date.UTC(2026, 9, 26, 23, 30));
		expect(localDate('UTC', lateEvening)).toBe('2026-10-26');
		expect(localDate('Europe/Madrid', lateEvening)).toBe('2026-10-27');
		expect(localDate('America/New_York', lateEvening)).toBe('2026-10-26');
	});
});

describe('loadDashboard', () => {
	it('dates nights and training in the time zone and lists recent workouts', async () => {
		const { db } = database;
		const userId = await createUser(db);
		// Madrid is UTC+1 after the clocks change on 25 October.
		const start = Date.UTC(2026, 9, 26, 23, 30);
		await importWorkouts(db, userId, [
			{
				title: 'Late session',
				startTime: start,
				endTime: start + 3600_000,
				sets: [{ exerciseTitle: 'Squat', setIndex: 0, setType: 'normal', weightKg: 100, reps: 5 }]
			}
		]);
		await importSleepRecords(db, userId, [
			{
				wentToBed: Date.UTC(2026, 9, 26, 23, 45),
				wokeUp: Date.UTC(2026, 9, 27, 6),
				sleepQuality: 80,
				timeInBedSeconds: 7 * 3600,
				timeAsleepSeconds: 6 * 3600,
				asleepAfterSeconds: 600,
				didSnore: false,
				snoreTimeSeconds: 0,
				notes: []
			}
		]);

		const dashboard = await loadDashboard(
			db,
			userId,
			'Europe/Madrid',
			new Date(Date.UTC(2026, 9, 27, 9))
		);

		// In Madrid both the session and the bedtime fall after midnight, on the 27th: the session
		// is dated that day, while the night still belongs to the evening of the 26th.
		expect(dashboard).toMatchObject({
			timeZone: 'Europe/Madrid',
			today: '2026-10-27',
			trainingDays: [{ day: '2026-10-27', workouts: 1, volume: 500 }],
			nights: [{ night: '2026-10-26', sleepQuality: 80 }],
			recentWorkouts: [{ title: 'Late session', setsCount: 1, volume: 500 }]
		});
	});
});
