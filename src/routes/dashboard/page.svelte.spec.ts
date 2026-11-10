import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import OverviewPage from './+page.svelte';
import type { Dashboard } from '#lib/server/dashboard.js';

const mocks = vi.hoisted(() => ({
	dashboard: {
		today: '2026-11-09',
		timeZone: 'UTC',
		nights: [],
		googleSleepNights: [],
		trainingDays: [],
		vitalsDays: [],
		recentWorkouts: []
	} as Dashboard
}));

vi.mock('$app/env', () => ({ browser: true }));
vi.mock('$app/navigation', () => ({ refreshAll: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/state', () => ({ page: { data: { timeZoneKnown: true } } }));
vi.mock('#lib/remote/health.remote.js', () => ({
	getConnectionStatus: () => ({ current: null, ready: true, refresh: vi.fn() })
}));
vi.mock('#lib/remote/imports.remote.js', () => ({
	getWorkout: () => ({ current: null, ready: true }),
	getDashboard: () => ({
		current: mocks.dashboard,
		ready: true,
		refresh: vi.fn()
	})
}));
vi.mock('#lib/remote/goals.remote.js', () => ({
	getGoalDay: () => ({ ready: true }),
	getGoalHistory: () => ({ ready: true })
}));

describe('overview period selector', () => {
	beforeEach(() => {
		mocks.dashboard = {
			today: '2026-11-09',
			timeZone: 'UTC',
			nights: [],
			googleSleepNights: [],
			trainingDays: [],
			vitalsDays: [],
			recentWorkouts: []
		};
	});
	it('keeps the selected period checked when it changes or is clicked again', async () => {
		render(OverviewPage);
		const week = page.getByRole('radio', { name: 'Last 7 days' });
		await week.click();
		await expect.element(week).toHaveAttribute('aria-checked', 'true');
		await week.click();
		await expect.element(week).toHaveAttribute('aria-checked', 'true');
	});

	it('updates the data period through keyboard navigation', async () => {
		render(OverviewPage);
		const month = page.getByRole('radio', { name: 'Last 30 days' });
		await month.click();
		await userEvent.keyboard('{ArrowRight}');
		await userEvent.keyboard(' ');
		await expect
			.element(page.getByRole('radio', { name: 'Last 90 days' }))
			.toHaveAttribute('aria-checked', 'true');
		await expect.element(page.getByText('Aug 12 to Nov 9', { exact: false })).toBeInTheDocument();
	});
	it('shows current Google sleep and explains older Sleep Cycle data, which All restores', async () => {
		mocks.dashboard.nights = [
			{
				night: '2026-04-01',
				wentToBed: Date.UTC(2026, 3, 1, 22),
				wokeUp: Date.UTC(2026, 3, 2, 6),
				timeInBedSeconds: 8 * 3600,
				timeAsleepSeconds: 7 * 3600,
				sleepQuality: 80,
				notes: []
			}
		];
		mocks.dashboard.googleSleepNights = [
			{
				night: '2026-11-08',
				startTime: Date.UTC(2026, 10, 8, 22),
				endTime: Date.UTC(2026, 10, 9, 6),
				timeInBedSeconds: 8 * 3600,
				timeAsleepSeconds: 7 * 3600
			}
		];
		render(OverviewPage);
		await expect
			.element(page.getByText('No Sleep Cycle or Hevy records in these dates'))
			.toBeInTheDocument();
		await expect
			.element(page.getByText('Google Health nights in this period: 1.', { exact: false }))
			.toBeInTheDocument();
		await expect.element(page.getByText('Sleep quality', { exact: true })).not.toBeInTheDocument();
		await page.getByRole('button', { name: 'All records', exact: true }).click();
		await expect
			.element(page.getByText('Sleep Cycle nights in this period: 1.', { exact: false }))
			.toBeInTheDocument();
		await expect.element(page.getByText('Sleep quality', { exact: true })).toBeInTheDocument();
		await expect
			.element(page.getByText('No Sleep Cycle or Hevy records in these dates'))
			.not.toBeInTheDocument();
	});

	it('shows a Google-only history in All even without any Sleep Cycle imports', async () => {
		mocks.dashboard.googleSleepNights = [
			{
				night: '2026-10-01',
				startTime: Date.UTC(2026, 9, 1, 22),
				endTime: Date.UTC(2026, 9, 2, 6),
				timeInBedSeconds: 8 * 3600,
				timeAsleepSeconds: 7 * 3600
			}
		];
		render(OverviewPage);
		await page.getByRole('radio', { name: 'All records' }).click();
		await expect
			.element(page.getByText('Google Health nights in this period: 1.', { exact: false }))
			.toBeInTheDocument();
		await expect.element(page.getByRole('slider')).toBeInTheDocument();
	});
});
