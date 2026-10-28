export const CONNECTION_STATUSES = [
	'connecting',
	'backfilling',
	'active',
	'delayed',
	'action_required',
	'disconnected',
	'deleting'
] as const;

export const HEALTH_CATEGORIES = [
	'activity',
	'vitals',
	'sleep',
	'body',
	'nutrition',
	'other'
] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
export type HealthCategory = (typeof HEALTH_CATEGORIES)[number];
export type SyncMode = 'backfill' | 'incremental';
export type SyncTrigger = 'oauth' | 'webhook' | 'manual' | 'retry' | 'reconciliation';
export type CursorStatus = 'queued' | 'running' | 'retry' | 'complete' | 'failed';
export type SyncRunStatus = 'running' | 'succeeded' | 'failed';
export type DeliveryStatus = 'queued' | 'complete' | 'rejected';

/** Statuses in which a connection may fetch data from Google. */
export const SYNCABLE_STATUSES: ReadonlySet<ConnectionStatus> = new Set([
	'backfilling',
	'active',
	'delayed'
]);

export interface PageCounts {
	fetched: number;
	inserted: number;
	updated: number;
	skipped: number;
}

/** A Google data point after validation and normalization, ready to be stored. */
export interface NormalizedHealthPoint {
	provider: 'google_health';
	recordKey: string;
	googleDataPointName?: string;
	dataType: string;
	category: HealthCategory;
	recordTimestamp: number;
	startTime?: number;
	endTime?: number;
	localDate: string;
	physicalCoverageKey?: string;
	civilCoverageTime?: string;
	primaryValue?: number;
	primaryUnit?: string;
	sourcePlatform?: string;
	sourceApplication?: string;
	sourceDevice?: string;
	recordingMethod?: string;
	sourceFamily?: string;
	googleCreateTime?: number;
	googleUpdateTime?: number;
	payloadDigest: string;
	payloadJson: string;
}
