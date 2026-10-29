/**
 * Pairs Sleep Cycle nights with Google Health sleep sessions to compare how each source measures
 * the same nights — without summing overlapping records.
 */
import type { GoogleSleepNight, SleepNight } from '#lib/server/sleep.js';
import { mean } from '#lib/stats.js';

/** Shorter sleeps are naps or incomplete nights and stay out of nightly source comparisons. */
const MIN_MAIN_SLEEP_SECONDS = 3 * 3600;
const DAY_MINUTES = 24 * 60;
const ROLLOVER_HOUR = 18;

export type SleepSourceMetric = 'asleep' | 'inBed' | 'efficiency' | 'timing';

export interface PairedSleepNight {
	night: string;
	sleepCycle: SleepNight | null;
	googleHealth: GoogleSleepNight | null;
	/** Minutes asleep reported by Sleep Cycle vs Google Health. */
	sleepCycleAsleepMin: number | null;
	googleAsleepMin: number | null;
	/** Minutes in bed reported by Sleep Cycle vs Google Health. */
	sleepCycleInBedMin: number | null;
	googleInBedMin: number | null;
	/** Sleep efficiency (0–100) = asleep / inBed. */
	sleepCycleEfficiency: number | null;
	googleEfficiency: number | null;
	/** Bedtime and wake-up in continuous evening minutes (18:00 = 0, 00:00 = 360, 08:00 = 840). */
	sleepCycleBedMinute: number | null;
	sleepCycleWakeMinute: number | null;
	googleBedMinute: number | null;
	googleWakeMinute: number | null;
}

export interface SleepSourcesSummary {
	/** Every night inside the range that has at least one main sleep source, oldest first. */
	points: PairedSleepNight[];
	/** Nights recorded by both Sleep Cycle and Google Health inside the range. */
	sharedNights: number;
	sleepCycleOnlyNights: number;
	googleOnlyNights: number;
	/** Mean minutes asleep across shared nights. */
	meanSleepCycleAsleepMin: number | null;
	meanGoogleAsleepMin: number | null;
	/** Mean Sleep Cycle minus Google Health minutes asleep across shared nights. */
	asleepDeltaMin: number | null;
	/** Mean absolute difference in minutes asleep across shared nights. */
	asleepMeanAbsDiffMin: number | null;
	/** Mean Sleep Cycle minus Google Health minutes in bed across shared nights. */
	inBedDeltaMin: number | null;
	/** Mean Sleep Cycle minus Google Health efficiency points across shared nights. */
	efficiencyDeltaPts: number | null;
	/** Mean Sleep Cycle minus Google Health bedtime offset in minutes (+ = Sleep Cycle later). */
	bedtimeOffsetMin: number | null;
	/** Mean Sleep Cycle minus Google Health wake-up offset in minutes (+ = Sleep Cycle later). */
	wakeOffsetMin: number | null;
	/** Mean Google Health stage breakdown across Google nights with stage data (in minutes). */
	googleStages: {
		nights: number;
		deepMin: number;
		lightMin: number;
		remMin: number;
		awakeMin: number;
	} | null;
}

/**
 * Clock minute relative to 18:00 local time (18:00 -> 0, 23:30 -> 330, 00:30 -> 390, 07:30 -> 810)
 * so bedtimes before and after midnight sit on one continuous scale without wrapping at 00:00.
 */
export function eveningOffsetMinutes(epochMs: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).formatToParts(epochMs);
	const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
	const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
	const total = hour * 60 + minute;
	return total >= ROLLOVER_HOUR * 60
		? total - ROLLOVER_HOUR * 60
		: total + (24 - ROLLOVER_HOUR) * 60;
}

/** Formats an `eveningOffsetMinutes` value back as `HH:MM` (24-hour clock). */
export function formatEveningMinute(offsetMinutes: number): string {
	const wrapped =
		(((Math.round(offsetMinutes) + ROLLOVER_HOUR * 60) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
	const hours = Math.floor(wrapped / 60);
	const minutes = wrapped % 60;
	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function overlapSeconds(startA: number, endA: number, startB: number, endB: number): number {
	return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB)) / 1000;
}

/**
 * Pairs main Sleep Cycle nights and main Google Health sleep sessions within `[from, to]`.
 * Sessions first match by physical time overlap (>= 60 min) so midnight boundary differences never
 * split the same night into two rows, and fall back to the shared 5 AM `night` key.
 */
export function compareSleepSources(
	sleepCycleNights: readonly SleepNight[],
	googleNights: readonly GoogleSleepNight[],
	timeZone: string,
	from?: string,
	to?: string
): SleepSourcesSummary {
	const inRange = (night: string) =>
		(from === undefined || night >= from) && (to === undefined || night <= to);

	// Keep the longest main sleep per night for each source independently.
	const scByNight = new Map<string, SleepNight>();
	for (const night of sleepCycleNights) {
		if (night.timeAsleepSeconds < MIN_MAIN_SLEEP_SECONDS || !inRange(night.night)) continue;
		const existing = scByNight.get(night.night);
		if (!existing || night.timeAsleepSeconds > existing.timeAsleepSeconds) {
			scByNight.set(night.night, night);
		}
	}

	const ghMain = googleNights.filter(
		(g) =>
			Math.max(g.timeAsleepSeconds, g.timeInBedSeconds) >= MIN_MAIN_SLEEP_SECONDS &&
			inRange(g.night)
	);
	const ghByNight = new Map<string, GoogleSleepNight>();
	for (const g of ghMain) {
		const existing = ghByNight.get(g.night);
		if (!existing || g.timeAsleepSeconds > existing.timeAsleepSeconds) {
			ghByNight.set(g.night, g);
		}
	}

	const matchedGhNights = new Set<string>();
	const pairs: { night: string; sc: SleepNight | null; gh: GoogleSleepNight | null }[] = [];

	for (const [nightKey, sc] of scByNight) {
		const scStart = sc.wentToBed ?? sc.wokeUp - sc.timeInBedSeconds * 1000;
		const scEnd = sc.wokeUp;

		// Prefer direct overlap >= 60 minutes across any unmatched Google main night; otherwise exact nightKey.
		let bestGh: GoogleSleepNight | null = null;
		let bestGhKey: string | null = null;
		let bestOverlap = 0;

		for (const [ghKey, gh] of ghByNight) {
			if (matchedGhNights.has(ghKey)) continue;
			const ov = overlapSeconds(scStart, scEnd, gh.startTime, gh.endTime);
			if (ov >= 3600 && ov > bestOverlap) {
				bestOverlap = ov;
				bestGh = gh;
				bestGhKey = ghKey;
			}
		}

		if (!bestGh && ghByNight.has(nightKey) && !matchedGhNights.has(nightKey)) {
			bestGh = ghByNight.get(nightKey) ?? null;
			bestGhKey = nightKey;
		}

		if (bestGhKey !== null) matchedGhNights.add(bestGhKey);
		pairs.push({ night: nightKey, sc, gh: bestGh });
	}

	for (const [ghKey, gh] of ghByNight) {
		if (!matchedGhNights.has(ghKey)) {
			pairs.push({ night: ghKey, sc: null, gh });
		}
	}

	pairs.sort((a, b) => (a.night < b.night ? -1 : a.night > b.night ? 1 : 0));

	const points: PairedSleepNight[] = pairs.map(({ night, sc, gh }) => {
		const scStart = sc ? (sc.wentToBed ?? sc.wokeUp - sc.timeInBedSeconds * 1000) : null;
		const scAsleepMin = sc ? sc.timeAsleepSeconds / 60 : null;
		const ghAsleepMin = gh ? gh.timeAsleepSeconds / 60 : null;
		const scInBedMin = sc ? sc.timeInBedSeconds / 60 : null;
		const ghInBedMin = gh ? gh.timeInBedSeconds / 60 : null;
		const scEff =
			sc && sc.timeInBedSeconds > 0 ? (sc.timeAsleepSeconds / sc.timeInBedSeconds) * 100 : null;
		const ghEff =
			gh && gh.timeInBedSeconds > 0 ? (gh.timeAsleepSeconds / gh.timeInBedSeconds) * 100 : null;

		const scBed = scStart !== null ? eveningOffsetMinutes(scStart, timeZone) : null;
		let scWake = sc ? eveningOffsetMinutes(sc.wokeUp, timeZone) : null;
		if (scBed !== null && scWake !== null && scWake < scBed) scWake += DAY_MINUTES;

		const ghBed = gh ? eveningOffsetMinutes(gh.startTime, timeZone) : null;
		let ghWake = gh ? eveningOffsetMinutes(gh.endTime, timeZone) : null;
		if (ghBed !== null && ghWake !== null && ghWake < ghBed) ghWake += DAY_MINUTES;

		return {
			night,
			sleepCycle: sc,
			googleHealth: gh,
			sleepCycleAsleepMin: scAsleepMin,
			googleAsleepMin: ghAsleepMin,
			sleepCycleInBedMin: scInBedMin,
			googleInBedMin: ghInBedMin,
			sleepCycleEfficiency: scEff,
			googleEfficiency: ghEff,
			sleepCycleBedMinute: scBed,
			sleepCycleWakeMinute: scWake,
			googleBedMinute: ghBed,
			googleWakeMinute: ghWake
		};
	});

	const shared = points.filter((p) => p.sleepCycle !== null && p.googleHealth !== null);
	const sleepCycleOnlyNights = points.filter(
		(p) => p.sleepCycle !== null && p.googleHealth === null
	).length;
	const googleOnlyNights = points.filter(
		(p) => p.sleepCycle === null && p.googleHealth !== null
	).length;

	const scAsleepShared = shared.map((p) => p.sleepCycleAsleepMin!);
	const ghAsleepShared = shared.map((p) => p.googleAsleepMin!);
	const asleepDeltas = shared.map((p) => p.sleepCycleAsleepMin! - p.googleAsleepMin!);
	const inBedDeltas = shared.map((p) => p.sleepCycleInBedMin! - p.googleInBedMin!);
	const effDeltas = shared
		.filter((p) => p.sleepCycleEfficiency !== null && p.googleEfficiency !== null)
		.map((p) => p.sleepCycleEfficiency! - p.googleEfficiency!);
	const bedOffsets = shared.map((p) => {
		const scStart =
			p.sleepCycle!.wentToBed ?? p.sleepCycle!.wokeUp - p.sleepCycle!.timeInBedSeconds * 1000;
		return (scStart - p.googleHealth!.startTime) / 60_000;
	});
	const wakeOffsets = shared.map((p) => (p.sleepCycle!.wokeUp - p.googleHealth!.endTime) / 60_000);

	const withStages = points
		.map((p) => p.googleHealth)
		.filter(
			(gh): gh is GoogleSleepNight =>
				gh !== null &&
				(gh.deepSeconds !== undefined ||
					gh.lightSeconds !== undefined ||
					gh.remSeconds !== undefined)
		);

	const googleStages =
		withStages.length === 0
			? null
			: {
					nights: withStages.length,
					deepMin: (mean(withStages.map((g) => g.deepSeconds ?? 0)) ?? 0) / 60,
					lightMin: (mean(withStages.map((g) => g.lightSeconds ?? 0)) ?? 0) / 60,
					remMin: (mean(withStages.map((g) => g.remSeconds ?? 0)) ?? 0) / 60,
					awakeMin: (mean(withStages.map((g) => g.awakeSeconds ?? 0)) ?? 0) / 60
				};

	return {
		points,
		sharedNights: shared.length,
		sleepCycleOnlyNights,
		googleOnlyNights,
		meanSleepCycleAsleepMin: mean(scAsleepShared),
		meanGoogleAsleepMin: mean(ghAsleepShared),
		asleepDeltaMin: mean(asleepDeltas),
		asleepMeanAbsDiffMin: mean(asleepDeltas.map((d) => Math.abs(d))),
		inBedDeltaMin: mean(inBedDeltas),
		efficiencyDeltaPts: mean(effDeltas),
		bedtimeOffsetMin: mean(bedOffsets),
		wakeOffsetMin: mean(wakeOffsets),
		googleStages
	};
}
