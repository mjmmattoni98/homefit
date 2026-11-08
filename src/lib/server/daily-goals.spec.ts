import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKWEEK_MASK } from '#lib/daily-goals.js';
import { dailyGoalSchedule, dailyGoalTarget } from './db/schema';
import {
	addEntry,
	archiveGoal,
	createGoal,
	listGoals,
	loadGoalDay,
	loadGoalHistory,
	reorderGoals,
	setSchedule,
	undoLastEntry,
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

describe('daily goal entries', () => {
	it('totals entries per goal and undoes the latest one', async () => {
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
		const day = '2026-11-03';

		await addEntry(db, user, day, { goalId: walk, day, amount: 20 });
		await addEntry(db, user, day, { goalId: walk, day, amount: 15 });
		await addEntry(db, user, day, { goalId: push, day, amount: 100 });

		let view = await loadGoalDay(db, user, day, day);
		expect(view).toMatchObject({ day, today: day, scheduled: true, status: 'in-progress' });
		expect(
			view.goals.map((goal) => [
				goal.name,
				goal.total,
				goal.target,
				goal.met,
				goal.entries.map((entry) => entry.amount)
			])
		).toEqual([
			['Walking pad', 35, 60, false, [20, 15]],
			['Push-ups', 100, 100, true, [100]]
		]);

		await undoLastEntry(db, user, { goalId: walk, day });
		view = await loadGoalDay(db, user, day, day);
		expect(view.goals[0]).toMatchObject({ total: 20, entries: [{ amount: 20 }] });

		await undoLastEntry(db, user, { goalId: walk, day });
		await undoLastEntry(db, user, { goalId: walk, day });
		view = await loadGoalDay(db, user, day, day);
		expect(view.goals[0]).toMatchObject({ total: 0, entries: [] });
		expect(view.goals[1]).toMatchObject({ total: 100 });
	});

	it('rejects future days and goals that do not apply on the day', async () => {
		const { db } = database;
		const user = await createUser(db);
		const goal = await createGoal(db, user, MONDAY, {
			name: 'Plank',
			unit: 'seconds',
			target: 120
		});

		await expect(
			addEntry(db, user, '2026-11-03', { goalId: goal, day: '2026-11-04', amount: 30 })
		).rejects.toMatchObject({ code: 'future-day' });
		await expect(
			addEntry(db, user, '2026-11-03', { goalId: goal, day: '2026-11-01', amount: 30 })
		).rejects.toMatchObject({ code: 'inactive-goal' });

		await archiveGoal(db, user, '2026-11-05', goal);
		await expect(
			addEntry(db, user, '2026-11-05', { goalId: goal, day: '2026-11-05', amount: 30 })
		).rejects.toMatchObject({ code: 'inactive-goal' });
		await addEntry(db, user, '2026-11-05', { goalId: goal, day: '2026-11-04', amount: 30 });
		expect((await loadGoalDay(db, user, '2026-11-04', '2026-11-05')).goals).toMatchObject([
			{ id: goal, total: 30 }
		]);
	});

	it('keeps entries private', async () => {
		const { db } = database;
		const owner = await createUser(db);
		const other = await createUser(db);
		const goal = await createGoal(db, owner, MONDAY, { name: 'A', unit: 'reps', target: 10 });
		await addEntry(db, owner, MONDAY, { goalId: goal, day: MONDAY, amount: 10 });

		await expect(
			addEntry(db, other, MONDAY, { goalId: goal, day: MONDAY, amount: 5 })
		).rejects.toMatchObject({ code: 'not-found' });
		await undoLastEntry(db, other, { goalId: goal, day: MONDAY });

		expect((await loadGoalDay(db, owner, MONDAY, MONDAY)).goals[0]).toMatchObject({ total: 10 });
		expect((await loadGoalDay(db, other, MONDAY, MONDAY)).goals).toEqual([]);
	});

	it('summarizes history with streaks', async () => {
		const { db } = database;
		const user = await createUser(db);
		const goal = await createGoal(db, user, MONDAY, {
			name: 'Walking pad',
			unit: 'minutes',
			target: 30
		});
		await setSchedule(db, user, MONDAY, WORKWEEK_MASK);
		const logged: [string, number][] = [
			['2026-11-02', 30],
			['2026-11-03', 30],
			['2026-11-04', 10],
			['2026-11-05', 20],
			['2026-11-05', 10],
			['2026-11-06', 30]
		];
		for (const [day, amount] of logged) {
			await addEntry(db, user, '2026-11-08', { goalId: goal, day, amount });
		}

		const history = await loadGoalHistory(db, user, '2026-11-08', 7);
		expect(history.days.map((day) => day.status)).toEqual([
			'done',
			'done',
			'missed',
			'done',
			'done',
			'rest',
			'rest'
		]);
		expect(history.currentStreak).toBe(2);
		expect(history.bestStreak).toBe(2);
	});
});
