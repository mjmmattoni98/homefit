import { describe, expect, it } from 'vitest';
import {
	dateRange,
	formatMetricValue,
	formatSummaryValue,
	isHealthCategory,
	isHealthDataType,
	payloadPath,
	payloadValue,
	summaryNumber,
	trendDelta,
	type HealthMetric,
	type HealthSummary
} from './view';

const baseSummary: HealthSummary = {
	localDate: '2026-08-20',
	count: 1,
	latestValue: 72,
	latestTimestamp: 1,
	sum: 144,
	average: 72,
	min: 70,
	max: 74,
	durationSeconds: 3600
};

const baseMetric: HealthMetric = {
	provider: 'google_health',
	sourceLabel: 'Google Health',
	dataType: 'weight',
	known: true,
	category: 'body',
	recordKind: 'sample',
	aggregation: 'latest',
	primaryUnit: 'kg',
	latestSummary: baseSummary
};

describe('Google Health view helpers', () => {
	it('uses the registry aggregation when selecting a summary value', () => {
		expect(summaryNumber({ aggregation: 'sum' }, baseSummary)).toBe(144);
		expect(summaryNumber({ aggregation: 'average' }, baseSummary)).toBe(72);
		expect(summaryNumber({ aggregation: 'latest' }, baseSummary)).toBe(72);
		expect(summaryNumber({ aggregation: 'duration' }, baseSummary)).toBe(3600);
	});

	it('shows sleep stored in minutes as hours and leaves other minute metrics unchanged', () => {
		expect(formatMetricValue(536, 'min', 'sleep')).toBe('8.9 h');
		expect(formatMetricValue(298, 'min', 'sleep')).toBe('5.0 h');
		expect(formatMetricValue(59, 'min', 'sleep')).toBe('1.0 h');
		expect(formatMetricValue(54, 'min', 'sleep')).toBe('0.9 h');
		expect(formatMetricValue(50, 'min', 'exercise')).toBe('50 min');
		expect(formatMetricValue(30, 'min', 'active-minutes')).toBe('30 min');
	});

	it('formats scalar, duration, and complex recorded summaries', () => {
		expect(formatSummaryValue(baseMetric, baseSummary, 'Recorded')).toBe('72 kg');
		expect(
			formatSummaryValue({ aggregation: 'duration', primaryUnit: '' }, baseSummary, 'Recorded')
		).toBe('1 h');
		expect(
			formatSummaryValue(
				{ aggregation: 'latest', primaryUnit: '' },
				{ ...baseSummary, latestValue: null, average: null, sum: null, durationSeconds: null },
				'Recorded'
			)
		).toBe('Recorded');
	});

	it('calculates the latest available trend delta', () => {
		expect(
			trendDelta(baseMetric, [
				{ ...baseSummary, latestValue: 71 },
				{ ...baseSummary, latestValue: null },
				{ ...baseSummary, latestValue: 72.5 }
			])
		).toBe(1.5);
	});

	it('builds bounded date ranges and validates route literals', () => {
		expect(dateRange('2026-08-20', 30)).toEqual({
			fromDate: '2026-07-22',
			toDate: '2026-08-20'
		});
		expect(dateRange('0001-01-01', 365)).toEqual({
			fromDate: '0001-01-01',
			toDate: '0001-01-01'
		});
		expect(isHealthCategory('nutrition')).toBe(true);
		expect(isHealthCategory('private')).toBe(false);
		expect(isHealthDataType('daily-resting-heart-rate')).toBe(true);
		expect(isHealthDataType('../secret')).toBe(false);
	});

	it('formats flattened payload fields as text', () => {
		expect(payloadPath(['summary', 'minutesAsleep'], 'Value')).toBe('summary · minutesAsleep');
		expect(payloadPath([], 'Value')).toBe('Value');
		expect(payloadValue(false)).toBe('false');
		expect(payloadValue('<script>')).toBe('<script>');
	});
});
