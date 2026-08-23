import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import GoogleHealthImportCard from './GoogleHealthImportCard.svelte';

const mocks = vi.hoisted(() => ({
	auth: { isAuthenticated: true, isLoading: false },
	connectionQuery: {
		data: null as Record<string, unknown> | null | undefined,
		error: undefined as Error | undefined,
		isLoading: false
	},
	beginConnection: vi.fn(),
	syncNow: vi.fn(),
	disconnect: vi.fn(),
	deleteImportedData: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn()
}));

vi.mock('$convex/_generated/api', () => ({
	api: {
		googleHealth: {
			model: { getConnectionStatus: 'getConnectionStatus' },
			account: {
				syncNow: 'syncNow',
				disconnect: 'disconnect',
				deleteImportedData: 'deleteImportedData'
			},
			oauth: { beginConnection: 'beginConnection' }
		}
	}
}));

vi.mock('convex-svelte', () => ({
	useAuth: () => mocks.auth,
	useQuery: () => mocks.connectionQuery,
	useAction: (reference: string) =>
		reference === 'beginConnection' ? mocks.beginConnection : mocks.disconnect,
	useMutation: (reference: string) =>
		reference === 'syncNow' ? mocks.syncNow : mocks.deleteImportedData
}));

vi.mock('svelte-sonner', () => ({
	toast: {
		success: mocks.toastSuccess,
		error: mocks.toastError
	}
}));

function connection(status: string, completed = 40, total = 40): Record<string, unknown> {
	return {
		status,
		grantedScopes: ['https://www.googleapis.com/auth/fitness.activity.read'],
		backfillCompletedTypes: completed,
		backfillTotalTypes: total,
		lastSuccessfulSyncAt: Date.UTC(2026, 7, 20, 12)
	};
}

describe('GoogleHealthImportCard', () => {
	beforeEach(() => {
		mocks.auth.isAuthenticated = true;
		mocks.auth.isLoading = false;
		mocks.connectionQuery.data = null;
		mocks.connectionQuery.error = undefined;
		mocks.connectionQuery.isLoading = false;
		vi.clearAllMocks();
		mocks.beginConnection.mockResolvedValue({ authorizationUrl: 'https://accounts.google.com/' });
		mocks.syncNow.mockResolvedValue(undefined);
		mocks.disconnect.mockResolvedValue(undefined);
		mocks.deleteImportedData.mockResolvedValue(undefined);
	});

	it('starts per-user OAuth and follows the returned authorization URL', async () => {
		const navigate = vi.fn();
		render(GoogleHealthImportCard, { navigate });

		await expect.element(page.getByText('Not connected')).toBeInTheDocument();
		await page.getByRole('button', { name: 'Connect Google Health' }).click();

		expect(mocks.beginConnection).toHaveBeenCalledWith({ returnPath: '/dashboard/import' });
		expect(navigate).toHaveBeenCalledWith('https://accounts.google.com/');
	});

	it('reports backfill progress by metric type', async () => {
		mocks.connectionQuery.data = connection('backfilling', 7, 40);
		render(GoogleHealthImportCard);

		await expect.element(page.getByText('7 of 40 metric types completed')).toBeInTheDocument();
		await expect.element(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '7');
	});

	it.each([
		['connecting', 'Preparing your import'],
		['delayed', 'Import temporarily delayed'],
		['action_required', 'Google Health needs your attention'],
		['disconnected', 'Imported data retained'],
		['deleting', 'Your imported Google Health data is being deleted.']
	])('renders the %s connection state', async (status, expectedText) => {
		mocks.connectionQuery.data = connection(status);
		render(GoogleHealthImportCard);

		await expect.element(page.getByText(expectedText, { exact: false })).toBeInTheDocument();
	});

	it('queues a manual sync for an active connection', async () => {
		mocks.connectionQuery.data = connection('active');
		render(GoogleHealthImportCard);

		await page.getByRole('button', { name: 'Sync now' }).click();

		expect(mocks.syncNow).toHaveBeenCalledWith({});
		await expect.element(page.getByText('Connected')).toBeInTheDocument();
	});

	it('explains that disconnecting retains imported data', async () => {
		mocks.connectionQuery.data = connection('active');
		render(GoogleHealthImportCard);

		await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
		const dialog = page.getByRole('alertdialog');
		await expect
			.element(dialog.getByText(/imported Google Health data stays available/i))
			.toBeInTheDocument();
		await dialog.getByRole('button', { name: 'Disconnect Google Health' }).click();

		expect(mocks.disconnect).toHaveBeenCalledWith({});
	});

	it('requires the exact phrase before deleting imported data', async () => {
		mocks.connectionQuery.data = connection('disconnected');
		render(GoogleHealthImportCard);

		await page.getByRole('button', { name: 'Delete imported data', exact: true }).click();
		const dialog = page.getByRole('alertdialog');
		const confirmation = dialog.getByLabelText('Confirmation');
		const deleteButton = dialog.getByRole('button', {
			name: 'Delete imported data',
			exact: true
		});
		await expect.element(deleteButton).toBeDisabled();

		await confirmation.fill('DELETE GOOGLE DATA');
		await expect.element(deleteButton).toBeEnabled();
		await deleteButton.click();

		expect(mocks.deleteImportedData).toHaveBeenCalledWith({
			confirmation: 'DELETE GOOGLE DATA'
		});
	});
});
