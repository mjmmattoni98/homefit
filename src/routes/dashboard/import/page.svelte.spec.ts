import { page, userEvent } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { SvelteMap } from 'svelte/reactivity';
import { toast } from 'svelte-sonner';
import ImportPage from './+page.svelte';

const saved = new SvelteMap<'zone', string | null>();
const mocks = vi.hoisted(() => ({ updateZone: vi.fn(), connection: vi.fn() }));

vi.mock('#lib/remote/imports.remote.js', () => ({
	getCsvSettings: () => ({
		get current() {
			return saved.get('zone');
		},
		get ready() {
			return saved.has('zone');
		}
	}),
	updateImportTimeZone: mocks.updateZone,
	getImportTimeZone: vi.fn().mockResolvedValue('UTC'),
	importSleepBatch: vi.fn(),
	importWorkoutBatch: vi.fn(),
	deleteCsvData: vi.fn()
}));
vi.mock('#lib/remote/health.remote.js', () => ({
	getConnectionStatus: mocks.connection,
	beginConnection: vi.fn(),
	syncNow: vi.fn(),
	disconnect: vi.fn(),
	deleteImportedData: vi.fn()
}));
vi.mock('$app/state', () => ({ page: { data: { googleHealthEnabled: true } } }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/navigation', () => ({ refreshAll: vi.fn() }));
vi.mock('svelte-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('Export time zone', () => {
	beforeEach(() => {
		saved.clear();
		saved.set('zone', null);
		vi.clearAllMocks();
		mocks.updateZone.mockReset();
		mocks.connection.mockReturnValue({ current: null, ready: true, error: undefined });
	});

	it('waits for saved settings before displaying the zone line', async () => {
		saved.clear();
		render(ImportPage);
		await expect.element(page.getByTestId('export-zone')).not.toBeInTheDocument();
		saved.set('zone', 'Pacific/Honolulu');
		await expect
			.element(page.getByTestId('export-zone'))
			.toHaveTextContent('Times in export files are read as Pacific/Honolulu. Change');
		await expect
			.element(page.getByText('Your first import will save', { exact: false }))
			.not.toBeInTheDocument();
	});

	it('names the browser zone before the first import and includes UTC and the saved zone in the picker', async () => {
		render(ImportPage);
		await expect
			.element(page.getByTestId('export-zone'))
			.toHaveTextContent(
				`Your first import will save ${Intl.DateTimeFormat().resolvedOptions().timeZone}, your browser’s time zone. Change`
			);
		saved.set('zone', 'Etc/GMT+8');
		await page.getByRole('button', { name: 'Change', exact: true }).click();
		await expect.element(page.getByRole('combobox')).toHaveValue('Etc/GMT+8');
		expect(page.getByRole('combobox').element().textContent).toContain('UTC');
		expect(page.getByRole('combobox').element().textContent).toContain('Europe/Madrid');
	});

	it('disables saving while pending, resets parsed CSVs and keeps the Google Health card mounted', async () => {
		const pending = Promise.withResolvers<void>();
		mocks.updateZone.mockReturnValue(pending.promise);
		render(ImportPage);
		await userEvent.upload(
			page.getByLabelText('Sleep Cycle'),
			new File(
				['Went to bed;Woke up;Sleep quality\n2026-10-27 23:00:00;2026-10-28 07:00:00;80%'],
				'sleep.csv',
				{ type: 'text/csv' }
			)
		);
		await userEvent.upload(
			page.getByLabelText('Hevy'),
			new File(
				[
					'title,start_time,end_time,exercise_title,set_index,weight_kg,reps\nBack,"27 oct 2026, 18:00","27 oct 2026, 19:00",Squat,0,60,8'
				],
				'hevy.csv',
				{ type: 'text/csv' }
			)
		);
		await expect
			.element(page.getByRole('button', { name: 'Import', exact: true }).first())
			.toBeEnabled();
		await expect
			.element(page.getByRole('button', { name: 'Import', exact: true }).last())
			.toBeEnabled();
		await page.getByRole('button', { name: 'Change', exact: true }).click();
		await page.getByRole('combobox').selectOptions('Pacific/Honolulu');
		await page.getByRole('button', { name: /Save time zone/ }).click();
		await expect.element(page.getByRole('button', { name: /Save time zone/ })).toBeDisabled();
		await expect.element(page.getByRole('combobox')).toBeDisabled();
		expect(mocks.updateZone).toHaveBeenCalledExactlyOnceWith('Pacific/Honolulu');
		pending.resolve();
		await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
		await expect
			.element(page.getByTestId('export-zone'))
			.toHaveTextContent('Times in export files are read as Pacific/Honolulu. Change');
		await expect
			.element(page.getByRole('button', { name: 'Import', exact: true }).first())
			.toBeDisabled();
		await expect
			.element(page.getByRole('button', { name: 'Import', exact: true }).last())
			.toBeDisabled();
		expect(mocks.connection).toHaveBeenCalledTimes(1);
	});

	it('keeps the dialog open and reports a failed save without file-reading advice', async () => {
		mocks.updateZone.mockRejectedValue(new TypeError('Failed to fetch'));
		render(ImportPage);
		await page.getByRole('button', { name: 'Change', exact: true }).click();
		await page.getByRole('button', { name: /Save time zone/ }).click();
		await expect.element(page.getByRole('button', { name: /Save time zone/ })).toBeEnabled();
		expect(toast.error).toHaveBeenCalledWith('The time zone could not be saved. Please try again.');
	});
});
