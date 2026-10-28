import { formatNumber } from '#lib/format.js';

export const HEALTH_CATEGORIES = [
	'activity',
	'vitals',
	'sleep',
	'body',
	'nutrition',
	'other'
] as const;

export type HealthCategory = (typeof HEALTH_CATEGORIES)[number];
export type HealthAggregation = 'sum' | 'average' | 'latest' | 'duration' | null;

export interface HealthSummary {
	localDate: string;
	count: number;
	latestValue: number | null;
	latestTimestamp: number | null;
	sum: number | null;
	average: number | null;
	min: number | null;
	max: number | null;
	durationSeconds: number | null;
}

export interface HealthMetric {
	provider: 'google_health';
	sourceLabel: 'Google Health';
	dataType: string;
	known: boolean;
	category: HealthCategory;
	recordKind: 'sample' | 'interval' | 'daily' | 'session' | 'reference' | null;
	aggregation: HealthAggregation;
	primaryUnit: string | null;
	latestSummary: HealthSummary;
	trend?: HealthSummary[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_LOCAL_DATE_EPOCH_MS = -62_135_596_800_000;

export function isHealthCategory(value: string): value is HealthCategory {
	return (HEALTH_CATEGORIES as readonly string[]).includes(value);
}

export function isHealthDataType(value: string): boolean {
	return value.length <= 96 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

export function summaryNumber(
	metric: Pick<HealthMetric, 'aggregation'>,
	summary: HealthSummary
): number | null {
	switch (metric.aggregation) {
		case 'sum':
			return summary.sum;
		case 'average':
			return summary.average;
		case 'latest':
			return summary.latestValue;
		case 'duration':
			return summary.durationSeconds;
		default:
			return (
				summary.latestValue ?? summary.average ?? summary.sum ?? summary.durationSeconds ?? null
			);
	}
}

export function formatDuration(seconds: number): string {
	if (seconds >= 3600) return `${formatNumber(seconds / 3600, 1)} h`;
	if (seconds >= 60) return `${formatNumber(seconds / 60, 0)} min`;
	return `${formatNumber(seconds, 0)} s`;
}

export function formatMetricNumber(value: number, unit: string | null): string {
	const absolute = Math.abs(value);
	const digits = absolute < 10 ? 2 : absolute < 100 ? 1 : 0;
	const formatted = formatNumber(value, digits);
	return unit === null || unit.length === 0 ? formatted : `${formatted} ${unit}`;
}

/**
 * Formats a stored primary value. Sleep is kept in minutes, and shown in hours — including naps
 * under an hour — so it matches the session duration.
 */
export function formatMetricValue(value: number, unit: string | null, dataType: string): string {
	if (dataType === 'sleep' && unit === 'min') {
		return `${formatNumber(value / 60, 1, 1)} h`;
	}
	return formatMetricNumber(value, unit);
}

export function formatSummaryValue(
	metric: Pick<HealthMetric, 'aggregation' | 'primaryUnit'>,
	summary: HealthSummary,
	recordedLabel: string,
	emptyLabel = '−'
): string {
	const value = summaryNumber(metric, summary);
	if (value === null) return summary.count > 0 ? recordedLabel : emptyLabel;
	return metric.aggregation === 'duration'
		? formatDuration(value)
		: formatMetricNumber(value, metric.primaryUnit);
}

export function trendDelta(
	metric: Pick<HealthMetric, 'aggregation'>,
	summaries: readonly HealthSummary[]
): number | null {
	const values = summaries
		.map((summary) => summaryNumber(metric, summary))
		.filter((value): value is number => value !== null);
	return values.length < 2 ? null : values.at(-1)! - values.at(-2)!;
}

export function dateRange(
	toDate: string,
	days: number
): { fromDate: string; toDate: string } | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate) || !Number.isSafeInteger(days) || days < 1) {
		return null;
	}
	const toEpoch = new Date(`${toDate}T00:00:00.000Z`).getTime();
	if (!Number.isFinite(toEpoch)) return null;
	const fromEpoch = Math.max(MIN_LOCAL_DATE_EPOCH_MS, toEpoch - (days - 1) * DAY_MS);
	return { fromDate: new Date(fromEpoch).toISOString().slice(0, 10), toDate };
}

export function payloadPath(path: readonly string[], valueLabel: string): string {
	return path.length === 0 ? valueLabel : path.join(' · ');
}

export function payloadValue(value: null | boolean | number | string): string {
	if (value === null) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') return formatMetricNumber(value, null);
	return value;
}
