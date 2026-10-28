import { page } from 'vitest/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { SvelteMap } from 'svelte/reactivity';
import MetricPage from './+page.svelte';

// Stored record values, newest first; each record's timestamp equals its value. Reactive, so a
// change reaches the page like a refreshed query. The mocks below read it lazily.
const stored = new SvelteMap<'values', number[]>();

const metric = {
	provider: 'google_health',
	sourceLabel: 'Google Health',
	dataType: 'weight',
	known: true,
	category: 'body',
	recordKind: 'sample',
	aggregation: 'latest',
	primaryUnit: null,
	latestSummary: {
		localDate: '2026-08-20',
		count: 1,
		latestValue: 120,
		latestTimestamp: 120,
		sum: null,
		average: null,
		min: null,
		max: null,
		durationSeconds: null
	}
};

function detailRecord(value: number) {
	return {
		provider: 'google_health',
		dataType: 'weight',
		category: 'body',
		recordTimestamp: value,
		startTime: null,
		endTime: null,
		localDate: '2026-08-20',
		primaryValue: value,
		primaryUnit: null,
		sourcePlatform: null,
		sourceApplication: null,
		sourceDevice: null,
		recordingMethod: null,
		sourceFamily: null,
		googleCreateTime: null,
		googleUpdateTime: null,
		payload: { kind: 'unavailable' }
	};
}

/** Pages the stored records newest first after a cursor, like the server query. */
function recordsQuery({ limit, after }: { limit: number; after: { timestamp: number } | null }) {
	return {
		get current() {
			const rest = (stored.get('values') ?? []).filter(
				(value) => after === null || value < after.timestamp
			);
			const records = rest.slice(0, limit);
			const last = records.at(-1);
			return {
				records: records.map(detailRecord),
				nextCursor:
					rest.length > limit && last !== undefined ? { timestamp: last, id: `r${last}` } : null
			};
		},
		ready: true,
		error: undefined
	};
}

vi.mock('#lib/remote/health.remote.js', () => ({
	getMetrics: () => ({ current: [metric], ready: true, error: undefined }),
	getMetricTrend: () => ({ current: { kind: 'not_found' }, ready: true, error: undefined }),
	getMetricRecords: recordsQuery,
	getConnectionStatus: () => ({ current: null, ready: true, error: undefined, refresh: vi.fn() })
}));

vi.mock('$app/navigation', () => ({ refreshAll: vi.fn() }));

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

vi.mock('$app/state', () => ({
	page: { params: { dataType: 'weight' }, data: { googleHealthEnabled: false } }
}));

/** Newest first, from `newest` down to `oldest`. */
function values(newest: number, oldest: number): number[] {
	return Array.from({ length: newest - oldest + 1 }, (_, index) => newest - index);
}

function shownValues(): number[] {
	const rows = page.getByRole('row').elements().slice(1);
	return rows.map((row) => Number(row.querySelectorAll('td')[1]?.textContent?.trim()));
}

describe('metric records', () => {
	beforeEach(async () => {
		stored.set('values', values(120, 105));
		render(MetricPage);
		await page.getByRole('button', { name: 'Load more' }).click();
		await expect.poll(shownValues).toEqual(values(120, 105));
	});

	it('keeps loaded pages contiguous when a newer record arrives', async () => {
		stored.set('values', values(121, 105));

		await expect.poll(shownValues).toEqual(values(121, 106));
	});

	it('keeps loaded pages contiguous when a shown record is deleted', async () => {
		stored.set(
			'values',
			values(120, 105).filter((value) => value !== 118)
		);

		await expect.poll(shownValues).toEqual(values(120, 105).filter((value) => value !== 118));
	});
});
