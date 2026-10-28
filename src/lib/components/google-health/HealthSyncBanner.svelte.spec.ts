import { page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { SvelteMap } from 'svelte/reactivity';
import HealthSyncBanner from './HealthSyncBanner.svelte';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), refreshAll: vi.fn() }));

// Reactive, so the banner sees a new connection like it would after a query refresh. The mock
// below reads it lazily, once the banner renders.
const connectionState = new SvelteMap<'current', Record<string, unknown> | null>();
const connectionQuery = {
	get current() {
		return connectionState.get('current');
	},
	error: undefined,
	ready: true,
	refresh: mocks.refresh
};

vi.mock('#lib/remote/health.remote.js', () => ({
	getConnectionStatus: () => connectionQuery
}));

vi.mock('$app/navigation', () => ({ refreshAll: mocks.refreshAll }));

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

vi.mock('$app/state', () => ({ page: { data: { googleHealthEnabled: true } } }));

function connection(status: string, lastSuccessfulSyncAt?: number): Record<string, unknown> {
	return {
		status,
		grantedScopes: [],
		backfillCompletedTypes: 3,
		backfillTotalTypes: 7,
		lastSuccessfulSyncAt
	};
}

describe('HealthSyncBanner', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('refreshes every health query while the import runs', async () => {
		connectionState.set('current', connection('backfilling'));
		render(HealthSyncBanner);
		await expect.element(page.getByText('3 of 7 metric types completed')).toBeInTheDocument();

		vi.advanceTimersByTime(15_000);

		expect(mocks.refreshAll).toHaveBeenCalledTimes(1);
	});

	it('polls the status once connected and refreshes the views after a background sync', async () => {
		connectionState.set('current', connection('active', Date.UTC(2026, 7, 20, 12)));
		render(HealthSyncBanner);
		await expect.element(page.getByText('Connected', { exact: true })).toBeInTheDocument();

		vi.advanceTimersByTime(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
		expect(mocks.refreshAll).not.toHaveBeenCalled();

		connectionState.set('current', connection('active', Date.UTC(2026, 7, 21, 12)));
		await expect.poll(() => mocks.refreshAll.mock.calls.length).toBe(1);
	});

	it('refreshes the views when the connection is deleted between polls, and keeps polling', async () => {
		connectionState.set('current', connection('active', Date.UTC(2026, 7, 20, 12)));
		render(HealthSyncBanner);
		await expect.element(page.getByText('Connected', { exact: true })).toBeInTheDocument();

		connectionState.set('current', null);
		await expect.poll(() => mocks.refreshAll.mock.calls.length).toBe(1);

		vi.advanceTimersByTime(30_000);
		expect(mocks.refresh).toHaveBeenCalledTimes(1);
	});
});
