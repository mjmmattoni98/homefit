import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SleepSourcesChart from './SleepSourcesChart.svelte';
import { compareSleepSources } from '#lib/sleep-sources.js';
import '../../../routes/layout.css';

type ScNight = Parameters<typeof compareSleepSources>[0][number];
type GhNight = Parameters<typeof compareSleepSources>[1][number];

const scNights: ScNight[] = [
	{
		night: '2026-04-01',
		wentToBed: Date.UTC(2026, 3, 1, 22, 30),
		wokeUp: Date.UTC(2026, 3, 2, 6, 30),
		sleepQuality: 84,
		timeInBedSeconds: 8 * 3600,
		timeAsleepSeconds: 7.1 * 3600,
		notes: []
	},
	{
		night: '2026-04-02',
		wentToBed: Date.UTC(2026, 3, 2, 23, 0),
		wokeUp: Date.UTC(2026, 3, 3, 7, 0),
		sleepQuality: 88,
		timeInBedSeconds: 8 * 3600,
		timeAsleepSeconds: 7.4 * 3600,
		notes: []
	}
];

const ghNights: GhNight[] = [
	{
		night: '2026-04-01',
		startTime: Date.UTC(2026, 3, 1, 22, 42),
		endTime: Date.UTC(2026, 3, 2, 6, 25),
		timeInBedSeconds: 7.72 * 3600,
		timeAsleepSeconds: 6.75 * 3600,
		deepSeconds: 1.4 * 3600,
		lightSeconds: 3.6 * 3600,
		remSeconds: 1.75 * 3600,
		awakeSeconds: 0.97 * 3600
	},
	{
		night: '2026-04-02',
		startTime: Date.UTC(2026, 3, 2, 23, 10),
		endTime: Date.UTC(2026, 3, 3, 6, 55),
		timeInBedSeconds: 7.75 * 3600,
		timeAsleepSeconds: 6.9 * 3600,
		deepSeconds: 1.5 * 3600,
		lightSeconds: 3.6 * 3600,
		remSeconds: 1.8 * 3600,
		awakeSeconds: 0.85 * 3600
	}
];

describe('SleepSourcesChart', () => {
	it('renders matched nights, metric switcher, and Google Health stage summary', async () => {
		const comparison = compareSleepSources(scNights, ghNights, 'UTC', '2026-04-01', '2026-04-02');
		render(SleepSourcesChart, { comparison });

		await expect.element(page.getByText('Sleep Cycle vs Google Health')).toBeInTheDocument();
		await expect.element(page.getByText('Shared nights')).toBeInTheDocument();
		await expect
			.element(page.getByText('Google Health sleep stages (nightly mean)'))
			.toBeInTheDocument();

		const timingTab = page.getByRole('radio', { name: 'Bed & wake' });
		await timingTab.click();
		await expect.element(timingTab).toHaveAttribute('data-state', 'on');
	});
	it('explains an absent source in the selected dates without claiming both sources have records', async () => {
		const comparison = compareSleepSources(
			scNights,
			ghNights.map((night) => ({ ...night, night: '2026-11-08' })),
			'UTC',
			'2026-10-12',
			'2026-11-10'
		);
		render(SleepSourcesChart, { comparison });
		await expect
			.element(page.getByText('Sleep Cycle nights in this period: 0.', { exact: false }))
			.toBeInTheDocument();
		await expect
			.element(page.getByText('Google Health nights in this period: 1.', { exact: false }))
			.toBeInTheDocument();
		await expect
			.element(page.getByText('No Sleep Cycle nights in this period.', { exact: false }))
			.toBeInTheDocument();
		await expect.element(page.getByText('Latest available: Apr 2, 2026.')).toBeInTheDocument();
		await expect
			.element(page.getByText('Both sources have records,', { exact: false }))
			.not.toBeInTheDocument();
		await expect
			.element(page.getByRole('slider'))
			.toHaveAttribute('aria-valuetext', expect.stringContaining('Google Health'));
	});
});
