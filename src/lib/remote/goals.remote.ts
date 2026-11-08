import * as v from 'valibot';
import { error } from '@sveltejs/kit';
import { command, getRequestEvent, query, requested } from '$app/server';
import { GOAL_UNITS, HISTORY_DAYS, MAX_AMOUNT } from '#lib/daily-goals.js';
import { dayFromNumber, dayNumber } from '#lib/days.js';
import { localDate, resolveTimeZone } from '#lib/server/dashboard.js';
import { db } from '#lib/server/db/index.js';
import * as goals from '#lib/server/daily-goals.js';
import { requireUserId } from '#lib/server/session.js';
import { TIME_ZONE_COOKIE } from '#lib/time-zone.js';

const day = v.pipe(
	v.string(),
	v.isoDate(),
	v.check((value) => dayFromNumber(dayNumber(value)) === value, 'Invalid date')
);
const amount = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_AMOUNT));
const goalName = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));
const goalId = v.pipe(v.string(), v.uuid());
const weekdays = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(127));

/** The signed-in user and their local today, from the time zone cookie. */
function context() {
	const userId = requireUserId();
	const timeZone = resolveTimeZone(getRequestEvent().cookies.get(TIME_ZONE_COOKIE));
	return { userId, timeZone, today: localDate(timeZone, new Date()) };
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (cause) {
		if (cause instanceof goals.DailyGoalError) {
			error(cause.code === 'not-found' ? 404 : 400, cause.message);
		}
		throw cause;
	}
}

/** Refreshes the goal views the client asked for, in the same response as the command. */
async function refreshGoalViews(): Promise<void> {
	await Promise.all([
		requested(getGoalDay, 4).refreshAll(),
		requested(getGoalHistory, 1).refreshAll(),
		requested(getGoals, 1).refreshAll()
	]);
}

/** One day's goals and progress; `null` means today. */
export const getGoalDay = query(v.nullable(day), async (requestedDay) => {
	const { userId, timeZone, today } = context();
	const target = requestedDay ?? today;
	if (target > today) error(400, 'Cannot show a future day');
	return { timeZone, ...(await goals.loadGoalDay(db, userId, target, today)) };
});

export const getGoalHistory = query(async () => {
	const { userId, today } = context();
	return await goals.loadGoalHistory(db, userId, today, HISTORY_DAYS);
});

export const getGoals = query(async () => {
	const { userId, today } = context();
	return await goals.listGoals(db, userId, today);
});

export const createGoal = command(
	v.object({ name: goalName, unit: v.picklist(GOAL_UNITS), target: amount }),
	async (input) => {
		const { userId, today } = context();
		const id = await guarded(() => goals.createGoal(db, userId, today, input));
		await refreshGoalViews();
		return { id };
	}
);

export const updateGoal = command(
	v.object({ goalId, name: v.optional(goalName), target: v.optional(amount) }),
	async ({ goalId: id, ...changes }) => {
		const { userId, today } = context();
		await guarded(() => goals.updateGoal(db, userId, today, id, changes));
		await refreshGoalViews();
	}
);

export const reorderGoals = command(v.pipe(v.array(goalId), v.maxLength(100)), async (ids) => {
	const { userId } = context();
	await guarded(() => goals.reorderGoals(db, userId, ids));
	await refreshGoalViews();
});

export const archiveGoal = command(goalId, async (id) => {
	const { userId, today } = context();
	await guarded(() => goals.archiveGoal(db, userId, today, id));
	await refreshGoalViews();
});

export const setSchedule = command(weekdays, async (mask) => {
	const { userId, today } = context();
	await goals.setSchedule(db, userId, today, mask);
	await refreshGoalViews();
});

export const addEntry = command(v.object({ goalId, day, amount }), async (input) => {
	const { userId, today } = context();
	await guarded(() => goals.addEntry(db, userId, today, input));
	await refreshGoalViews();
});

export const undoLastEntry = command(v.object({ goalId, day }), async (input) => {
	const { userId } = context();
	await goals.undoLastEntry(db, userId, input);
	await refreshGoalViews();
});
