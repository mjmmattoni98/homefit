import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import HealthTrendChart from './HealthTrendChart.svelte';
import '../../../routes/layout.css';

const summaries = [0, 1, 2].map((index) => ({
	localDate: `2026-10-${26 + index}`,
	count: 1,
	latestValue: 8000 + index * 1000,
	latestTimestamp: Date.UTC(2026, 9, 26 + index, 12),
	sum: 8000 + index * 1000,
	average: 8000 + index * 1000,
	min: 8000 + index * 1000,
	max: 8000 + index * 1000,
	durationSeconds: null
}));

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe('health chart axis layout', () => {
	it.each([
		[1280, 'steps'],
		[375, 'steps'],
		[375, 'breaths/min']
	] as const)('keeps %ipx chart labels with unit %s inside the chart', async (width, unit) => {
		await page.viewport(width, 667);
		render(HealthTrendChart, {
			metric: { dataType: 'steps', aggregation: 'sum', primaryUnit: unit },
			summaries
		});
		await expect
			.poll(() => document.querySelectorAll('.placement-left text').length)
			.toBeGreaterThan(0);
		await expect
			.poll(() => {
				const chart = document.querySelector('[data-slot="chart"]')?.getBoundingClientRect();
				const labels = [...document.querySelectorAll('.placement-left text')];
				return (
					chart !== undefined &&
					labels.every((label) => {
						const bounds = label.getBoundingClientRect();
						return bounds.width > 0 && bounds.left >= chart.left && bounds.right <= chart.right;
					})
				);
			})
			.toBe(true);
	});
});
