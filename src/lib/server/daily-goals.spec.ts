import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKWEEK_MASK } from '#lib/daily-goals.js';
import { dailyGoalSchedule, dailyGoalTarget } from './db/schema';
import {
	archiveGoal,
	createGoal,
	listGoals,
	reorderGoals,
	setSchedule,
	updateGoal
} from './daily-goals';
import { createTestDatabase, createUser, type TestDatabase } from './testing/database';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.close();
});

// 2026-11-02 is a Monday.
const MONDAY = '2026-11-02';

describe('daily goal settings', () => {
	it('creates goals in order with a target from today', async () => {
		const { db } = database;
		const user = await createUser(db);
		const walk = await createGoal(db, user, MONDAY, {
			name: 'Walking pad',
			unit: 'minutes',
			target: 60
		});
		const push = await createGoal(db, user, MONDAY, {
			name: 'Push-ups',
			unit: 'reps',
			target: 100
		});
		await setSchedule(db, user, MONDAY, WORKWEEK_MASK);

		expect(await listGoals(db, user, MONDAY)).toEqual({
			goals: [
				{ id: walk, name: 'Walking pad', unit: 'minutes', target: 60 },
				{ id: push, name: 'Push-ups', unit: 'reps', target: 100 }
			],
			weekdays: WORKWEEK_MASK
		});
	});

	it('versions target changes by day, keeping one row per day', async () => {
		const { db } = database;
		const user = await createUser(db);
		const goal = await createGoal(db, user, MONDAY, {
			name: 'Push-ups',
			unit: 'reps',
			target: 100
		});
		await updateGoal(db, user, '2026-11-04', goal, { target: 110 });
		await updateGoal(db, user, '2026-11-04', goal, { target: 120 });
		await updateGoal(db, user, '2026-11-04', goal, { name: 'Diamond push-ups' });

		const rows = await db
			.select()
			.from(dailyGoalTarget)
			.where(eq(dailyGoalTarget.goalId, goal))
			.orderBy(asc(dailyGoalTarget.effectiveFrom));
		expect(rows.map((row) => [row.effectiveFrom, row.target])).toEqual([
			[MONDAY, 100],
			['2026-11-04', 120]
		]);
		expect((await listGoals(db, user, '2026-11-04')).goals).toEqual([
			{ id: goal, name: 'Diamond push-ups', unit: 'reps', target: 120 }
		]);
	});

	it('versions the schedule by day', async () => {
		const { db } = database;
		const user = await createUser(db);
		await setSchedule(db, user, MONDAY, WORKWEEK_MASK);
		await setSchedule(db, user, MONDAY, 0b0111111);
		await setSchedule(db, user, '2026-11-09', WORKWEEK_MASK);

		const rows = await db
			.select()
			.from(dailyGoalSchedule)
			.where(eq(dailyGoalSchedule.userId, user))
			.orderBy(asc(dailyGoalSchedule.effectiveFrom));
		expect(rows.map((row) => [row.effectiveFrom, row.weekdays])).toEqual([
			[MONDAY, 0b0111111],
			['2026-11-09', WORKWEEK_MASK]
		]);
		expect((await listGoals(db, user, '2026-11-05')).weekdays).toBe(0b0111111);
	});

	it('reorders goals and rejects orders that do not list every goal once', async () => {
		const { db } = database;
		const user = await createUser(db);
		const a = await createGoal(db, user, MONDAY, { name: 'A', unit: 'reps', target: 10 });
		const b = await createGoal(db, user, MONDAY, { name: 'B', unit: 'reps', target: 10 });
		const c = await createGoal(db, user, MONDAY, { name: 'C', unit: 'reps', target: 10 });

		await reorderGoals(db, user, [c, a, b]);
		expect((await listGoals(db, user, MONDAY)).goals.map((goal) => goal.id)).toEqual([c, a, b]);

		await expect(reorderGoals(db, user, [a, b])).rejects.toMatchObject({ code: 'invalid-order' });
		await expect(reorderGoals(db, user, [a, a, b])).rejects.toMatchObject({
			code: 'invalid-order'
		});
	});

	it('archives a goal from today', async () => {
		const { db } = database;
		const user = await createUser(db);
		const a = await createGoal(db, user, MONDAY, { name: 'A', unit: 'reps', target: 10 });
		const b = await createGoal(db, user, MONDAY, { name: 'B', unit: 'seconds', target: 60 });

		await archiveGoal(db, user, '2026-11-05', a);

		expect((await listGoals(db, user, '2026-11-05')).goals.map((goal) => goal.id)).toEqual([b]);
		await expect(updateGoal(db, user, '2026-11-05', a, { target: 5 })).rejects.toMatchObject({
			code: 'not-found'
		});
		await expect(archiveGoal(db, user, '2026-11-05', a)).rejects.toMatchObject({
			code: 'not-found'
		});
		await reorderGoals(db, user, [b]);
	});

	it('keeps users apart', async () => {
		const { db } = database;
		const owner = await createUser(db);
		const other = await createUser(db);
		const goal = await createGoal(db, owner, MONDAY, { name: 'A', unit: 'reps', target: 10 });

		await expect(updateGoal(db, other, MONDAY, goal, { name: 'Mine' })).rejects.toMatchObject({
			code: 'not-found'
		});
		await expect(archiveGoal(db, other, MONDAY, goal)).rejects.toMatchObject({
			code: 'not-found'
		});
		await expect(reorderGoals(db, other, [goal])).rejects.toMatchObject({
			code: 'invalid-order'
		});
		expect(await listGoals(db, other, MONDAY)).toEqual({ goals: [], weekdays: null });
	});
});
