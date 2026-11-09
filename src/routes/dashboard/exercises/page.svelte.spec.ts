import { page } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { ExerciseSession } from '#lib/server/workouts.js';
import ExercisesPage from './+page.svelte';

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('#lib/remote/imports.remote.js', () => ({
	getExercises: () => ({
		current: [{ exerciseTitle: 'Plank', setsCount: 1, lastPerformed: 1, mode: 'duration' }],
		ready: true
	}),
	getScaleWeights: () => ({ current: [], ready: true }),
	getExerciseSessions: () => ({
		current: [
			{
				workoutId: 'workout',
				startTime: 1,
				sets: 1,
				workingSets: 1,
				hardSets: 0,
				maxWeight: 0,
				e1rm: 0,
				volume: 0,
				maxReps: 0,
				totalReps: 0,
				distanceKm: 0,
				durationSeconds: 120,
				repMaxes: []
			} satisfies ExerciseSession
		],
		ready: true
	})
}));

describe('timed exercise progression', () => {
	it('shows a two-minute set in minutes instead of rounding it down to zero hours', async () => {
		render(ExercisesPage);
		await expect.element(page.getByRole('heading', { name: 'Plank' })).toBeInTheDocument();
		const stat = page.getByText('Longest set', { exact: true }).element().parentElement;
		expect(stat?.textContent).toContain('2');
		expect(stat?.textContent).toContain('min');
		expect(stat?.textContent).not.toContain('0.0');
	});
});
