import * as v from 'valibot';
import { error } from '@sveltejs/kit';
import { command, query } from '$app/server';
import { googleHealthConfig } from '#lib/server/config.js';
import { db } from '#lib/server/db/index.js';
import {
	beginConnection as begin,
	beginDeletion,
	disconnect as disconnectConnection,
	getConnectionStatus as connectionStatus,
	requestManualSync
} from '#lib/server/google-health/connection.js';
import {
	getMetricTrend as metricTrend,
	getOverview as overview,
	listCategories,
	listMetricRecords as metricRecords,
	listMetrics
} from '#lib/server/google-health/records.js';
import { HEALTH_CATEGORIES } from '#lib/server/google-health/types.js';
import { requestDeletion, requestSync } from '#lib/server/jobs.js';
import { requireUserId } from '#lib/server/session.js';

const dataType = v.pipe(v.string(), v.maxLength(96), v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));
const localDate = v.pipe(v.string(), v.isoDate());

function requireGoogleHealth() {
	if (googleHealthConfig === null) error(404, 'Google Health is not configured');
	return googleHealthConfig;
}

export const getConnectionStatus = query(async () => await connectionStatus(db, requireUserId()));

export const getCategories = query(async () => await listCategories(db, requireUserId()));

export const getMetrics = query(v.nullable(v.picklist(HEALTH_CATEGORIES)), async (category) =>
	listMetrics(db, requireUserId(), category)
);

export const getOverview = query(
	v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(365)),
	async (days) => overview(db, requireUserId(), days)
);

export const getMetricTrend = query(
	v.object({ dataType, fromDate: localDate, toDate: localDate }),
	async (args) => await metricTrend(db, requireUserId(), args)
);

export const getMetricRecords = query(
	v.object({
		dataType,
		limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)),
		after: v.nullable(
			v.object({ timestamp: v.pipe(v.number(), v.finite()), id: v.pipe(v.string(), v.uuid()) })
		)
	}),
	async (args) => await metricRecords(db, requireUserId(), args)
);

export const beginConnection = command(
	v.object({ returnPath: v.pipe(v.string(), v.maxLength(200)) }),
	async ({ returnPath }) => await begin(db, requireGoogleHealth(), requireUserId(), returnPath)
);

export const syncNow = command(async () => {
	requireGoogleHealth();
	const { connectionId, queued } = await requestManualSync(db, requireUserId());
	await requestSync(connectionId);
	void getConnectionStatus().refresh();
	return { queued };
});

export const disconnect = command(async () => {
	await disconnectConnection(db, requireGoogleHealth(), requireUserId());
	void getConnectionStatus().refresh();
	return { status: 'disconnected' as const };
});

export const deleteImportedData = command(
	v.object({ confirmation: v.pipe(v.string(), v.maxLength(100)) }),
	async ({ confirmation }) => {
		const config = requireGoogleHealth();
		const { connectionId, generation } = await beginDeletion(
			db,
			config,
			requireUserId(),
			confirmation
		);
		await requestDeletion(connectionId, generation);
		void getConnectionStatus().refresh();
		return { status: 'deleting' as const };
	}
);
