/**
 * Figures for the overview page. Every function takes the dashboard's nights and training days and
 * works on local dates (`YYYY-MM-DD`), so results don't depend on the browser's time zone.
 */
import type { SleepNight } from '#lib/server/sleep.js';
import type { TrainingDay, WorkoutSummary } from '#lib/server/workouts.js';
import { dayFromNumber, dayNumber, monthStart, weekStart } from '#lib/days.js';
import { compareMeans, mean, relativeChange } from '#lib/stats.js';

/** Periods the overview can show, in days; 'all' covers every record. */
export const PERIODS = [7, 30, 90, 365, 'all'] as const;
export type Period = (typeof PERIODS)[number];

/** Shorter sleeps are naps or incomplete nights and stay out of the statistics. */
const MIN_NIGHT_SECONDS = 3 * 3600;
/** Training and rest nights are only compared once each has this many nights. */
const MIN_COMPARED_NIGHTS = 10;
/** Notes compared with the nights without them, most frequent first. */
const MAX_NOTES = 10;
/** Above this many weeks the chart shows months. */
const MAX_WEEKS = 104;
/** Days in the rolling average drawn through each kind of chart point. */
export const TREND_DAYS = { day: 7, week: 28, month: 90 } as const;

/** A local day with the main sleep that began on its evening and its training. */
export interface DayRecord {
	day: string;
	night?: SleepNight;
	training?: TrainingDay;
}

/** Nights long enough to count as the main sleep. */
export function mainNights(nights: readonly SleepNight[]): SleepNight[] {
	return nights.filter((night) => night.timeAsleepSeconds >= MIN_NIGHT_SECONDS);
}

/** Every day with a main sleep or training, keeping the longest sleep when a day has two. */
export function recordsByDay(
	nights: readonly SleepNight[],
	trainingDays: readonly TrainingDay[]
): Map<string, DayRecord> {
	const records = new Map<string, DayRecord>();
	const record = (day: string) => {
		let found = records.get(day);
		if (found === undefined) {
			found = { day };
			records.set(day, found);
		}
		return found;
	};
	for (const night of mainNights(nights)) {
		const found = record(night.night);
		if (!found.night || night.timeAsleepSeconds > found.night.timeAsleepSeconds) {
			found.night = night;
		}
	}
	for (const training of trainingDays) record(training.day).training = training;
	return records;
}

/** The first and last day of `period` ending on `today`; 'all' starts at the oldest record. */
export function periodDays(
	records: ReadonlyMap<string, DayRecord>,
	today: string,
	period: Period
): { from: string; to: string } {
	if (period !== 'all') return { from: dayFromNumber(dayNumber(today) - period + 1), to: today };
	let from = today;
	for (const day of records.keys()) if (day < from) from = day;
	return { from, to: today };
}

export interface PeriodSummary {
	from: string;
	to: string;
	/** Whether the records reach back over the whole previous period, so changes mean something. */
	comparable: boolean;
	nights: SleepNight[];
	/** Mean sleep quality (0–100), and its change in points. */
	quality: number | null;
	qualityChange: number | null;
	/** Mean seconds asleep, and its relative change (0.05 = 5 % more). */
	asleep: number | null;
	asleepChange: number | null;
	/** Mean seconds in bed. */
	inBed: number | null;
	/** Mean share of time in bed spent asleep (0–100), and its change in points. */
	efficiency: number | null;
	efficiencyChange: number | null;
	/** Workouts, and their relative change. */
	workouts: number;
	workoutsChange: number | null;
	trainingDays: number;
	/** Kilograms lifted, and their relative change. */
	volume: number;
	volumeChange: number | null;
}

/** The figures of `period`, each compared with the period of the same length before it. */
export function summarizePeriod(
	records: ReadonlyMap<string, DayRecord>,
	today: string,
	period: Period
): PeriodSummary {
	const { from, to } = periodDays(records, today, period);
	const current = totals(records, from, to);
	const oldest = periodDays(records, today, 'all').from;
	const previousFrom = period === 'all' ? null : dayFromNumber(dayNumber(from) - period);
	const comparable = previousFrom !== null && oldest <= previousFrom;
	const previous =
		comparable && previousFrom !== null
			? totals(records, previousFrom, dayFromNumber(dayNumber(from) - 1))
			: null;
	const difference = (now: number | null, before: number | null | undefined) =>
		now === null || before === null || before === undefined ? null : now - before;
	return {
		from,
		to,
		comparable,
		nights: current.nights,
		quality: current.quality,
		qualityChange: difference(current.quality, previous?.quality),
		asleep: current.asleep,
		asleepChange: previous ? relativeChange(current.asleep, previous.asleep) : null,
		inBed: current.inBed,
		efficiency: current.efficiency,
		efficiencyChange: difference(current.efficiency, previous?.efficiency),
		workouts: current.workouts,
		workoutsChange: previous ? relativeChange(current.workouts, previous.workouts) : null,
		trainingDays: current.trainingDays,
		volume: current.volume,
		volumeChange: previous ? relativeChange(current.volume, previous.volume) : null
	};
}

function totals(records: ReadonlyMap<string, DayRecord>, from: string, to: string) {
	const nights: SleepNight[] = [];
	let workouts = 0;
	let trainingDays = 0;
	let volume = 0;
	for (let n = dayNumber(from); n <= dayNumber(to); n++) {
		const record = records.get(dayFromNumber(n));
		if (record?.night) nights.push(record.night);
		if (record?.training) {
			workouts += record.training.workouts;
			trainingDays += 1;
			volume += record.training.volume;
		}
	}
	return {
		nights,
		quality: mean(nights.map((night) => night.sleepQuality)),
		asleep: mean(nights.map((night) => night.timeAsleepSeconds)),
		inBed: mean(nights.map((night) => night.timeInBedSeconds)),
		efficiency: efficiency(nights),
		workouts,
		trainingDays,
		volume
	};
}

function efficiency(nights: readonly SleepNight[]): number | null {
	return mean(
		nights
			.filter((night) => night.timeInBedSeconds > 0)
			.map((night) => (night.timeAsleepSeconds / night.timeInBedSeconds) * 100)
	);
}

/** One point of the sleep and training chart: a day, a week or a month. */
export interface ChartPoint {
	/** First and last day covered. */
	from: string;
	to: string;
	/** Mean sleep quality of its nights, and the rolling mean ending on its last day. */
	quality: number | null;
	trend: number | null;
	/** Mean seconds asleep and in bed. */
	asleep: number | null;
	inBed: number | null;
	workouts: number;
	volume: number;
}

export type Granularity = keyof typeof TREND_DAYS;

/** Days for up to 90 days, weeks for up to two years, months beyond. */
export function chartGranularity(from: string, to: string): Granularity {
	const days = dayNumber(to) - dayNumber(from) + 1;
	if (days <= 90) return 'day';
	return days <= MAX_WEEKS * 7 ? 'week' : 'month';
}

/** The chart's points from `from` to `to`, oldest first, including ones without records. */
export function chartPoints(
	records: ReadonlyMap<string, DayRecord>,
	from: string,
	to: string,
	granularity: Granularity
): ChartPoint[] {
	const groupOf = { day: (day: string) => day, week: weekStart, month: monthStart }[granularity];
	const points: ChartPoint[] = [];
	let days: string[] = [];
	const flush = () => {
		if (days.length === 0) return;
		const last = days[days.length - 1];
		const nights = days.flatMap((day) => records.get(day)?.night ?? []);
		const training = days.flatMap((day) => records.get(day)?.training ?? []);
		points.push({
			from: days[0],
			to: last,
			quality: mean(nights.map((night) => night.sleepQuality)),
			trend: rollingQuality(records, last, TREND_DAYS[granularity]),
			asleep: mean(nights.map((night) => night.timeAsleepSeconds)),
			inBed: mean(nights.map((night) => night.timeInBedSeconds)),
			workouts: training.reduce((sum, day) => sum + day.workouts, 0),
			volume: training.reduce((sum, day) => sum + day.volume, 0)
		});
		days = [];
	};
	for (let n = dayNumber(from); n <= dayNumber(to); n++) {
		const day = dayFromNumber(n);
		if (days.length > 0 && groupOf(day) !== groupOf(days[0])) flush();
		days.push(day);
	}
	flush();
	return points;
}

/** Mean quality of the nights in the `window` days ending on `day`, or null without any. */
export function rollingQuality(
	records: ReadonlyMap<string, DayRecord>,
	day: string,
	window: number
): number | null {
	const end = dayNumber(day);
	const qualities: number[] = [];
	for (let n = end - window + 1; n <= end; n++) {
		const night = records.get(dayFromNumber(n))?.night;
		if (night) qualities.push(night.sleepQuality);
	}
	return mean(qualities);
}

/** Training on the day a night began, or a Sleep Cycle note, against nights without it. */
export interface SleepFactor {
	/** The note, or null for training. */
	note: string | null;
	nights: number;
	/** Mean quality of the nights with the factor. */
	average: number;
	/** Points above (or below) the nights without it; null with too few nights to compare. */
	difference: number | null;
	/** Whether the difference is larger than ordinary night-to-night variation. */
	clear: boolean;
}

/** Training and the most frequent notes, largest difference first. */
export function sleepFactors(
	nights: readonly SleepNight[],
	records: ReadonlyMap<string, DayRecord>
): SleepFactor[] {
	const training: number[] = [];
	const rest: number[] = [];
	const byNote = new Map<string, number[]>();
	for (const night of nights) {
		(records.get(night.night)?.training ? training : rest).push(night.sleepQuality);
		for (const note of night.notes) {
			const list = byNote.get(note);
			if (list) list.push(night.sleepQuality);
			else byNote.set(note, [night.sleepQuality]);
		}
	}
	const trainingComparison = compareMeans(training, rest, MIN_COMPARED_NIGHTS);
	const factors: SleepFactor[] = [
		{
			note: null,
			nights: training.length,
			average: mean(training) ?? 0,
			difference: trainingComparison?.difference ?? null,
			clear: trainingComparison?.clear ?? false
		}
	];
	const notes = [...byNote.entries()]
		.filter(([, qualities]) => qualities.length >= 2)
		.sort((a, b) => b[1].length - a[1].length)
		.slice(0, MAX_NOTES);
	for (const [note, withNote] of notes) {
		const without = nights
			.filter((night) => !night.notes.includes(note))
			.map((night) => night.sleepQuality);
		const comparison = compareMeans(withNote, without);
		factors.push({
			note,
			nights: withNote.length,
			average: mean(withNote) ?? 0,
			difference: comparison?.difference ?? null,
			clear: comparison?.clear ?? false
		});
	}
	return factors.sort((a, b) => Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0));
}

/** Each workout with the quality of the night that began on its day in `timeZone`. */
export function workoutNights(
	workouts: readonly WorkoutSummary[],
	records: ReadonlyMap<string, DayRecord>,
	timeZone: string
): { workout: WorkoutSummary; quality: number | null }[] {
	// en-CA formats dates as YYYY-MM-DD.
	const format = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	return workouts.map((workout) => ({
		workout,
		quality: records.get(format.format(workout.startTime))?.night?.sleepQuality ?? null
	}));
}

/** How a sleep quality score reads: 80 and up is good, under 65 poor. */
export function qualityBand(quality: number): 'good' | 'fair' | 'poor' {
	if (quality >= 80) return 'good';
	return quality >= 65 ? 'fair' : 'poor';
}
