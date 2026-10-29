import type { ExerciseMode, ExerciseSession } from '#lib/server/workouts.js';

export const REP_MAX_TARGETS = [1, 3, 5, 8, 10, 12] as const;

export interface RepMaxEntry {
	reps: (typeof REP_MAX_TARGETS)[number];
	weight: number;
	startTime: number;
	exact: boolean;
}

export interface AnnotatedSession {
	session: ExerciseSession;
	isWeightPr: boolean;
	isE1rmPr: boolean;
	isVolumePr: boolean;
	isRepsPr: boolean;
	bodyweightKg: number | null;
	relativeE1rm: number | null;
}

export interface ExerciseProgressionSummary {
	sessions: number;
	last?: ExerciseSession;
	heaviest?: ExerciseSession;
	bestE1rm?: ExerciseSession;
	biggestVolume?: ExerciseSession;
	mostReps?: ExerciseSession;
	longestDistance?: ExerciseSession;
	fastestPaceMinPerKm?: { value: number; session: ExerciseSession };
	longestDuration?: ExerciseSession;
	bestRelativeE1rm?: { ratio: number; session: ExerciseSession; bodyweightKg: number };
	prCount: number;
	repMaxes: RepMaxEntry[];
	annotated: AnnotatedSession[];
}

function sessionDateKey(startTime: number): string {
	return new Date(startTime).toISOString().slice(0, 10);
}

/**
 * Picks the closest scale weight recorded on or up to 30 days before `startTime` (or within 7 days
 * after when the first weigh-in came slightly later).
 */
export function matchScaleWeight(
	startTime: number,
	scaleWeights: readonly { day: string; weightKg: number }[]
): number | null {
	if (scaleWeights.length === 0) return null;
	const day = sessionDateKey(startTime);
	let best: { weightKg: number; distanceDays: number } | null = null;
	const sessionMs = Date.parse(`${day}T00:00:00Z`);
	for (const entry of scaleWeights) {
		const entryMs = Date.parse(`${entry.day}T00:00:00Z`);
		const diffDays = (sessionMs - entryMs) / 86_400_000;
		if (diffDays < -7 || diffDays > 45) continue;
		const distanceDays = Math.abs(diffDays);
		if (best === null || distanceDays < best.distanceDays) {
			best = { weightKg: entry.weightKg, distanceDays };
		}
	}
	return best?.weightKg ?? null;
}

/**
 * Builds the Best-at-Reps table for `1, 3, 5, 8, 10, 12` reps. A set of `>= N` reps also proves
 * the lifter lifted that weight for `N` reps (`exact: false` when only a higher-rep set exists at a
 * heavier weight).
 */
export function buildRepMaxLedger(sessions: readonly ExerciseSession[]): RepMaxEntry[] {
	return REP_MAX_TARGETS.flatMap((target) => {
		let best: RepMaxEntry | null = null;
		for (const session of sessions) {
			for (const entry of session.repMaxes) {
				if (entry.reps < target || entry.weight <= 0) continue;
				const exact = entry.reps === target;
				if (
					best === null ||
					entry.weight > best.weight ||
					(entry.weight === best.weight && exact && !best.exact)
				) {
					best = { reps: target, weight: entry.weight, startTime: session.startTime, exact };
				}
			}
		}
		return best === null ? [] : [best];
	});
}

export function summarizeExerciseProgression(
	sessions: readonly ExerciseSession[],
	scaleWeights: readonly { day: string; weightKg: number }[] = []
): ExerciseProgressionSummary {
	let heaviest: ExerciseSession | undefined;
	let bestE1rm: ExerciseSession | undefined;
	let biggestVolume: ExerciseSession | undefined;
	let mostReps: ExerciseSession | undefined;
	let longestDistance: ExerciseSession | undefined;
	let fastestPaceMinPerKm: { value: number; session: ExerciseSession } | undefined;
	let longestDuration: ExerciseSession | undefined;
	let bestRelativeE1rm:
		{ ratio: number; session: ExerciseSession; bodyweightKg: number } | undefined;

	let runningWeight = 0;
	let runningE1rm = 0;
	let runningVolume = 0;
	let runningReps = 0;
	let prCount = 0;

	const annotated: AnnotatedSession[] = sessions.map((session, index) => {
		const isFirst = index === 0;
		const isWeightPr = session.maxWeight > runningWeight && session.maxWeight > 0 && !isFirst;
		const isE1rmPr = session.e1rm > runningE1rm && session.e1rm > 0 && !isFirst;
		const isVolumePr = session.volume > runningVolume && session.volume > 0 && !isFirst;
		const isRepsPr = session.maxReps > runningReps && session.maxReps > 0 && !isFirst;

		if (session.maxWeight > runningWeight) {
			runningWeight = session.maxWeight;
			heaviest = session;
		}
		if (session.e1rm > runningE1rm) {
			runningE1rm = session.e1rm;
			bestE1rm = session;
		}
		if (session.volume > runningVolume) {
			runningVolume = session.volume;
			biggestVolume = session;
		}
		if (session.maxReps > runningReps) {
			runningReps = session.maxReps;
			mostReps = session;
		}
		if (session.distanceKm > (longestDistance?.distanceKm ?? 0)) {
			longestDistance = session;
		}
		if (session.distanceKm >= 0.2 && session.durationSeconds > 0) {
			const pace = session.durationSeconds / 60 / session.distanceKm;
			if (fastestPaceMinPerKm === undefined || pace < fastestPaceMinPerKm.value) {
				fastestPaceMinPerKm = { value: pace, session };
			}
		}
		if (session.durationSeconds > (longestDuration?.durationSeconds ?? 0)) {
			longestDuration = session;
		}

		const bodyweightKg = matchScaleWeight(session.startTime, scaleWeights);
		const relativeE1rm =
			bodyweightKg !== null && bodyweightKg > 0 && session.e1rm > 0
				? session.e1rm / bodyweightKg
				: null;
		if (
			relativeE1rm !== null &&
			bodyweightKg !== null &&
			(bestRelativeE1rm === undefined || relativeE1rm > bestRelativeE1rm.ratio)
		) {
			bestRelativeE1rm = { ratio: relativeE1rm, session, bodyweightKg };
		}

		if (isWeightPr || isE1rmPr || isVolumePr || isRepsPr) prCount += 1;

		return {
			session,
			isWeightPr,
			isE1rmPr,
			isVolumePr,
			isRepsPr,
			bodyweightKg,
			relativeE1rm
		};
	});

	return {
		sessions: sessions.length,
		last: sessions.at(-1),
		heaviest,
		bestE1rm,
		biggestVolume,
		mostReps,
		longestDistance,
		fastestPaceMinPerKm,
		longestDuration,
		bestRelativeE1rm,
		prCount,
		repMaxes: buildRepMaxLedger(sessions),
		annotated
	};
}

export function formatPaceMinPerKm(paceMin: number): string {
	const totalSec = Math.round(paceMin * 60);
	const mins = Math.floor(totalSec / 60);
	const secs = totalSec % 60;
	return `${mins}:${String(secs).padStart(2, '0')} /km`;
}

export function primarySeriesForMode(
	annotated: readonly AnnotatedSession[],
	mode: ExerciseMode,
	weightedMetric: 'e1rm' | 'weight'
): { date: Date; value: number; pr: boolean }[] {
	if (mode === 'weighted') {
		return annotated.flatMap((item) => {
			const value = weightedMetric === 'e1rm' ? item.session.e1rm : item.session.maxWeight;
			if (value <= 0) return [];
			return [
				{
					date: new Date(item.session.startTime),
					value: Number(value.toFixed(1)),
					pr: weightedMetric === 'e1rm' ? item.isE1rmPr : item.isWeightPr
				}
			];
		});
	}
	if (mode === 'bodyweight') {
		return annotated.flatMap((item) =>
			item.session.maxReps > 0
				? [
						{
							date: new Date(item.session.startTime),
							value: item.session.maxReps,
							pr: item.isRepsPr
						}
					]
				: []
		);
	}
	if (mode === 'cardio') {
		return annotated.flatMap((item) => {
			if (item.session.distanceKm > 0 && item.session.durationSeconds > 0) {
				const pace = item.session.durationSeconds / 60 / item.session.distanceKm;
				return [
					{ date: new Date(item.session.startTime), value: Number(pace.toFixed(2)), pr: false }
				];
			}
			return item.session.distanceKm > 0
				? [
						{
							date: new Date(item.session.startTime),
							value: Number(item.session.distanceKm.toFixed(2)),
							pr: false
						}
					]
				: [];
		});
	}
	return annotated.flatMap((item) =>
		item.session.durationSeconds > 0
			? [
					{
						date: new Date(item.session.startTime),
						value: Number((item.session.durationSeconds / 60).toFixed(1)),
						pr: false
					}
				]
			: []
	);
}
