import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import OverviewPage from './+page.svelte';

vi.mock('$app/env', () => ({ browser: true }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/state', () => ({ page: { data: { timeZoneKnown: true } } }));
vi.mock('#lib/remote/imports.remote.js', () => ({
	getWorkout: () => ({ current: null, ready: true }),
	getDashboard: () => ({
		current: {
			today: '2026-11-09',
			timeZone: 'UTC',
			nights: [],
			googleSleepNights: [],
			trainingDays: [],
			vitalsDays: [],
			recentWorkouts: []
		},
		ready: true,
		refresh: vi.fn()
	})
}));
vi.mock('#lib/remote/goals.remote.js', () => ({
	getGoalDay: () => ({ ready: true }),
	getGoalHistory: () => ({ ready: true })
}));

describe('overview period selector', () => {
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
});
