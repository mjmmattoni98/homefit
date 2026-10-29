import { and, asc, eq, inArray } from 'drizzle-orm';
import { dayFromNumber, dayNumber } from '#lib/days.js';
import type { Database } from './db/types';
import { healthDailySummary } from './db/schema';
import { listGoogleSleepNights, listNights, type GoogleSleepNight, type SleepNight } from './sleep';
import { listTrainingDays, listWorkouts, type TrainingDay, type WorkoutSummary } from './workouts';

const RECENT_WORKOUTS = 6;
const VITALS_TYPES = [
	'daily-heart-rate-variability',
	'heart-rate-variability',
	'daily-resting-heart-rate',
	'weight',
	'body-fat'
] as const;

export interface DailyVitalsPoint {
	day: string;
	hrvMs?: number;
	rhrBpm?: number;
	weightKg?: number;
	bodyFatPct?: number;
}

export interface Dashboard {
	/** Time zone every date below is in. */
	timeZone: string;
	/** Today's date there, `YYYY-MM-DD`. */
	today: string;
	nights: SleepNight[];
	googleSleepNights: GoogleSleepNight[];
	vitalsDays: DailyVitalsPoint[];
	trainingDays: TrainingDay[];
	recentWorkouts: WorkoutSummary[];
}

export async function listDailyVitals(db: Database, userId: string): Promise<DailyVitalsPoint[]> {
	const rows = await db
		.select({
			dataType: healthDailySummary.dataType,
			localDate: healthDailySummary.localDate,
			average: healthDailySummary.average,
			latestValue: healthDailySummary.latestValue
		})
		.from(healthDailySummary)
		.where(
			and(
				eq(healthDailySummary.userId, userId),
				inArray(healthDailySummary.dataType, [...VITALS_TYPES])
			)
		)
		.orderBy(asc(healthDailySummary.localDate));

	const byDay = new Map<string, DailyVitalsPoint>();
	const point = (day: string) => {
		let found = byDay.get(day);
		if (found === undefined) {
			found = { day };
			byDay.set(day, found);
		}
		return found;
	};

	for (const row of rows) {
		const value =
			row.dataType === 'weight' || row.dataType === 'body-fat'
				? (row.latestValue ?? row.average)
				: (row.average ?? row.latestValue);
		if (value === null || !Number.isFinite(value)) continue;
		const entry = point(row.localDate);
		if (row.dataType === 'daily-heart-rate-variability') {
			entry.hrvMs = value;
		} else if (row.dataType === 'heart-rate-variability' && entry.hrvMs === undefined) {
			entry.hrvMs = value;
		} else if (row.dataType === 'daily-resting-heart-rate') {
			entry.rhrBpm = value;
		} else if (row.dataType === 'weight') {
			entry.weightKg = value;
		} else if (row.dataType === 'body-fat') {
			entry.bodyFatPct = value;
		}
	}

	return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export async function listScaleWeights(
	db: Database,
	userId: string
): Promise<{ day: string; weightKg: number }[]> {
	const rows = await db
		.select({
			localDate: healthDailySummary.localDate,
			latestValue: healthDailySummary.latestValue,
			average: healthDailySummary.average
		})
		.from(healthDailySummary)
		.where(and(eq(healthDailySummary.userId, userId), eq(healthDailySummary.dataType, 'weight')))
		.orderBy(asc(healthDailySummary.localDate));

	return rows.flatMap((row) => {
		const weightKg = row.latestValue ?? row.average;
		return weightKg !== null && weightKg > 0 ? [{ day: row.localDate, weightKg }] : [];
	});
}

/**
 * Sleep Cycle nights and Google sleep sessions whose evening falls in the last `days` local dates
 * through today. Enough for the health pages' comparison, without the rest of the dashboard.
 */
export async function loadSleepWindow(
	db: Database,
	userId: string,
	timeZone: string,
	days: number,
	now = new Date()
): Promise<Pick<Dashboard, 'timeZone' | 'today' | 'nights' | 'googleSleepNights'>> {
	if (!Number.isSafeInteger(days) || days < 1 || days > 366) {
		throw new Error('Invalid sleep window');
	}
	const today = localDate(timeZone, now);
	const range = { from: dayFromNumber(dayNumber(today) - days + 1), to: today };
	const [nights, googleSleepNights] = await Promise.all([
		listNights(db, userId, timeZone, range),
		listGoogleSleepNights(db, userId, timeZone, range)
	]);
	return { timeZone, today, nights, googleSleepNights };
}

/** Everything the overview page charts, with days split at midnight in `timeZone`. */
export async function loadDashboard(
	db: Database,
	userId: string,
	timeZone: string,
	now = new Date()
): Promise<Dashboard> {
	const [nights, googleSleepNights, vitalsDays, trainingDays, recentWorkouts] = await Promise.all([
		listNights(db, userId, timeZone),
		listGoogleSleepNights(db, userId, timeZone),
		listDailyVitals(db, userId),
		listTrainingDays(db, userId, timeZone),
		listWorkouts(db, userId, RECENT_WORKOUTS)
	]);
	return {
		timeZone,
		today: localDate(timeZone, now),
		nights,
		googleSleepNights,
		vitalsDays,
		trainingDays,
		recentWorkouts
	};
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
