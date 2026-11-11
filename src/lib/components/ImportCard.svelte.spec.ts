import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { error } from '@sveltejs/kit';
import { toast } from 'svelte-sonner';
import { CSV_DELETE_CONFIRMATION } from '#lib/csv/confirmation.js';
import ImportCard from './ImportCard.svelte';

const mocks = vi.hoisted(() => ({ importSleepBatch: vi.fn(), deleteCsvData: vi.fn() }));
vi.mock('#lib/remote/imports.remote.js', () => ({
	importSleepBatch: mocks.importSleepBatch,
	importWorkoutBatch: vi.fn(),
	deleteCsvData: mocks.deleteCsvData,
	getImportTimeZone: vi.fn().mockResolvedValue('UTC')
}));
vi.mock('$app/navigation', () => ({ refreshAll: vi.fn() }));
vi.mock('svelte-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('Sleep Cycle import feedback', () => {
	beforeEach(() => {
		mocks.importSleepBatch.mockReset();
		mocks.importSleepBatch.mockResolvedValue({ imported: 1, updated: 0, skipped: 1 });
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
			timeZone: 'UTC',
			records: [
				expect.objectContaining({ sleepQuality: 80, timeAsleepSeconds: 25200 }),
				expect.objectContaining({ sleepQuality: 85, timeAsleepSeconds: 25200 })
			]
		});
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent('Imported 1, updated 0, skipped 1');
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

describe('Import and deletion failures', () => {
	const csv = 'Went to bed;Woke up;Sleep quality\n2026-10-27 23:00:00;2026-10-28 07:00:00;80%';

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.importSleepBatch.mockReset();
		mocks.deleteCsvData.mockReset();
	});

	async function importSleep(content = csv) {
		render(ImportCard, { title: 'Sleep Cycle', description: 'CSV', kind: 'sleep' });
		await userEvent.upload(
			page.getByLabelText('Sleep Cycle'),
			new File([content], 'sleep.csv', { type: 'text/csv' })
		);
		await page.getByRole('button', { name: 'Import', exact: true }).click();
	}

	it('shows the message chosen by the server for an HttpError', async () => {
		mocks.importSleepBatch.mockImplementation(() => error(409, 'Select the file again.'));
		await importSleep();
		expect(toast.error).toHaveBeenCalledWith('Select the file again.');
	});

	it.each([new TypeError('Failed to fetch'), 'unexpected response', 500])(
		'shows an honest generic import failure for %s',
		async (failure) => {
			mocks.importSleepBatch.mockImplementation(() => {
				if (failure === 500) error(500, 'Internal details');
				throw failure;
			});
			await importSleep();
			expect(toast.error).toHaveBeenCalledWith('The import could not finish. Please try again.');
		}
	);

	it('explains that completed batches were saved if a later batch fails', async () => {
		mocks.importSleepBatch
			.mockResolvedValueOnce({ imported: 200, updated: 0, skipped: 0 })
			.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		await importSleep(
			csv.split('\n')[0] + '\n' + Array.from({ length: 201 }, () => csv.split('\n')[1]).join('\n')
		);
		expect(mocks.importSleepBatch).toHaveBeenCalledTimes(2);
		expect(toast.error).toHaveBeenCalledWith(
			'The import could not finish. Please try again. Records from completed batches were saved.'
		);
	});

	it('requires the source phrase, clears it on Cancel, and reports deletion failures separately', async () => {
		mocks.deleteCsvData.mockRejectedValue(new Error('Unavailable'));
		render(ImportCard, { title: 'Sleep Cycle', description: 'CSV', kind: 'sleep' });
		const trigger = page.getByRole('button', { name: 'Delete imported data', exact: true });
		await trigger.click();
		const dialog = page.getByRole('alertdialog');
		const input = dialog.getByLabelText('Confirmation');
		const action = dialog.getByRole('button', { name: 'Delete imported data', exact: true });
		await input.fill('delete');
		await expect.element(action).toBeDisabled();
		await input.fill(CSV_DELETE_CONFIRMATION.sleep);
		await expect.element(action).toBeEnabled();
		await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
		await trigger.click();
		await expect.element(dialog.getByLabelText('Confirmation')).toHaveValue('');
		await dialog.getByLabelText('Confirmation').fill(CSV_DELETE_CONFIRMATION.sleep);
		await action.click();
		expect(mocks.deleteCsvData).toHaveBeenCalledExactlyOnceWith({
			source: 'sleep',
			confirmation: CSV_DELETE_CONFIRMATION.sleep
		});
		expect(toast.error).toHaveBeenCalledWith(
			'The imported data could not be deleted. Please try again.'
		);
	});
});
