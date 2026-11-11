import { describe, expect, it } from 'vitest';
import { compareHealthMetrics } from './health-correlation';
import type { HealthSummary } from './google-health/view';

function summary(localDate: string, value: number): HealthSummary {
	return {
		localDate,
		count: 1,
		latestValue: value,
		latestTimestamp: null,
		sum: value,
		average: value,
		min: value,
		max: value,
		durationSeconds: value
	};
}

describe('compareHealthMetrics', () => {
	it('aligns two daily series on the same day and computes Pearson r and split difference', () => {
		const steps = [
			summary('2026-04-01', 4000),
			summary('2026-04-02', 6000),
			summary('2026-04-03', 8000),
			summary('2026-04-04', 10000),
			summary('2026-04-05', 12000),
			summary('2026-04-06', 14000)
		];
		const hrv = [
			summary('2026-04-01', 42),
			summary('2026-04-02', 46),
			summary('2026-04-03', 50),
			summary('2026-04-04', 54),
			summary('2026-04-05', 58),
			summary('2026-04-06', 62)
		];

		const res = compareHealthMetrics(
			{ aggregation: 'sum', primaryUnit: 'steps' },
			steps,
			{ aggregation: 'average', primaryUnit: 'ms' },
			hrv,
			0
		);

		expect(res.pairedDays).toBe(6);
		expect(res.correlation).toBeNull();
		expect(res.highVsLowDiff).toBeNull();
		expect(res.points[0].leftNorm).toBe(0);
		expect(res.points[5].rightNorm).toBe(1);
	});

	it('supports +1 day lag to test next-day effects', () => {
		const left = [
			summary('2026-04-01', 10),
			summary('2026-04-02', 20),
			summary('2026-04-03', 30),
			summary('2026-04-04', 40),
			summary('2026-04-05', 50)
		];
		const right = [
			summary('2026-04-02', 100),
			summary('2026-04-03', 80),
			summary('2026-04-04', 60),
			summary('2026-04-05', 40),
			summary('2026-04-06', 20)
		];

		const res = compareHealthMetrics(
			{ aggregation: 'sum', primaryUnit: 'kcal' },
			left,
			{ aggregation: 'average', primaryUnit: 'ms' },
			right,
			1
		);

		expect(res.pairedDays).toBe(5);
		expect(res.correlation).toBeNull();
	});
});

it('compares twenty paired days, requiring ten values per side', () => {
	const values = Array.from({ length: 20 }, (_, i) =>
		summary(`2026-04-${String(i + 1).padStart(2, '0')}`, i + 1)
	);
	const metric = { aggregation: 'average', primaryUnit: 'ms' } as const;
	const result = compareHealthMetrics(metric, values, metric, values);
	expect(result.correlation).toBeCloseTo(1, 12);
	expect(result.highVsLowDiff).toBe(10);
	expect(result.highVsLowClear).toBe(true);
	expect(compareHealthMetrics(metric, values.slice(1), metric, values).correlation).toBeNull();
	const tied = values.map((s) => ({ ...s, average: s.average === 20 ? 20 : 1 }));
	expect(compareHealthMetrics(metric, tied, metric, values).highVsLowDiff).toBeNull();
});
