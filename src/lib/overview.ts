/**
 * Figures for the overview page. Every function takes the dashboard's nights and training days and
 * works on local dates (`YYYY-MM-DD`), so results don't depend on the browser's time zone.
 */
import type { DailyVitalsPoint } from '#lib/server/dashboard.js';
import type { SleepNight } from '#lib/server/sleep.js';
import type { TrainingDay, WorkoutSummary } from '#lib/server/workouts.js';
import { dayFromNumber, dayNumber, monthStart, weekStart } from '#lib/days.js';
import { eveningOffsetMinutes, formatEveningMinute } from '#lib/sleep-sources.js';
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

export const FACTOR_TARGETS = ['quality', 'latency', 'snore', 'movements'] as const;
export type SleepFactorTarget = (typeof FACTOR_TARGETS)[number];

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
	/** Mean Sleep Cycle regularity (0–100), when recorded. */
	regularity: number | null;
	/** Mean fall-asleep latency in minutes. */
	latencyMin: number | null;
	/** Workouts, and their relative change. */
	workouts: number;
	workoutsChange: number | null;
	trainingDays: number;
	/** Kilograms lifted, and their relative change. */
	volume: number;
	volumeChange: number | null;
	/** Acute:Chronic Workload Ratio (7-day rolling load vs 28-day weekly average), or null without baseline. */
	acwr: number | null;
}

/**
 * Acute:Chronic Workload Ratio ending on `to`: the last 7 days' working volume divided by the
 * average weekly working volume over the last 28 days. Returns null if chronic volume is zero or
 * history has fewer than 14 days.
 */
export function workloadRatio(records: ReadonlyMap<string, DayRecord>, to: string): number | null {
	let oldest = to;
	for (const day of records.keys()) if (day < oldest) oldest = day;
	const end = dayNumber(to);
	if (end - dayNumber(oldest) + 1 < 14) return null;

	let acute = 0;
	let chronic = 0;
	for (let n = end - 27; n <= end; n++) {
		const vol = records.get(dayFromNumber(n))?.training?.volume ?? 0;
		chronic += vol;
		if (n >= end - 6) acute += vol;
	}
	const chronicWeekly = chronic / 4;
	if (chronicWeekly <= 0) return null;
	return acute / chronicWeekly;
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
		regularity: current.regularity,
		latencyMin: current.latencyMin,
		workouts: current.workouts,
		workoutsChange: previous ? relativeChange(current.workouts, previous.workouts) : null,
		trainingDays: current.trainingDays,
		volume: current.volume,
		volumeChange: previous ? relativeChange(current.volume, previous.volume) : null,
		acwr: workloadRatio(records, to)
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
	const regularities = nights
		.map((n) => n.regularity)
		.filter((v): v is number => v !== undefined && Number.isFinite(v));
	const latencies = nights
		.map((n) => n.asleepAfterSeconds)
		.filter((v): v is number => v !== undefined && Number.isFinite(v));
	return {
		nights,
		quality: mean(nights.map((night) => night.sleepQuality)),
		asleep: mean(nights.map((night) => night.timeAsleepSeconds)),
		inBed: mean(nights.map((night) => night.timeInBedSeconds)),
		efficiency: efficiency(nights),
		regularity: mean(regularities),
		latencyMin: latencies.length === 0 ? null : (mean(latencies) ?? 0) / 60,
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

/** Training on the day a night began, a training load band, travel, or a Sleep Cycle note. */
export interface SleepFactor {
	/** The note, or null for training, or a built-in factor kind. */
	note: string | null;
	kind?: 'training' | 'heavy_training' | 'late_workout' | 'away_city' | 'note';
	nights: number;
	/** Mean target value of the nights with the factor. */
	average: number;
	/** Difference above (or below) the nights without it; null with too few nights to compare. */
	difference: number | null;
	/** Signed towards better sleep (+ = better, - = worse) regardless of whether lower is better. */
	improvement: number | null;
	/** Whether the difference is larger than ordinary night-to-night variation. */
	clear: boolean;
}

function targetValue(night: SleepNight, target: SleepFactorTarget): number | null {
	switch (target) {
		case 'quality':
			return night.sleepQuality;
		case 'latency':
			return night.asleepAfterSeconds !== undefined ? night.asleepAfterSeconds / 60 : null;
		case 'snore':
			return night.snoreTimeSeconds !== undefined ? night.snoreTimeSeconds / 60 : null;
		case 'movements':
			return night.movementsPerHour !== undefined ? night.movementsPerHour : null;
	}
}

/**
 * Training, load/timing/travel factors, and the most frequent notes against the chosen target
 * (`quality`, `latency`, `snore`, or `movements`), largest absolute difference first.
 * Preserves the exact default signature `sleepFactors(nights, records)` for quality.
 */
export function sleepFactors(
	nights: readonly SleepNight[],
	records: ReadonlyMap<string, DayRecord>,
	target: SleepFactorTarget = 'quality'
): SleepFactor[] {
	const lowerIsBetter = target !== 'quality';
	const sign = (diff: number | null) => (diff === null ? null : lowerIsBetter ? -diff : diff);

	const measured = nights.flatMap((night) => {
		const val = targetValue(night, target);
		return val !== null && Number.isFinite(val) ? [{ night, val }] : [];
	});

	const training: number[] = [];
	const rest: number[] = [];
	const byNote = new Map<string, number[]>();

	for (const { night, val } of measured) {
		(records.get(night.night)?.training ? training : rest).push(val);
		for (const note of night.notes) {
			const list = byNote.get(note);
			if (list) list.push(val);
			else byNote.set(note, [val]);
		}
	}

	const trainingComparison = compareMeans(training, rest, MIN_COMPARED_NIGHTS);
	const factors: SleepFactor[] = [
		{
			note: null,
			kind: 'training',
			nights: training.length,
			average: mean(training) ?? 0,
			difference: trainingComparison?.difference ?? null,
			improvement: sign(trainingComparison?.difference ?? null),
			clear: trainingComparison?.clear ?? false
		}
	];

	// Heavy training dose (upper third of training-day volumes) vs lighter/rest nights, when enough exist.
	const trainingVolumes = measured
		.map(({ night }) => records.get(night.night)?.training?.volume ?? 0)
		.filter((v) => v > 0)
		.sort((a, b) => a - b);
	if (trainingVolumes.length >= 9) {
		const heavyCutoff = trainingVolumes[Math.floor((trainingVolumes.length * 2) / 3)];
		if (heavyCutoff > trainingVolumes[0]) {
			const heavyVals: number[] = [];
			const otherVals: number[] = [];
			for (const { night, val } of measured) {
				const vol = records.get(night.night)?.training?.volume ?? 0;
				(vol >= heavyCutoff ? heavyVals : otherVals).push(val);
			}
			const cmp = compareMeans(heavyVals, otherVals, 3);
			if (cmp !== null) {
				factors.push({
					note: '__heavy_training__',
					kind: 'heavy_training',
					nights: heavyVals.length,
					average: mean(heavyVals) ?? 0,
					difference: cmp.difference,
					improvement: sign(cmp.difference),
					clear: cmp.clear
				});
			}
		}
	}

	// Late workout (< 4 hours before bedtime) vs other nights, when timestamps exist.
	const lateVals: number[] = [];
	const nonLateVals: number[] = [];
	for (const { night, val } of measured) {
		const end = records.get(night.night)?.training?.latestEndTime;
		const bed = night.wentToBed;
		if (end !== undefined && bed !== undefined && bed > end && bed - end <= 4 * 3600_000) {
			lateVals.push(val);
		} else {
			nonLateVals.push(val);
		}
	}
	if (lateVals.length >= 3 && nonLateVals.length >= 3) {
		const cmp = compareMeans(lateVals, nonLateVals, 3);
		if (cmp !== null) {
			factors.push({
				note: '__late_workout__',
				kind: 'late_workout',
				nights: lateVals.length,
				average: mean(lateVals) ?? 0,
				difference: cmp.difference,
				improvement: sign(cmp.difference),
				clear: cmp.clear
			});
		}
	}

	// Away from home city vs home city, when city is recorded on Sleep Cycle exports.
	const cityCounts = new Map<string, number>();
	for (const { night } of measured) {
		if (night.city) cityCounts.set(night.city, (cityCounts.get(night.city) ?? 0) + 1);
	}
	if (cityCounts.size >= 2) {
		let homeCity = '';
		let homeMax = 0;
		for (const [city, count] of cityCounts) {
			if (count > homeMax) {
				homeCity = city;
				homeMax = count;
			}
		}
		const awayVals: number[] = [];
		const homeVals: number[] = [];
		for (const { night, val } of measured) {
			if (!night.city) continue;
			(night.city === homeCity ? homeVals : awayVals).push(val);
		}
		if (awayVals.length >= 3 && homeVals.length >= 3) {
			const cmp = compareMeans(awayVals, homeVals, 3);
			if (cmp !== null) {
				factors.push({
					note: '__away_city__',
					kind: 'away_city',
					nights: awayVals.length,
					average: mean(awayVals) ?? 0,
					difference: cmp.difference,
					improvement: sign(cmp.difference),
					clear: cmp.clear
				});
			}
		}
	}

	const notes = [...byNote.entries()]
		.filter(([, values]) => values.length >= 2)
		.sort((a, b) => b[1].length - a[1].length)
		.slice(0, MAX_NOTES);
	for (const [note, withNote] of notes) {
		const without = measured
			.filter(({ night }) => !night.notes.includes(note))
			.map(({ val }) => val);
		const comparison = compareMeans(withNote, without);
		factors.push({
			note,
			kind: 'note',
			nights: withNote.length,
			average: mean(withNote) ?? 0,
			difference: comparison?.difference ?? null,
			improvement: sign(comparison?.difference ?? null),
			clear: comparison?.clear ?? false
		});
	}
	return factors.sort((a, b) => Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0));
}

export interface CircadianNightPoint {
	night: string;
	bedMinute: number;
	asleepMinute: number;
	wakeMinute: number;
	midpointMinute: number;
	weekend: boolean;
}

export interface CircadianSummary {
	points: CircadianNightPoint[];
	meanBedtime: string | null;
	meanWakeTime: string | null;
	meanRegularity: number | null;
	meanLatencyMin: number | null;
	/** Weekend sleep midpoint minus weekday sleep midpoint, in minutes (+ = later on weekends). */
	socialJetlagMin: number | null;
}

/**
 * Circadian sleep tunnel and social jetlag over `nights` in `timeZone`.
 * Friday (`5`) and Saturday (`6`) evenings are weekend nights (waking Saturday/Sunday morning).
 */
export function summarizeCircadian(
	nights: readonly SleepNight[],
	timeZone: string
): CircadianSummary {
	const points: CircadianNightPoint[] = [];
	for (const night of nights) {
		const startMs = night.wentToBed ?? night.wokeUp - night.timeInBedSeconds * 1000;
		const bedMinute = eveningOffsetMinutes(startMs, timeZone);
		let wakeMinute = eveningOffsetMinutes(night.wokeUp, timeZone);
		if (wakeMinute < bedMinute) wakeMinute += 24 * 60;
		const latencyMin = Math.min(
			Math.max(0, (night.asleepAfterSeconds ?? 0) / 60),
			Math.max(0, wakeMinute - bedMinute)
		);
		const asleepMinute = bedMinute + latencyMin;
		const midpointMinute = (asleepMinute + wakeMinute) / 2;
		// 1970-01-01 was Thursday (4). (n + 4) % 7 -> 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat.
		const dow = (((dayNumber(night.night) + 4) % 7) + 7) % 7;
		const weekend = dow === 5 || dow === 6;
		points.push({
			night: night.night,
			bedMinute,
			asleepMinute,
			wakeMinute,
			midpointMinute,
			weekend
		});
	}

	const bedMean = mean(points.map((p) => p.bedMinute));
	const wakeMean = mean(points.map((p) => p.wakeMinute));
	const regularities = nights
		.map((n) => n.regularity)
		.filter((v): v is number => v !== undefined && Number.isFinite(v));
	const latencies = nights
		.map((n) => n.asleepAfterSeconds)
		.filter((v): v is number => v !== undefined && Number.isFinite(v));

	const weekdayMid = points.filter((p) => !p.weekend).map((p) => p.midpointMinute);
	const weekendMid = points.filter((p) => p.weekend).map((p) => p.midpointMinute);
	const socialJetlagMin =
		weekdayMid.length >= 2 && weekendMid.length >= 2
			? (mean(weekendMid) ?? 0) - (mean(weekdayMid) ?? 0)
			: null;

	return {
		points,
		meanBedtime: bedMean === null ? null : formatEveningMinute(bedMean),
		meanWakeTime: wakeMean === null ? null : formatEveningMinute(wakeMean),
		meanRegularity: mean(regularities),
		meanLatencyMin: latencies.length === 0 ? null : (mean(latencies) ?? 0) / 60,
		socialJetlagMin
	};
}

export interface SleepReadinessSummary {
	restedDays: number;
	tiredDays: number;
	restedMeanVolume: number | null;
	tiredMeanVolume: number | null;
	/** Relative volume change on rested days vs under-slept days (`0.12` = +12%). */
	volumeLift: number | null;
	volumeClear: boolean;
	restedMeanRpe: number | null;
	tiredMeanRpe: number | null;
}

/**
 * Bidirectional sleep -> training readiness: pairs every training day with the *preceding* night's
 * sleep (`dayNumber(training.day) - 1`). Compares sessions after well-rested nights (quality >= 75
 * and >= 6.5h asleep) against sessions after poor or short sleep.
 */
export function sleepReadiness(
	records: ReadonlyMap<string, DayRecord>
): SleepReadinessSummary | null {
	const restedVol: number[] = [];
	const tiredVol: number[] = [];
	const restedRpe: number[] = [];
	const tiredRpe: number[] = [];

	for (const [day, record] of records) {
		const training = record.training;
		if (!training || training.volume <= 0) continue;
		const prevNight = records.get(dayFromNumber(dayNumber(day) - 1))?.night;
		if (!prevNight) continue;
		const rested = prevNight.sleepQuality >= 75 && prevNight.timeAsleepSeconds >= 6.5 * 3600;
		if (rested) {
			restedVol.push(training.volume);
			if (training.meanRpe !== undefined) restedRpe.push(training.meanRpe);
		} else {
			tiredVol.push(training.volume);
			if (training.meanRpe !== undefined) tiredRpe.push(training.meanRpe);
		}
	}

	if (restedVol.length + tiredVol.length < 3) return null;
	const restedMean = mean(restedVol);
	const tiredMean = mean(tiredVol);
	const cmp = compareMeans(restedVol, tiredVol, 2);
	return {
		restedDays: restedVol.length,
		tiredDays: tiredVol.length,
		restedMeanVolume: restedMean,
		tiredMeanVolume: tiredMean,
		volumeLift: relativeChange(restedMean, tiredMean),
		volumeClear: cmp?.clear ?? false,
		restedMeanRpe: mean(restedRpe),
		tiredMeanRpe: mean(tiredRpe)
	};
}

export interface WorkoutTimingBucket {
	band: 'early' | 'evening' | 'late';
	nights: number;
	meanQuality: number | null;
	meanLatencyMin: number | null;
	meanMovements: number | null;
}

/**
 * Groups training days that also have a Sleep Cycle night with `wentToBed` by how many hours
 * elapsed between the day's last workout ending and bedtime: `> 6h` (early), `3–6h` (evening),
 * or `< 3h` (late).
 */
export function workoutTimingImpact(
	records: ReadonlyMap<string, DayRecord>
): WorkoutTimingBucket[] {
	const groups: Record<'early' | 'evening' | 'late', SleepNight[]> = {
		early: [],
		evening: [],
		late: []
	};

	for (const record of records.values()) {
		const end = record.training?.latestEndTime;
		const night = record.night;
		if (end === undefined || !night || night.wentToBed === undefined) continue;
		const gapHours = (night.wentToBed - end) / 3_600_000;
		if (gapHours < 0 || gapHours > 20) continue;
		if (gapHours >= 6) groups.early.push(night);
		else if (gapHours >= 3) groups.evening.push(night);
		else groups.late.push(night);
	}

	const total = groups.early.length + groups.evening.length + groups.late.length;
	if (total < 3) return [];

	return (['early', 'evening', 'late'] as const).map((band) => {
		const list = groups[band];
		const latencies = list
			.map((n) => n.asleepAfterSeconds)
			.filter((v): v is number => v !== undefined && Number.isFinite(v));
		const movements = list
			.map((n) => n.movementsPerHour)
			.filter((v): v is number => v !== undefined && Number.isFinite(v));
		return {
			band,
			nights: list.length,
			meanQuality: mean(list.map((n) => n.sleepQuality)),
			meanLatencyMin: latencies.length === 0 ? null : (mean(latencies) ?? 0) / 60,
			meanMovements: mean(movements)
		};
	});
}

export interface VitalsReadinessSummary {
	latestHrvMs: number | null;
	baselineHrvMs: number | null;
	hrvDeltaMs: number | null;
	latestRhrBpm: number | null;
	baselineRhrBpm: number | null;
	rhrDeltaBpm: number | null;
	latestWeightKg: number | null;
	weightChangeKg: number | null;
	latestBodyFatPct: number | null;
	hrvSpark: (number | null)[];
	rhrSpark: (number | null)[];
	weightSpark: (number | null)[];
}

/** Summarizes Google Health autonomic readiness (HRV, RHR) and body composition over `[from, to]`. */
export function summarizeVitals(
	vitalsDays: readonly DailyVitalsPoint[],
	from: string,
	to: string
): VitalsReadinessSummary | null {
	if (vitalsDays.length === 0) return null;
	const inWindow = vitalsDays.filter((d) => d.day >= from && d.day <= to);
	const source = inWindow.length > 0 ? inWindow : vitalsDays.slice(-30);

	const hrvs = source.flatMap((d) => (d.hrvMs !== undefined ? [d.hrvMs] : []));
	const rhrs = source.flatMap((d) => (d.rhrBpm !== undefined ? [d.rhrBpm] : []));
	const weights = source.flatMap((d) => (d.weightKg !== undefined ? [d.weightKg] : []));
	const fats = source.flatMap((d) => (d.bodyFatPct !== undefined ? [d.bodyFatPct] : []));

	if (hrvs.length === 0 && rhrs.length === 0 && weights.length === 0 && fats.length === 0) {
		return null;
	}

	const latestHrvMs = hrvs.at(-1) ?? null;
	const baselineHrvMs = hrvs.length >= 3 ? mean(hrvs) : null;
	const latestRhrBpm = rhrs.at(-1) ?? null;
	const baselineRhrBpm = rhrs.length >= 3 ? mean(rhrs) : null;
	const latestWeightKg = weights.at(-1) ?? null;
	const weightChangeKg = weights.length >= 2 ? weights.at(-1)! - weights[0] : null;

	return {
		latestHrvMs,
		baselineHrvMs,
		hrvDeltaMs: latestHrvMs !== null && baselineHrvMs !== null ? latestHrvMs - baselineHrvMs : null,
		latestRhrBpm,
		baselineRhrBpm,
		rhrDeltaBpm:
			latestRhrBpm !== null && baselineRhrBpm !== null ? latestRhrBpm - baselineRhrBpm : null,
		latestWeightKg,
		weightChangeKg,
		latestBodyFatPct: fats.at(-1) ?? null,
		hrvSpark: source.map((d) => d.hrvMs ?? null),
		rhrSpark: source.map((d) => d.rhrBpm ?? null),
		weightSpark: source.map((d) => d.weightKg ?? null)
	};
}

export interface WorkoutNightRow {
	workout: WorkoutSummary;
	/** Sleep quality of the night BEFORE the workout (morning readiness). */
	priorQuality: number | null;
	/** Sleep quality of the night AFTER the workout (same evening). */
	quality: number | null;
}

/** Each workout with the quality of the night before it and the night that began on its day. */
export function workoutNights(
	workouts: readonly WorkoutSummary[],
	records: ReadonlyMap<string, DayRecord>,
	timeZone: string
): WorkoutNightRow[] {
	// en-CA formats dates as YYYY-MM-DD.
	const format = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	return workouts.map((workout) => {
		const day = format.format(workout.startTime);
		const prevDay = dayFromNumber(dayNumber(day) - 1);
		return {
			workout,
			priorQuality: records.get(prevDay)?.night?.sleepQuality ?? null,
			quality: records.get(day)?.night?.sleepQuality ?? null
		};
	});
}

/** How a sleep quality score reads: 80 and up is good, under 65 poor. */
export function qualityBand(quality: number): 'good' | 'fair' | 'poor' {
	if (quality >= 80) return 'good';
	return quality >= 65 ? 'fair' : 'poor';
}
