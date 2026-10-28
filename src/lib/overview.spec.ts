import { describe, expect, it } from 'vitest';
import type { SleepNight } from '#lib/server/sleep.js';
import type { TrainingDay, WorkoutSummary } from '#lib/server/workouts.js';
import {
	chartGranularity,
	chartPoints,
	mainNights,
	periodDays,
	qualityBand,
	recordsByDay,
	rollingQuality,
	sleepFactors,
	summarizePeriod,
	workoutNights
} from './overview';

const HOUR = 3600;

function night(day: string, quality: number, asleepHours = 7, notes: string[] = []): SleepNight {
	return {
		night: day,
		wokeUp: Date.parse(`${day}T06:00:00Z`) + 86_400_000,
		sleepQuality: quality,
		timeAsleepSeconds: asleepHours * HOUR,
		timeInBedSeconds: (asleepHours + 1) * HOUR,
		notes
	};
}

function training(day: string, volume: number, workouts = 1): TrainingDay {
	return { day, workouts, volume };
}

describe('mainNights and recordsByDay', () => {
	it('leaves out naps and keeps the longest sleep of a day', () => {
		const nap = night('2026-10-01', 90, 1);
		const short = night('2026-10-02', 60, 5);
		const long = night('2026-10-02', 80, 8);
		expect(mainNights([nap, short])).toEqual([short]);

		const records = recordsByDay([nap, short, long], [training('2026-10-03', 100)]);
		expect([...records.keys()].sort()).toEqual(['2026-10-02', '2026-10-03']);
		expect(records.get('2026-10-02')?.night).toBe(long);
		expect(records.get('2026-10-03')?.training?.volume).toBe(100);
	});
});

describe('periodDays', () => {
	const records = recordsByDay([night('2026-09-15', 70)], [training('2026-09-10', 1)]);

	it('ends a fixed period today', () => {
		expect(periodDays(records, '2026-10-28', 7)).toEqual({ from: '2026-10-22', to: '2026-10-28' });
	});

	it('starts every record at the oldest one', () => {
		expect(periodDays(records, '2026-10-28', 'all')).toEqual({
			from: '2026-09-10',
			to: '2026-10-28'
		});
	});
});

describe('summarizePeriod', () => {
	// The last 7 days end on 2026-10-28; the 7 before them end on 2026-10-21.
	const nights = [
		night('2026-10-15', 60, 6),
		night('2026-10-20', 70, 6),
		night('2026-10-25', 80, 7),
		night('2026-10-27', 90, 8)
	];
	const days = [
		training('2026-10-16', 1000),
		training('2026-10-24', 1500, 2),
		training('2026-10-26', 1000)
	];
	const records = recordsByDay(nights, days);

	it('averages the period and compares it with the one before', () => {
		const summary = summarizePeriod(records, '2026-10-28', 7);
		expect(summary.comparable).toBe(true);
		expect(summary.nights).toHaveLength(2);
		expect(summary.quality).toBe(85);
		expect(summary.qualityChange).toBe(20);
		expect(summary.asleep).toBe(7.5 * HOUR);
		expect(summary.asleepChange).toBeCloseTo(0.25);
		expect(summary.inBed).toBe(8.5 * HOUR);
		expect(summary.efficiency).toBeCloseTo(((7 / 8 + 8 / 9) / 2) * 100);
		expect(summary.workouts).toBe(3);
		expect(summary.workoutsChange).toBe(2);
		expect(summary.trainingDays).toBe(2);
		expect(summary.volume).toBe(2500);
		expect(summary.volumeChange).toBe(1.5);
	});

	it('does not compare when the records start inside the previous period', () => {
		const summary = summarizePeriod(records, '2026-10-28', 30);
		expect(summary.comparable).toBe(false);
		expect(summary.quality).toBe(75);
		expect(summary.qualityChange).toBeNull();
		expect(summary.asleepChange).toBeNull();
		expect(summary.efficiencyChange).toBeNull();
		expect(summary.workoutsChange).toBeNull();
		expect(summary.volumeChange).toBeNull();
	});

	it('covers every record without a comparison for all', () => {
		const summary = summarizePeriod(records, '2026-10-28', 'all');
		expect(summary.from).toBe('2026-10-15');
		expect(summary.comparable).toBe(false);
		expect(summary.nights).toHaveLength(4);
		expect(summary.volume).toBe(3500);
	});

	it('reports no averages for a period without nights', () => {
		const summary = summarizePeriod(recordsByDay([], []), '2026-10-28', 30);
		expect(summary.quality).toBeNull();
		expect(summary.asleep).toBeNull();
		expect(summary.efficiency).toBeNull();
		expect(summary.workouts).toBe(0);
	});
});

describe('chartGranularity', () => {
	it('uses days up to 90 days, weeks up to two years and months beyond', () => {
		expect(chartGranularity('2026-07-31', '2026-10-28')).toBe('day');
		expect(chartGranularity('2026-07-30', '2026-10-28')).toBe('week');
		expect(chartGranularity('2024-11-01', '2026-10-28')).toBe('week');
		expect(chartGranularity('2024-10-01', '2026-10-28')).toBe('month');
	});
});

describe('chartPoints', () => {
	const records = recordsByDay(
		[night('2026-10-19', 60), night('2026-10-21', 80), night('2026-10-26', 90)],
		[training('2026-10-20', 500), training('2026-10-22', 700, 2)]
	);

	it('has a point for every day, with a rolling 7-day average', () => {
		const points = chartPoints(records, '2026-10-20', '2026-10-22', 'day');
		expect(points.map((point) => point.from)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
		expect(points[0]).toMatchObject({ quality: null, trend: 60, workouts: 1, volume: 500 });
		expect(points[1]).toMatchObject({ quality: 80, trend: 70, asleep: 7 * HOUR, volume: 0 });
		expect(points[2]).toMatchObject({ quality: null, trend: 70, workouts: 2 });
	});

	it('groups days into Monday-based weeks', () => {
		// 2026-10-19 and 2026-10-26 are Mondays.
		const points = chartPoints(records, '2026-10-18', '2026-10-27', 'week');
		expect(points.map((point) => [point.from, point.to])).toEqual([
			['2026-10-18', '2026-10-18'],
			['2026-10-19', '2026-10-25'],
			['2026-10-26', '2026-10-27']
		]);
		expect(points[1]).toMatchObject({ quality: 70, workouts: 3, volume: 1200 });
		expect(points[2]).toMatchObject({ quality: 90, trend: 230 / 3 });
	});

	it('groups days into calendar months', () => {
		const points = chartPoints(records, '2026-09-30', '2026-10-27', 'month');
		expect(points.map((point) => point.from)).toEqual(['2026-09-30', '2026-10-01']);
		expect(points[1].quality).toBeCloseTo(230 / 3);
	});
});

describe('rollingQuality', () => {
	it('averages the nights of the window ending on the day', () => {
		const records = recordsByDay([night('2026-10-01', 50), night('2026-10-07', 70)], []);
		expect(rollingQuality(records, '2026-10-07', 7)).toBe(60);
		expect(rollingQuality(records, '2026-10-08', 7)).toBe(70);
		expect(rollingQuality(records, '2026-10-20', 7)).toBeNull();
	});
});

describe('sleepFactors', () => {
	it('compares training and notes with the other nights, largest difference first', () => {
		const nights: SleepNight[] = [];
		const days: TrainingDay[] = [];
		for (let i = 1; i <= 24; i++) {
			const day = `2026-09-${String(i).padStart(2, '0')}`;
			const trained = i % 2 === 0;
			const alcohol = i % 6 === 0;
			if (trained) days.push(training(day, 1000));
			nights.push(
				night(
					day,
					(trained ? 80 : 74) + (i % 3) - (alcohol ? 20 : 0),
					7,
					alcohol ? ['Alcohol'] : i % 4 === 1 ? ['Coffee'] : []
				)
			);
		}
		const records = recordsByDay(nights, days);
		const factors = sleepFactors(nights, records);

		expect(factors.map((factor) => factor.note).sort()).toEqual(['Alcohol', 'Coffee', null]);
		const sizes = factors.map((factor) => Math.abs(factor.difference ?? 0));
		expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
		expect(factors[0]).toMatchObject({ note: 'Alcohol', nights: 4, clear: true });
		expect(factors[0].difference).toBeLessThan(-15);
		const trainingFactor = factors.find((factor) => factor.note === null);
		expect(trainingFactor?.nights).toBe(12);
		expect(trainingFactor?.difference).not.toBeNull();
	});

	it('leaves training uncompared with fewer than ten nights on either side', () => {
		const nights = [night('2026-10-01', 80), night('2026-10-02', 70)];
		const [trainingFactor] = sleepFactors(nights, recordsByDay(nights, []));
		expect(trainingFactor).toMatchObject({ note: null, nights: 0, difference: null, clear: false });
	});
});

describe('workoutNights', () => {
	it('matches each workout with the night that began on its local day', () => {
		const records = recordsByDay([night('2026-10-27', 88)], []);
		const workout = (startTime: number) =>
			({ id: String(startTime), startTime }) as unknown as WorkoutSummary;
		// 23:30 UTC on Oct 26 is already Oct 27 in Madrid, but still Oct 26 in New York.
		const late = workout(Date.parse('2026-10-26T23:30:00Z'));
		expect(workoutNights([late], records, 'Europe/Madrid')[0].quality).toBe(88);
		expect(workoutNights([late], records, 'America/New_York')[0].quality).toBeNull();
	});
});

describe('qualityBand', () => {
	it('splits scores at 65 and 80', () => {
		expect([90, 80, 79, 65, 64].map(qualityBand)).toEqual(['good', 'good', 'fair', 'fair', 'poor']);
	});
});
