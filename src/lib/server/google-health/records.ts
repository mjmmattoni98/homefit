import { and, desc, eq, gte, lt, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../db/types';
import { healthDailySummary, healthDataPoint } from '../db/schema';
import { getMetricDefinition, type MetricAggregation, type MetricRecordKind } from './registry';
import { HEALTH_CATEGORIES, type HealthCategory } from './types';

const MAX_PUBLIC_METRIC_TYPES = 96;
const MAX_TREND_SUMMARIES = 366;
const MAX_RECORDS_PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_LOCAL_DATE_EPOCH_MS = -62_135_596_800_000;
const MAX_DETAIL_PAYLOAD_BYTES = 128 * 1024;
const MAX_DETAIL_PAYLOAD_DEPTH = 8;
const MAX_DETAIL_PAYLOAD_FIELDS = 128;
const MAX_DETAIL_PAYLOAD_NODES = 256;
const MAX_PAYLOAD_PATH_COMPONENT_BYTES = 96;
const MAX_PAYLOAD_PATH_BYTES = 512;
const MAX_PAYLOAD_STRING_BYTES = 512;
const MAX_SOURCE_FIELD_BYTES = 256;
const OVERVIEW_PRIORITY = new Map([
	['steps', 0],
	['sleep', 1],
	['daily-resting-heart-rate', 2],
	['weight', 3]
]);

type SummaryRow = typeof healthDailySummary.$inferSelect;
type PointRow = typeof healthDataPoint.$inferSelect;

export interface MetricMetadata {
	provider: 'google_health';
	sourceLabel: 'Google Health';
	dataType: string;
	known: boolean;
	category: HealthCategory;
	recordKind: MetricRecordKind | null;
	aggregation: MetricAggregation | null;
	primaryUnit: string | null;
}

export interface SummaryView {
	localDate: string;
	count: number;
	latestValue: number | null;
	latestTimestamp: number | null;
	sum: number | null;
	average: number | null;
	min: number | null;
	max: number | null;
	durationSeconds: number | null;
}

export interface CatalogMetric extends MetricMetadata {
	latestSummary: SummaryView;
}

export interface OverviewMetric extends CatalogMetric {
	trend: SummaryView[];
}

export interface Overview {
	anchorDate: string | null;
	fromDate: string | null;
	toDate: string | null;
	metrics: OverviewMetric[];
}

export type MetricTrend =
	{ kind: 'not_found' } | { kind: 'found'; metric: MetricMetadata; summaries: SummaryView[] };

type PayloadLeaf = { path: string[]; value: null | boolean | number | string };
export type SafePayload = { kind: 'fields'; fields: PayloadLeaf[] } | { kind: 'unavailable' };

export interface DetailRecord {
	provider: 'google_health';
	dataType: string;
	category: HealthCategory;
	recordTimestamp: number;
	startTime: number | null;
	endTime: number | null;
	localDate: string;
	primaryValue: number | null;
	primaryUnit: string | null;
	sourcePlatform: string | null;
	sourceApplication: string | null;
	sourceDevice: string | null;
	recordingMethod: string | null;
	sourceFamily: string | null;
	googleCreateTime: number | null;
	googleUpdateTime: number | null;
	payload: SafePayload;
}

/** Opaque position of the last record of a page (timestamp and id). */
export interface RecordsCursor {
	timestamp: number;
	id: string;
}

export interface RecordsPage {
	records: DetailRecord[];
	nextCursor: RecordsCursor | null;
}

export function metricMetadata(dataType: string): MetricMetadata {
	const definition = getMetricDefinition(dataType);
	return {
		provider: 'google_health',
		sourceLabel: 'Google Health',
		dataType,
		known: definition !== null,
		category: definition?.category ?? 'other',
		recordKind: definition?.recordKind ?? null,
		aggregation: definition?.aggregation ?? null,
		primaryUnit: definition?.primaryUnit ?? null
	};
}

function summaryView(summary: SummaryRow): SummaryView {
	return {
		localDate: summary.localDate,
		count: summary.count,
		latestValue: summary.latestValue,
		latestTimestamp: summary.latestTimestamp?.getTime() ?? null,
		sum: summary.sum,
		average: summary.average,
		min: summary.min,
		max: summary.max,
		durationSeconds: summary.durationSeconds
	};
}

function compareDataTypes(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function assertDataType(dataType: string): void {
	if (dataType.length > 96 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(dataType)) {
		throw new Error('Invalid Google Health data type');
	}
}

function parseLocalDate(localDate: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(0);
	date.setUTCHours(0, 0, 0, 0);
	date.setUTCFullYear(year, month - 1, day);
	if (
		year < 1 ||
		year > 9999 ||
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return null;
	}
	return date.getTime();
}

function formatLocalDate(epochMs: number): string {
	return new Date(epochMs).toISOString().slice(0, 10);
}

function assertDateRange(fromDate: string, toDate: string): void {
	const from = parseLocalDate(fromDate);
	const to = parseLocalDate(toDate);
	if (from === null || to === null || from > to || (to - from) / DAY_MS + 1 > 366) {
		throw new Error('Invalid Google Health date range');
	}
}

function utf8BytesAtMost(value: string, maximum: number): boolean {
	return value.length <= maximum && new TextEncoder().encode(value).byteLength <= maximum;
}

function flattenPayloadValue(
	value: unknown,
	path: string[],
	pathBytes: number,
	depth: number,
	state: { nodes: number; fields: PayloadLeaf[] }
): boolean {
	state.nodes += 1;
	if (state.nodes > MAX_DETAIL_PAYLOAD_NODES || depth > MAX_DETAIL_PAYLOAD_DEPTH) return false;
	if (
		value === null ||
		typeof value === 'boolean' ||
		typeof value === 'string' ||
		typeof value === 'number'
	) {
		if (typeof value === 'number' && !Number.isFinite(value)) return false;
		if (typeof value === 'string' && !utf8BytesAtMost(value, MAX_PAYLOAD_STRING_BYTES)) {
			return false;
		}
		state.fields.push({ path, value });
		return state.fields.length <= MAX_DETAIL_PAYLOAD_FIELDS;
	}
	if (typeof value !== 'object') return false;
	if (Array.isArray(value) && value.length > MAX_DETAIL_PAYLOAD_NODES - state.nodes) return false;
	const keys = Array.isArray(value)
		? Array.from({ length: value.length }, (_, index) => String(index))
		: Object.keys(value);
	if (keys.length > MAX_DETAIL_PAYLOAD_NODES - state.nodes) return false;
	for (const key of keys) {
		if (key.length === 0 || !utf8BytesAtMost(key, MAX_PAYLOAD_PATH_COMPONENT_BYTES)) return false;
		const keyBytes = new TextEncoder().encode(key).byteLength;
		const nextPathBytes = pathBytes + keyBytes;
		if (nextPathBytes > MAX_PAYLOAD_PATH_BYTES) return false;
		const child: unknown = Reflect.get(value, key);
		if (!flattenPayloadValue(child, [...path, key], nextPathBytes, depth + 1, state)) {
			return false;
		}
	}
	return true;
}

/** Flattens a stored Google payload into inert leaf values, or refuses overly complex ones. */
export function safePayload(payload: unknown): SafePayload {
	let serialized: string;
	try {
		serialized = JSON.stringify(payload);
	} catch {
		return { kind: 'unavailable' };
	}
	if (serialized === undefined || !utf8BytesAtMost(serialized, MAX_DETAIL_PAYLOAD_BYTES)) {
		return { kind: 'unavailable' };
	}
	const state: { nodes: number; fields: PayloadLeaf[] } = { nodes: 0, fields: [] };
	return flattenPayloadValue(payload, [], 0, 0, state)
		? { kind: 'fields', fields: state.fields }
		: { kind: 'unavailable' };
}

function safeSourceField(value: string | null): string | null {
	return value !== null && utf8BytesAtMost(value, MAX_SOURCE_FIELD_BYTES) ? value : null;
}

function detailRecord(point: PointRow): DetailRecord {
	const metadata = metricMetadata(point.dataType);
	return {
		provider: 'google_health',
		dataType: point.dataType,
		category: metadata.category,
		recordTimestamp: point.recordTimestamp.getTime(),
		startTime: point.startTime?.getTime() ?? null,
		endTime: point.endTime?.getTime() ?? null,
		localDate: point.localDate,
		primaryValue: point.primaryValue,
		primaryUnit: metadata.primaryUnit ?? safeSourceField(point.primaryUnit),
		sourcePlatform: safeSourceField(point.sourcePlatform),
		sourceApplication: safeSourceField(point.sourceApplication),
		sourceDevice: safeSourceField(point.sourceDevice),
		recordingMethod: safeSourceField(point.recordingMethod),
		sourceFamily: safeSourceField(point.sourceFamily),
		googleCreateTime: point.googleCreateTime?.getTime() ?? null,
		googleUpdateTime: point.googleUpdateTime?.getTime() ?? null,
		payload: safePayload(point.payload)
	};
}

/** The newest daily summary of every metric the user has imported. */
async function latestSummaries(db: Database, userId: string): Promise<SummaryRow[]> {
	const rows = await db
		.selectDistinctOn([healthDailySummary.dataType])
		.from(healthDailySummary)
		.where(eq(healthDailySummary.userId, userId))
		.orderBy(healthDailySummary.dataType, desc(healthDailySummary.localDate))
		.limit(MAX_PUBLIC_METRIC_TYPES + 1);
	if (rows.length > MAX_PUBLIC_METRIC_TYPES) {
		throw new Error('Too many imported Google Health metric types');
	}
	return rows;
}

export async function listCategories(
	db: Database,
	userId: string
): Promise<{ category: HealthCategory; count: number }[]> {
	const counts = new Map<HealthCategory, number>();
	for (const summary of await latestSummaries(db, userId)) {
		const category = metricMetadata(summary.dataType).category;
		counts.set(category, (counts.get(category) ?? 0) + 1);
	}
	return HEALTH_CATEGORIES.flatMap((category) => {
		const count = counts.get(category) ?? 0;
		return count === 0 ? [] : [{ category, count }];
	});
}

export async function listMetrics(
	db: Database,
	userId: string,
	category: HealthCategory | null
): Promise<CatalogMetric[]> {
	return (await latestSummaries(db, userId))
		.map((summary) => ({
			...metricMetadata(summary.dataType),
			latestSummary: summaryView(summary)
		}))
		.filter((metric) => category === null || metric.category === category)
		.sort((left, right) => compareDataTypes(left.dataType, right.dataType));
}

/**
 * Representative metrics for the health overview, anchored to the newest imported day rather
 * than today so that stale imports still render a meaningful trend.
 */
export async function getOverview(db: Database, userId: string, days: number): Promise<Overview> {
	if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
		throw new Error('Invalid Google Health overview range');
	}
	const latest = await latestSummaries(db, userId);
	if (latest.length === 0) return { anchorDate: null, fromDate: null, toDate: null, metrics: [] };
	const anchorDate = latest.reduce(
		(newest, summary) => (summary.localDate > newest ? summary.localDate : newest),
		latest[0].localDate
	);
	const anchorEpoch = parseLocalDate(anchorDate);
	if (anchorEpoch === null) throw new Error('Invalid stored Google Health summary date');
	const fromDate = formatLocalDate(
		Math.max(MIN_LOCAL_DATE_EPOCH_MS, anchorEpoch - (days - 1) * DAY_MS)
	);
	const selected = [...latest]
		.sort((left, right) => {
			const leftPriority = OVERVIEW_PRIORITY.get(left.dataType) ?? Number.POSITIVE_INFINITY;
			const rightPriority = OVERVIEW_PRIORITY.get(right.dataType) ?? Number.POSITIVE_INFINITY;
			return leftPriority - rightPriority || compareDataTypes(left.dataType, right.dataType);
		})
		.slice(0, 4);
	const metrics = await Promise.all(
		selected.map(async (latestSummary) => ({
			...metricMetadata(latestSummary.dataType),
			latestSummary: summaryView(latestSummary),
			trend: (await summariesBetween(db, userId, latestSummary.dataType, fromDate, anchorDate)).map(
				summaryView
			)
		}))
	);
	return { anchorDate, fromDate, toDate: anchorDate, metrics };
}

async function summariesBetween(
	db: Database,
	userId: string,
	dataType: string,
	fromDate: string,
	toDate: string
): Promise<SummaryRow[]> {
	const rows = await db
		.select()
		.from(healthDailySummary)
		.where(
			and(
				eq(healthDailySummary.userId, userId),
				eq(healthDailySummary.dataType, dataType),
				gte(healthDailySummary.localDate, fromDate),
				lte(healthDailySummary.localDate, toDate)
			)
		)
		.orderBy(healthDailySummary.localDate)
		.limit(MAX_TREND_SUMMARIES + 1);
	if (rows.length > MAX_TREND_SUMMARIES) {
		throw new Error('Too many Google Health summaries in range');
	}
	return rows;
}

export async function getMetricTrend(
	db: Database,
	userId: string,
	args: { dataType: string; fromDate: string; toDate: string }
): Promise<MetricTrend> {
	assertDataType(args.dataType);
	assertDateRange(args.fromDate, args.toDate);
	const [latest] = await db
		.select({ localDate: healthDailySummary.localDate })
		.from(healthDailySummary)
		.where(
			and(eq(healthDailySummary.userId, userId), eq(healthDailySummary.dataType, args.dataType))
		)
		.limit(1);
	if (latest === undefined) return { kind: 'not_found' };
	const summaries = await summariesBetween(db, userId, args.dataType, args.fromDate, args.toDate);
	return {
		kind: 'found',
		metric: metricMetadata(args.dataType),
		summaries: summaries.map(summaryView)
	};
}

/** Newest records of one metric, paginated by (timestamp, id) for stable ordering. */
export async function listMetricRecords(
	db: Database,
	userId: string,
	args: { dataType: string; limit: number; after: RecordsCursor | null }
): Promise<RecordsPage> {
	assertDataType(args.dataType);
	if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > MAX_RECORDS_PAGE_SIZE) {
		throw new Error('Invalid Google Health page size');
	}
	const after = args.after;
	const rows = await db
		.select()
		.from(healthDataPoint)
		.where(
			and(
				eq(healthDataPoint.userId, userId),
				eq(healthDataPoint.dataType, args.dataType),
				after === null
					? undefined
					: or(
							lt(healthDataPoint.recordTimestamp, new Date(after.timestamp)),
							and(
								eq(healthDataPoint.recordTimestamp, new Date(after.timestamp)),
								sql`${healthDataPoint.id} < ${after.id}::uuid`
							)
						)
			)
		)
		.orderBy(desc(healthDataPoint.recordTimestamp), desc(healthDataPoint.id))
		.limit(args.limit + 1);
	const page = rows.slice(0, args.limit);
	const last = page.at(-1);
	return {
		records: page.map(detailRecord),
		nextCursor:
			rows.length > args.limit && last !== undefined
				? { timestamp: last.recordTimestamp.getTime(), id: last.id }
				: null
	};
}
