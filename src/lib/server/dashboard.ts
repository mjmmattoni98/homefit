import type { Database } from './db/types';
import { listNights, type SleepNight } from './sleep';
import { listTrainingDays, listWorkouts, type TrainingDay, type WorkoutSummary } from './workouts';

const RECENT_WORKOUTS = 6;

export interface Dashboard {
	/** Time zone every date below is in. */
	timeZone: string;
	/** Today's date there, `YYYY-MM-DD`. */
	today: string;
	nights: SleepNight[];
	trainingDays: TrainingDay[];
	recentWorkouts: WorkoutSummary[];
}

/** Everything the overview page charts, with days split at midnight in `timeZone`. */
export async function loadDashboard(
	db: Database,
	userId: string,
	timeZone: string,
	now = new Date()
): Promise<Dashboard> {
	const [nights, trainingDays, recentWorkouts] = await Promise.all([
		listNights(db, userId, timeZone),
		listTrainingDays(db, userId, timeZone),
		listWorkouts(db, userId, RECENT_WORKOUTS)
	]);
	return { timeZone, today: localDate(timeZone, now), nights, trainingDays, recentWorkouts };
}

/** The canonical IANA time zone named by `value`, or UTC when it is missing or unknown. */
export function resolveTimeZone(value: string | undefined): string {
	if (value === undefined || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(value)) return 'UTC';
	try {
		return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
	} catch {
		return 'UTC';
	}
}

/** The calendar date in `timeZone` at `now`, `YYYY-MM-DD`. */
export function localDate(timeZone: string, now: Date): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(now);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((item) => item.type === type)?.value;
	return `${part('year')}-${part('month')}-${part('day')}`;
}
