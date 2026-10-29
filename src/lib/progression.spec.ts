import { describe, expect, it } from 'vitest';
import type { ExerciseSession } from '#lib/server/workouts.js';
import { compareHealthMetrics } from './health-correlation';
import {
	buildRepMaxLedger,
	formatPaceMinPerKm,
	matchScaleWeight,
	summarizeExerciseProgression
} from './progression';

function session(
	day: string,
	maxWeight: number,
	reps: number,
	overrides: Partial<ExerciseSession> = {}
): ExerciseSession {
	const startTime = Date.parse(`${day}T18:00:00Z`);
	const e1rm = maxWeight > 0 ? maxWeight * (1 + reps / 30) : 0;
	return {
		workoutId: day,
		startTime,
		sets: 3,
		workingSets: 3,
		hardSets: 1,
		maxWeight,
		e1rm,
		volume: maxWeight * reps * 3,
		maxReps: reps,
		totalReps: reps * 3,
		distanceKm: 0,
		durationSeconds: 0,
		repMaxes: maxWeight > 0 ? [{ reps, weight: maxWeight }] : [],
		...overrides
	};
}

describe('progression analytics', () => {
	it('builds best-at-reps ledger and flags PR sessions after the baseline session', () => {
		const sessions = [
			session('2026-10-01', 80, 8),
			session('2026-10-08', 90, 5),
			session('2026-10-15', 100, 3)
		];
		const weights = [{ day: '2026-10-14', weightKg: 80 }];
		const summary = summarizeExerciseProgression(sessions, weights);

		expect(summary.heaviest?.maxWeight).toBe(100);
		expect(summary.prCount).toBe(2);
		expect(summary.annotated[0].isWeightPr).toBe(false);
		expect(summary.annotated[1].isWeightPr).toBe(true);
		expect(summary.annotated[2].isWeightPr).toBe(true);
		expect(summary.bestRelativeE1rm?.ratio).toBeCloseTo((100 * (1 + 3 / 30)) / 80);

		const ledger = buildRepMaxLedger(sessions);
		expect(ledger.find((r) => r.reps === 1)?.weight).toBe(100);
		expect(ledger.find((r) => r.reps === 3)).toMatchObject({ weight: 100, exact: true });
		expect(ledger.find((r) => r.reps === 5)).toMatchObject({ weight: 90, exact: true });
		expect(ledger.find((r) => r.reps === 8)).toMatchObject({ weight: 80, exact: true });
	});

	it('matches scale weights within window and formats pace', () => {
		expect(
			matchScaleWeight(Date.parse('2026-10-15T12:00:00Z'), [{ day: '2026-10-10', weightKg: 78.4 }])
		).toBe(78.4);
		expect(formatPaceMinPerKm(5.25)).toBe('5:15 /km');
	});
});

describe('compareHealthMetrics', () => {
	it('computes positive correlation and median split difference across paired dates', () => {
		const metric = { aggregation: 'average' as const, primaryUnit: 'ms' };
		const left = [1, 2, 3, 4, 5, 6].map((i) => ({
			localDate: `2026-10-0${i}`,
			count: 1,
			average: i * 10,
			min: i * 10,
			max: i * 10,
			sum: i * 10,
			durationSeconds: null,
			latestValue: i * 10,
			latestTimestamp: null
		}));
		const right = [1, 2, 3, 4, 5, 6].map((i) => ({
			localDate: `2026-10-0${i}`,
			count: 1,
			average: 50 + i * 5,
			min: 50 + i * 5,
			max: 50 + i * 5,
			sum: 50 + i * 5,
			durationSeconds: null,
			latestValue: 50 + i * 5,
			latestTimestamp: null
		}));

		const result = compareHealthMetrics(metric, left, metric, right, 0);
		expect(result.pairedDays).toBe(6);
		expect(result.correlation).toBeCloseTo(1);
		expect(result.highVsLowDiff).toBeGreaterThan(0);
	});
});
