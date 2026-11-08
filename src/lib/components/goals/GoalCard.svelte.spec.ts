import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import GoalCard from './GoalCard.svelte';
import type { GoalProgress } from '#lib/server/daily-goals.js';

function goal(overrides: Partial<GoalProgress> = {}): GoalProgress {
	return {
		id: 'goal-1',
		name: 'Push-ups',
		unit: 'reps',
		target: 100,
		total: 40,
		met: false,
		entries: [{ id: 'entry-1', amount: 40, createdAt: 0 }],
		...overrides
	};
}

describe('GoalCard', () => {
	it('shows progress and the rep presets', async () => {
		render(GoalCard, { goal: goal(), onadd: () => {}, onundo: () => {} });

		await expect.element(page.getByText('40 / 100 reps')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: '+5 reps' })).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: '+20 reps' })).toBeInTheDocument();
		await expect.element(page.getByText('Goal met')).not.toBeInTheDocument();
	});

	it('reports preset and custom amounts', async () => {
		const onadd = vi.fn();
		render(GoalCard, { goal: goal(), onadd, onundo: () => {} });

		await page.getByRole('button', { name: '+10 reps' }).click();
		await page.getByLabelText('Custom amount for Push-ups').fill('25');
		await page.getByRole('button', { name: 'Add', exact: true }).click();

		expect(onadd.mock.calls).toEqual([[10], [25]]);
	});

	it('uses minute presets and marks a met goal', async () => {
		render(GoalCard, {
			goal: goal({ name: 'Walking pad', unit: 'minutes', target: 60, total: 65, met: true }),
			onadd: () => {},
			onundo: () => {}
		});

		await expect.element(page.getByText('65 / 60 min')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: '+15 min' })).toBeInTheDocument();
		await expect.element(page.getByText('Goal met')).toBeInTheDocument();
	});

	it('disables undo without entries and every action while pending', async () => {
		const screen = await render(GoalCard, {
			goal: goal({ total: 0, entries: [] }),
			onadd: () => {},
			onundo: () => {}
		});
		await expect.element(page.getByRole('button', { name: 'Undo' })).toBeDisabled();

		await screen.rerender({ goal: goal(), pending: true, onadd: () => {}, onundo: () => {} });
		await expect.element(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
		await expect.element(page.getByRole('button', { name: '+5 reps' })).toBeDisabled();
	});
});
