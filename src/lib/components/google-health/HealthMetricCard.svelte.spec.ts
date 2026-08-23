import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import HealthMetricCard from './HealthMetricCard.svelte';
import type { HealthMetric, HealthSummary } from '$lib/google-health/view';

function summary(overrides: Partial<HealthSummary> = {}): HealthSummary {
	return {
		localDate: '2026-08-20',
		count: 1,
		latestValue: 72.4,
		latestTimestamp: Date.UTC(2026, 7, 20, 12),
		sum: 72.4,
		average: 72.4,
		min: 72.4,
		max: 72.4,
		durationSeconds: null,
		...overrides
	};
}

function metric(overrides: Partial<HealthMetric> = {}): HealthMetric {
	return {
		provider: 'google_health',
		sourceLabel: 'Google Health',
		dataType: 'weight',
		known: true,
		category: 'body',
		recordKind: 'sample',
		aggregation: 'latest',
		primaryUnit: 'kg',
		latestSummary: summary(),
		...overrides
	};
}

describe('HealthMetricCard', () => {
	it('formats a numeric value with its unit and source', async () => {
		render(HealthMetricCard, {
			metric: metric(),
			href: '/dashboard/health/metrics/weight'
		});

		await expect.element(page.getByText('Weight')).toBeInTheDocument();
		await expect.element(page.getByText('72.4 kg')).toBeInTheDocument();
		await expect.element(page.getByText('Source: Google Health')).toBeInTheDocument();
	});

	it('uses Recorded for a complex metric without a scalar value', async () => {
		render(HealthMetricCard, {
			metric: metric({
				dataType: 'electrocardiogram',
				category: 'vitals',
				recordKind: 'session',
				aggregation: 'latest',
				primaryUnit: '',
				latestSummary: summary({ latestValue: null, sum: null, average: null })
			}),
			href: '/dashboard/health/metrics/electrocardiogram'
		});

		await expect.element(page.getByText('Recorded')).toBeInTheDocument();
	});

	it('shows the change between the two latest trend values', async () => {
		render(HealthMetricCard, {
			metric: metric(),
			href: '/dashboard/health/metrics/weight',
			trend: [
				summary({ localDate: '2026-08-19', latestValue: 71.8 }),
				summary({ localDate: '2026-08-20', latestValue: 72.4 })
			]
		});

		await expect.element(page.getByText('+0.6 kg')).toBeInTheDocument();
	});
});
