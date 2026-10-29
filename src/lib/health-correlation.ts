import { dayFromNumber, dayNumber } from './days';
import { summaryNumber, type HealthMetric, type HealthSummary } from './google-health/view';
import { compareMeans, mean, pearsonCorrelation } from './stats';

export interface MetricPairPoint {
	date: string;
	left: number | null;
	right: number | null;
	/** Normalized 0..1 position of `left` within its observed range. */
	leftNorm: number | null;
	/** Normalized 0..1 position of `right` within its observed range. */
	rightNorm: number | null;
}

export interface MetricComparison {
	pairedDays: number;
	correlation: number | null;
	leftMean: number | null;
	rightMean: number | null;
	/** Mean of `right` when `left` is above vs below its median (`highLeftMean - lowLeftMean`). */
	highVsLowDiff: number | null;
	highVsLowClear: boolean;
	points: MetricPairPoint[];
}

function displayValue(
	metric: Pick<HealthMetric, 'aggregation' | 'primaryUnit'>,
	summary: HealthSummary
): number | null {
	const raw = summaryNumber(metric, summary);
	if (raw === null) return null;
	return metric.aggregation === 'duration' ? raw / 3600 : raw;
}

function normalizeValue(value: number | null, min: number, max: number): number | null {
	if (value === null) return null;
	if (max <= min) return 0.5;
	return (value - min) / (max - min);
}

/**
 * Aligns two Google Health daily summary series by date (`lagDays = 0` same day, `lagDays = 1`
 * pairs day `d` of `left` with day `d + 1` of `right`), computes Pearson `r`, median-split
 * difference on `right`, and normalized `[0, 1]` coordinates so two differently scaled metrics can
 * share one chart cleanly.
 */
export function compareHealthMetrics(
	leftMetric: Pick<HealthMetric, 'aggregation' | 'primaryUnit'>,
	leftSummaries: readonly HealthSummary[],
	rightMetric: Pick<HealthMetric, 'aggregation' | 'primaryUnit'>,
	rightSummaries: readonly HealthSummary[],
	lagDays: 0 | 1 = 0
): MetricComparison {
	const leftByDate = new Map<string, number>();
	for (const summary of leftSummaries) {
		const value = displayValue(leftMetric, summary);
		if (value !== null) leftByDate.set(summary.localDate, value);
	}
	const rightByDate = new Map<string, number>();
	for (const summary of rightSummaries) {
		const value = displayValue(rightMetric, summary);
		if (value !== null) rightByDate.set(summary.localDate, value);
	}

	const allDates = [...new Set([...leftByDate.keys(), ...rightByDate.keys()])].sort();
	const leftValues = [...leftByDate.values()];
	const rightValues = [...rightByDate.values()];
	const leftMin = leftValues.length > 0 ? Math.min(...leftValues) : 0;
	const leftMax = leftValues.length > 0 ? Math.max(...leftValues) : 1;
	const rightMin = rightValues.length > 0 ? Math.min(...rightValues) : 0;
	const rightMax = rightValues.length > 0 ? Math.max(...rightValues) : 1;

	const pairs: { x: number; y: number }[] = [];
	for (const [date, x] of leftByDate) {
		const targetDate = lagDays === 0 ? date : dayFromNumber(dayNumber(date) + lagDays);
		const y = rightByDate.get(targetDate);
		if (y !== undefined) pairs.push({ x, y });
	}

	let highVsLowDiff: number | null = null;
	let highVsLowClear = false;
	if (pairs.length >= 6) {
		const sortedX = pairs.map((p) => p.x).sort((a, b) => a - b);
		const medianX = sortedX[Math.floor(sortedX.length / 2)];
		const high = pairs.filter((p) => p.x >= medianX).map((p) => p.y);
		const low = pairs.filter((p) => p.x < medianX).map((p) => p.y);
		const cmp = compareMeans(high, low, 2);
		if (cmp !== null) {
			highVsLowDiff = cmp.difference;
			highVsLowClear = cmp.clear;
		}
	}

	const points: MetricPairPoint[] = allDates.map((date) => {
		const left = leftByDate.get(date) ?? null;
		const rightDate = lagDays === 0 ? date : dayFromNumber(dayNumber(date) + lagDays);
		const right = rightByDate.get(rightDate) ?? null;
		return {
			date,
			left,
			right,
			leftNorm: normalizeValue(left, leftMin, leftMax),
			rightNorm: normalizeValue(right, rightMin, rightMax)
		};
	});

	return {
		pairedDays: pairs.length,
		correlation: pearsonCorrelation(pairs, 5),
		leftMean: mean(leftValues),
		rightMean: mean(rightValues),
		highVsLowDiff,
		highVsLowClear,
		points
	};
}
