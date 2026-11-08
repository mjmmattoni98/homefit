import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { dayFromNumber, dayNumber } from '#lib/days.js';
import {
	evaluateDay,
	firstGoalDay,
	scheduleOn,
	summarizeHistory,
	targetOn,
	type DayStatus,
	type GoalHistory,
	type GoalRules,
	type GoalUnit,
	type NewGoal,
	type ScheduleVersion
} from '#lib/daily-goals.js';
import { dailyGoal, dailyGoalEntry, dailyGoalSchedule, dailyGoalTarget } from './db/schema';
import type { Database, Executor } from './db/types';

export type DailyGoalErrorCode = 'not-found' | 'future-day' | 'inactive-goal' | 'invalid-order';

/** A rejected goal operation; remote functions turn it into a 404 or 400 response. */
export class DailyGoalError extends Error {
	constructor(
		readonly code: DailyGoalErrorCode,
		message: string
	) {
		super(message);
		this.name = 'DailyGoalError';
	}
}

export interface GoalSettingsItem {
	id: string;
	name: string;
	unit: GoalUnit;
	/** The target in effect today. */
	target: number;
}

export interface GoalSettings {
	/** Goals that are not archived, in display order. */
	goals: GoalSettingsItem[];
	/** Today's weekday mask, or null before the first schedule is set. */
	weekdays: number | null;
}

export interface StoredGoal extends GoalRules {
	name: string;
	unit: GoalUnit;
}

/** Every goal the user ever had, with all target versions, and the schedule versions. */
export async function loadRules(
	db: Executor,
	userId: string
): Promise<{ goals: StoredGoal[]; schedule: ScheduleVersion[] }> {
	const goalRows = await db
		.select({
			id: dailyGoal.id,
			name: dailyGoal.name,
			unit: dailyGoal.unit,
			archivedOn: dailyGoal.archivedOn
		})
		.from(dailyGoal)
		.where(eq(dailyGoal.userId, userId))
		.orderBy(asc(dailyGoal.sortOrder), asc(dailyGoal.createdAt));
	const targetRows = await db
		.select({
			goalId: dailyGoalTarget.goalId,
			effectiveFrom: dailyGoalTarget.effectiveFrom,
			target: dailyGoalTarget.target
		})
		.from(dailyGoalTarget)
		.innerJoin(dailyGoal, eq(dailyGoal.id, dailyGoalTarget.goalId))
		.where(eq(dailyGoal.userId, userId));
	const schedule = await db
		.select({
			effectiveFrom: dailyGoalSchedule.effectiveFrom,
			weekdays: dailyGoalSchedule.weekdays
		})
		.from(dailyGoalSchedule)
		.where(eq(dailyGoalSchedule.userId, userId));

	const goals = goalRows.map((row) => ({
		...row,
		targets: targetRows
			.filter((target) => target.goalId === row.id)
			.map(({ effectiveFrom, target }) => ({ effectiveFrom, target }))
	}));
	return { goals, schedule };
}

/** The user's goal, archived or not. */
export async function requireGoal(db: Executor, userId: string, goalId: string) {
	const [goal] = await db
		.select()
		.from(dailyGoal)
		.where(and(eq(dailyGoal.id, goalId), eq(dailyGoal.userId, userId)));
	if (goal === undefined) throw new DailyGoalError('not-found', 'Goal not found');
	return goal;
}

async function requireActiveGoal(db: Executor, userId: string, goalId: string) {
	const goal = await requireGoal(db, userId, goalId);
	if (goal.archivedOn !== null) throw new DailyGoalError('not-found', 'Goal not found');
	return goal;
}

async function upsertTarget(db: Executor, goalId: string, today: string, target: number) {
	await db
		.insert(dailyGoalTarget)
		.values({ goalId, effectiveFrom: today, target })
		.onConflictDoUpdate({
			target: [dailyGoalTarget.goalId, dailyGoalTarget.effectiveFrom],
			set: { target }
		});
}

export async function createGoal(
	db: Database,
	userId: string,
	today: string,
	input: NewGoal
): Promise<string> {
	return await db.transaction(async (tx) => {
		const [{ next }] = await tx
			.select({ next: sql<number>`coalesce(max(${dailyGoal.sortOrder}) + 1, 0)::int` })
			.from(dailyGoal)
			.where(eq(dailyGoal.userId, userId));
		const [goal] = await tx
			.insert(dailyGoal)
			.values({ userId, name: input.name, unit: input.unit, sortOrder: next })
			.returning({ id: dailyGoal.id });
		await upsertTarget(tx, goal.id, today, input.target);
		return goal.id;
	});
}

export async function updateGoal(
	db: Database,
	userId: string,
	today: string,
	goalId: string,
	changes: { name?: string; target?: number }
): Promise<void> {
	await db.transaction(async (tx) => {
		await requireActiveGoal(tx, userId, goalId);
		if (changes.name !== undefined) {
			await tx.update(dailyGoal).set({ name: changes.name }).where(eq(dailyGoal.id, goalId));
		}
		if (changes.target !== undefined) await upsertTarget(tx, goalId, today, changes.target);
	});
}

/** Sets the display order; `goalIds` must list every goal that is not archived exactly once. */
export async function reorderGoals(db: Database, userId: string, goalIds: string[]): Promise<void> {
	await db.transaction(async (tx) => {
		const rows = await tx
			.select({ id: dailyGoal.id })
			.from(dailyGoal)
			.where(and(eq(dailyGoal.userId, userId), isNull(dailyGoal.archivedOn)));
		const current = new Set(rows.map((row) => row.id));
		const complete =
			goalIds.length === current.size &&
			new Set(goalIds).size === goalIds.length &&
			goalIds.every((id) => current.has(id));
		if (!complete) {
			throw new DailyGoalError('invalid-order', 'The order must list every goal exactly once');
		}
		for (const [index, id] of goalIds.entries()) {
			await tx.update(dailyGoal).set({ sortOrder: index }).where(eq(dailyGoal.id, id));
		}
	});
}

export async function archiveGoal(
	db: Database,
	userId: string,
	today: string,
	goalId: string
): Promise<void> {
	await requireActiveGoal(db, userId, goalId);
	await db.update(dailyGoal).set({ archivedOn: today }).where(eq(dailyGoal.id, goalId));
}

export async function setSchedule(
	db: Database,
	userId: string,
	today: string,
	weekdays: number
): Promise<void> {
	await db
		.insert(dailyGoalSchedule)
		.values({ userId, effectiveFrom: today, weekdays })
		.onConflictDoUpdate({
			target: [dailyGoalSchedule.userId, dailyGoalSchedule.effectiveFrom],
			set: { weekdays }
		});
}

export async function listGoals(
	db: Database,
	userId: string,
	today: string
): Promise<GoalSettings> {
	const { goals, schedule } = await loadRules(db, userId);
	const items: GoalSettingsItem[] = [];
	for (const goal of goals) {
		const target = targetOn(goal, today);
		if (goal.archivedOn === null && target !== null) {
			items.push({ id: goal.id, name: goal.name, unit: goal.unit, target });
		}
	}
	return { goals: items, weekdays: scheduleOn(schedule, today) };
}

export interface GoalEntryView {
	id: string;
	amount: number;
	/** Milliseconds since the epoch. */
	createdAt: number;
}

export interface GoalProgress {
	id: string;
	name: string;
	unit: GoalUnit;
	/** The target in effect on the day shown. */
	target: number;
	total: number;
	met: boolean;
	/** That day's entries, oldest first. */
	entries: GoalEntryView[];
}

export interface GoalDay {
	day: string;
	today: string;
	scheduled: boolean;
	status: DayStatus;
	/** Goals that applied on the day, in display order. */
	goals: GoalProgress[];
}

export async function addEntry(
	db: Database,
	userId: string,
	today: string,
	input: { goalId: string; day: string; amount: number }
): Promise<void> {
	if (input.day > today) throw new DailyGoalError('future-day', 'Cannot log a future day');
	const goal = await requireGoal(db, userId, input.goalId);
	const targets = await db
		.select({ effectiveFrom: dailyGoalTarget.effectiveFrom, target: dailyGoalTarget.target })
		.from(dailyGoalTarget)
		.where(eq(dailyGoalTarget.goalId, goal.id));
	if (targetOn({ id: goal.id, archivedOn: goal.archivedOn, targets }, input.day) === null) {
		throw new DailyGoalError('inactive-goal', 'This goal does not apply on that day');
	}
	await db
		.insert(dailyGoalEntry)
		.values({ goalId: goal.id, userId, day: input.day, amount: input.amount });
}

/** Deletes the newest entry for the goal on the day; does nothing when there is none. */
export async function undoLastEntry(
	db: Database,
	userId: string,
	input: { goalId: string; day: string }
): Promise<void> {
	const [latest] = await db
		.select({ id: dailyGoalEntry.id })
		.from(dailyGoalEntry)
		.where(
			and(
				eq(dailyGoalEntry.userId, userId),
				eq(dailyGoalEntry.goalId, input.goalId),
				eq(dailyGoalEntry.day, input.day)
			)
		)
		.orderBy(desc(dailyGoalEntry.createdAt), desc(dailyGoalEntry.id))
		.limit(1);
	if (latest !== undefined) {
		await db.delete(dailyGoalEntry).where(eq(dailyGoalEntry.id, latest.id));
	}
}

export async function loadGoalDay(
	db: Database,
	userId: string,
	day: string,
	today: string
): Promise<GoalDay> {
	const { goals, schedule } = await loadRules(db, userId);
	const entries = await db
		.select({
			id: dailyGoalEntry.id,
			goalId: dailyGoalEntry.goalId,
			amount: dailyGoalEntry.amount,
			createdAt: dailyGoalEntry.createdAt
		})
		.from(dailyGoalEntry)
		.where(and(eq(dailyGoalEntry.userId, userId), eq(dailyGoalEntry.day, day)))
		.orderBy(asc(dailyGoalEntry.createdAt), asc(dailyGoalEntry.id));

	const totals = new Map<string, number>();
	for (const entry of entries) {
		totals.set(entry.goalId, (totals.get(entry.goalId) ?? 0) + entry.amount);
	}
	const result = evaluateDay(goals, schedule, totals, day, today);
	return {
		day,
		today,
		scheduled: result.scheduled,
		status: result.status,
		goals: result.goals.map(({ goal, target, total, met }) => ({
			id: goal.id,
			name: goal.name,
			unit: goal.unit,
			target,
			total,
			met,
			entries: entries
				.filter((entry) => entry.goalId === goal.id)
				.map((entry) => ({
					id: entry.id,
					amount: entry.amount,
					createdAt: entry.createdAt.getTime()
				}))
		}))
	};
}

export async function loadGoalHistory(
	db: Database,
	userId: string,
	today: string,
	days: number
): Promise<GoalHistory> {
	const { goals, schedule } = await loadRules(db, userId);
	// Streaks may reach back past the window, to the first goal.
	const windowStart = dayFromNumber(dayNumber(today) - days + 1);
	const first = firstGoalDay(goals);
	const from = first !== null && first < windowStart ? first : windowStart;

	const rows = await db
		.select({
			day: dailyGoalEntry.day,
			goalId: dailyGoalEntry.goalId,
			total: sql<number>`sum(${dailyGoalEntry.amount})::int`
		})
		.from(dailyGoalEntry)
		.where(
			and(
				eq(dailyGoalEntry.userId, userId),
				gte(dailyGoalEntry.day, from),
				lte(dailyGoalEntry.day, today)
			)
		)
		.groupBy(dailyGoalEntry.day, dailyGoalEntry.goalId);

	const totalsByDay = new Map<string, Map<string, number>>();
	for (const row of rows) {
		let totals = totalsByDay.get(row.day);
		if (totals === undefined) {
			totals = new Map();
			totalsByDay.set(row.day, totals);
		}
		totals.set(row.goalId, row.total);
	}
	return summarizeHistory(goals, schedule, totalsByDay, today, days);
}
