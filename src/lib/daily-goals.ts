import { dayFromNumber, dayNumber } from '#lib/days.js';

/**
 * Rules for daily home goals: which goals and targets apply on a day, whether the day counts,
 * and streaks. Pure functions over `YYYY-MM-DD` dates, shared by the server and the UI.
 */

export const GOAL_UNITS = ['minutes', 'reps', 'seconds'] as const;
export type GoalUnit = (typeof GOAL_UNITS)[number];

/** Amounts offered as one-tap buttons for each unit. */
export const QUICK_AMOUNTS: Record<GoalUnit, readonly number[]> = {
	minutes: [5, 10, 15],
	reps: [5, 10, 20],
	seconds: [15, 30, 60]
};

/** Largest target or single entry, in the goal's unit. */
export const MAX_AMOUNT = 10_000;
/** Days in the history strip: twelve weeks ending today. */
export const HISTORY_DAYS = 84;
/** Monday to Friday; bit 0 is Monday. */
export const WORKWEEK_MASK = 0b0011111;

export interface NewGoal {
	name: string;
	unit: GoalUnit;
	target: number;
}

export type DayStatus = 'done' | 'missed' | 'in-progress' | 'rest';

export interface TargetVersion {
	/** First day this target applies. */
	effectiveFrom: string;
	target: number;
}

export interface GoalRules {
	id: string;
	/** The goal stops counting from this day onward. */
	archivedOn: string | null;
	targets: readonly TargetVersion[];
}

export interface ScheduleVersion {
	effectiveFrom: string;
	/** Bit 0 = Monday … bit 6 = Sunday. */
	weekdays: number;
}

/** Total logged per goal ID on one day; missing goals count as zero. */
export type DayTotals = ReadonlyMap<string, number>;

export interface GoalCheck<G> {
	goal: G;
	target: number;
	total: number;
	met: boolean;
}

export interface DayResult<G> {
	day: string;
	scheduled: boolean;
	status: DayStatus;
	/** At least one goal applied and every one was met, scheduled or not. */
	allMet: boolean;
	goals: GoalCheck<G>[];
}

export interface HistoryDay {
	day: string;
	status: DayStatus;
	allMet: boolean;
}

export interface GoalHistory {
	/** Oldest first, ending today. */
	days: HistoryDay[];
	currentStreak: number;
	bestStreak: number;
}

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(day: string): number {
	// 1970-01-01 was a Thursday, the fourth day of a Monday-based week.
	return (((dayNumber(day) + 3) % 7) + 7) % 7;
}

function latestOnOrBefore<T extends { effectiveFrom: string }>(
	versions: readonly T[],
	day: string
): T | undefined {
	let found: T | undefined;
	for (const version of versions) {
		if (
			version.effectiveFrom <= day &&
			(found === undefined || version.effectiveFrom > found.effectiveFrom)
		) {
			found = version;
		}
	}
	return found;
}

/** The goal's target on `day`, or null when the goal does not apply that day. */
export function targetOn(goal: GoalRules, day: string): number | null {
	if (goal.archivedOn !== null && goal.archivedOn <= day) return null;
	return latestOnOrBefore(goal.targets, day)?.target ?? null;
}

/** The weekday mask in effect on `day`, or null before the first schedule. */
export function scheduleOn(schedule: readonly ScheduleVersion[], day: string): number | null {
	return latestOnOrBefore(schedule, day)?.weekdays ?? null;
}

export function isScheduled(schedule: readonly ScheduleVersion[], day: string): boolean {
	const weekdays = scheduleOn(schedule, day);
	return weekdays !== null && (weekdays & (1 << weekdayIndex(day))) !== 0;
}

export function evaluateDay<G extends GoalRules>(
	goals: readonly G[],
	schedule: readonly ScheduleVersion[],
	totals: DayTotals | undefined,
	day: string,
	today: string
): DayResult<G> {
	const checks: GoalCheck<G>[] = [];
	for (const goal of goals) {
		const target = targetOn(goal, day);
		if (target === null) continue;
		const total = totals?.get(goal.id) ?? 0;
		checks.push({ goal, target, total, met: total >= target });
	}
	const scheduled = isScheduled(schedule, day);
	const allMet = checks.length > 0 && checks.every((check) => check.met);
	let status: DayStatus;
	if (!scheduled) status = 'rest';
	else if (allMet) status = 'done';
	else if (day === today) status = 'in-progress';
	else status = 'missed';
	return { day, scheduled, status, allMet, goals: checks };
}

/** The first day any goal had a target, or null without goals. */
export function firstGoalDay(goals: readonly GoalRules[]): string | null {
	let first: string | null = null;
	for (const goal of goals) {
		for (const version of goal.targets) {
			if (first === null || version.effectiveFrom < first) first = version.effectiveFrom;
		}
	}
	return first;
}

/**
 * Day statuses for the `days` days ending `today`, and the streaks: runs of done days in which
 * rest days and an unfinished today are skipped and a missed day starts over.
 */
export function summarizeHistory(
	goals: readonly GoalRules[],
	schedule: readonly ScheduleVersion[],
	totalsByDay: ReadonlyMap<string, DayTotals>,
	today: string,
	days: number
): GoalHistory {
	const todayNumber = dayNumber(today);
	const evaluate = (n: number) => {
		const day = dayFromNumber(n);
		return evaluateDay(goals, schedule, totalsByDay.get(day), day, today);
	};

	const window: HistoryDay[] = [];
	for (let n = todayNumber - days + 1; n <= todayNumber; n++) {
		const { day, status, allMet } = evaluate(n);
		window.push({ day, status, allMet });
	}

	const first = firstGoalDay(goals);
	let run = 0;
	let best = 0;
	if (first !== null) {
		for (let n = dayNumber(first); n <= todayNumber; n++) {
			const { status } = evaluate(n);
			if (status === 'done') {
				run += 1;
				best = Math.max(best, run);
			} else if (status === 'missed') {
				run = 0;
			}
		}
	}
	// Rest days and an unfinished today never end a run, so the run still open is the current one.
	return { days: window, currentStreak: run, bestStreak: best };
}
