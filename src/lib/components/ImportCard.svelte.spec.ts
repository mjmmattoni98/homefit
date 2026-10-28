import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MoonIcon from '@lucide/svelte/icons/moon';
import ImportCard from './ImportCard.svelte';

const mocks = vi.hoisted(() => ({ importSleepBatch: vi.fn() }));
vi.mock('#lib/remote/imports.remote.js', () => ({
	importSleepBatch: mocks.importSleepBatch,
	importWorkoutBatch: vi.fn()
}));
vi.mock('$app/navigation', () => ({ refreshAll: vi.fn() }));
vi.mock('svelte-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('Sleep Cycle import feedback', () => {
	beforeEach(() => {
		mocks.importSleepBatch.mockClear();
	});

	it.each(['150%;28800;25200', '80%;-3600;-7200'])(
		'rejects invalid CSV values %s before enabling import',
		async (values) => {
			render(ImportCard, {
				title: 'Sleep Cycle',
				description: 'CSV',
				kind: 'sleep',
				icon: MoonIcon
			});
			const csv = `Went to bed;Woke up;Sleep quality;Time in bed (seconds);Time asleep (seconds)\n2026-10-27 23:00:00;2026-10-28 07:00:00;${values}`;
			await userEvent.upload(
				page.getByLabelText('Sleep Cycle'),
				new File([csv], 'sleep.csv', { type: 'text/csv' })
			);
			await expect.element(page.getByRole('alert')).toBeInTheDocument();
			expect(page.getByRole('alert').element().textContent).toContain('CSV row 2');
			await expect
				.element(page.getByRole('button', { name: 'Import', exact: true }))
				.toBeDisabled();
			expect(mocks.importSleepBatch).not.toHaveBeenCalled();
		}
	);
});
