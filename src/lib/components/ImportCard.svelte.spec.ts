import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
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
		mocks.importSleepBatch.mockReset();
		mocks.importSleepBatch.mockResolvedValue({ imported: 1, skipped: 1 });
	});

	it.each(['150%;28800;25200', '80%;-3600;-7200'])(
		'rejects invalid CSV values %s before enabling import',
		async (values) => {
			render(ImportCard, {
				title: 'Sleep Cycle',
				description: 'CSV',
				kind: 'sleep'
			});
			const csv = `Went to bed;Woke up;Sleep quality;Time in bed (seconds);Time asleep (seconds)\n2026-10-27 23:00:00;2026-10-28 07:00:00;${values}`;
			await userEvent.upload(
				page.getByLabelText('Sleep Cycle'),
				new File([csv], 'sleep.csv', { type: 'text/csv' })
			);
			await expect.element(page.getByRole('alert')).toBeInTheDocument();
			expect(page.getByRole('alert').element().textContent).toContain(
				'No valid sleep records found'
			);
			await page.getByText('Invalid rows skipped: 1.', { exact: false }).click();
			await expect.element(page.getByText('CSV rows: 2.')).toBeInTheDocument();
			await expect
				.element(page.getByRole('button', { name: 'Import', exact: true }))
				.toBeDisabled();
			expect(mocks.importSleepBatch).not.toHaveBeenCalled();
		}
	);

	it('imports valid rows while retaining an invalid-row report separately from duplicates', async () => {
		render(ImportCard, { title: 'Sleep Cycle', description: 'CSV', kind: 'sleep' });
		const header = 'Went to bed;Woke up;Sleep quality;Time in bed (seconds);Time asleep (seconds)';
		const csv = [
			header,
			'2026-10-25 23:00:00;2026-10-26 07:00:00;80%;28800;25200',
			'2026-10-26 23:00:00;2026-10-27 07:00:00;150%;28800;25200',
			'2026-10-27 23:00:00;2026-10-28 07:00:00;85%;28800;25200',
			'2026-10-28 23:00:00;2026-10-29 07:00:00;80%;-3600;-7200'
		].join('\n');
		await userEvent.upload(
			page.getByLabelText('Sleep Cycle'),
			new File([csv], 'mixed.csv', { type: 'text/csv' })
		);
		await expect.element(page.getByText('2 records ready to import')).toBeInTheDocument();
		await page.getByText('Invalid rows skipped: 2.', { exact: false }).click();
		await expect.element(page.getByText('CSV rows: 3, 5.')).toBeInTheDocument();
		const button = page.getByRole('button', { name: 'Import', exact: true });
		await expect.element(button).toBeEnabled();
		await button.click();
		expect(mocks.importSleepBatch).toHaveBeenCalledExactlyOnceWith({
			records: [
				expect.objectContaining({ sleepQuality: 80, timeAsleepSeconds: 25200 }),
				expect.objectContaining({ sleepQuality: 85, timeAsleepSeconds: 25200 })
			]
		});
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent('Imported 1, skipped 1 duplicates');
		await expect.element(page.getByText('CSV rows: 3, 5.')).toBeInTheDocument();
	});

	it('clears the invalid-row report when a different valid file is selected', async () => {
		render(ImportCard, { title: 'Sleep Cycle', description: 'CSV', kind: 'sleep' });
		const header = 'Went to bed;Woke up;Sleep quality';
		await userEvent.upload(
			page.getByLabelText('Sleep Cycle'),
			new File([`${header}\ninvalid;invalid;150%`], 'bad.csv', { type: 'text/csv' })
		);
		await expect
			.element(page.getByText('Invalid rows skipped: 1.', { exact: false }))
			.toBeInTheDocument();
		await userEvent.upload(
			page.getByLabelText('Sleep Cycle'),
			new File([`${header}\n2026-10-27 23:00:00;2026-10-28 07:00:00;80%`], 'good.csv', {
				type: 'text/csv'
			})
		);
		await expect.element(page.getByText('1 records ready to import')).toBeInTheDocument();
		await expect
			.element(page.getByText('Invalid rows skipped:', { exact: false }))
			.not.toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
	});
});

describe('Hevy import feedback', () => {
	it('rejects an impossible date before enabling import', async () => {
		render(ImportCard, { title: 'Hevy', description: 'CSV', kind: 'hevy' });
		await userEvent.upload(
			page.getByLabelText('Hevy'),
			new File(
				[
					'title,start_time,end_time,exercise_title,set_index,weight_kg,reps\n' +
						'Back,"31 feb 2026, 18:00","31 feb 2026, 19:00",Squat,0,60,8'
				],
				'hevy.csv',
				{ type: 'text/csv' }
			)
		);
		await expect.element(page.getByRole('alert')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
	});
});
