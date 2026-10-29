import { and, eq, getTableColumns, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Executor } from '../db/types';
import { googleHealthRecordTombstone, healthDailySummary, healthDataPoint } from '../db/schema';
import { canonicalJson, sha256Base64Url } from './normalize';
import { getMetricDefinition } from './registry';
import { googleSleepDurations } from './sleep-durations';
import type { HealthCategory, NormalizedHealthPoint } from './types';

// node-postgres allows 65 535 bind parameters per statement; a point uses 32 of them.
const WRITE_CHUNK_SIZE = 500;

// Every column except the conflict target and primary key is replaced by the incoming row.
const UPSERT_SET = Object.fromEntries(
	Object.entries(getTableColumns(healthDataPoint))
		.filter(([key]) => key !== 'id' && key !== 'userId' && key !== 'recordKey')
		.map(([key, column]) => [key, sql.raw(`excluded."${column.name}"`)])
);

export interface PointOwner {
	connectionId: string;
	userId: string;
	generation: number;
}

export interface ApplyPointsResult {
	inserted: number;
	updated: number;
	skipped: number;
	affectedDates: Set<string>;
}

export type CoveredRange =
	| { kind: 'physical'; startKey: string; endKeyExclusive: string }
	| { kind: 'civil'; startDate: string; endDateExclusive: string };

function chunks<T>(items: readonly T[], size = WRITE_CHUNK_SIZE): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		result.push(items.slice(index, index + size));
	}
	return result;
}

function toRow(owner: PointOwner, point: NormalizedHealthPoint, syncId: string, seenEpoch: number) {
	const date = (value: number | undefined) => (value === undefined ? null : new Date(value));
	const payload = JSON.parse(point.payloadJson) as unknown;
	const sleep = point.dataType === 'sleep' ? googleSleepDurations(payload) : null;
	return {
		connectionId: owner.connectionId,
		userId: owner.userId,
		provider: point.provider,
		recordKey: point.recordKey,
		googleDataPointName: point.googleDataPointName ?? null,
		dataType: point.dataType,
		category: point.category,
		recordTimestamp: new Date(point.recordTimestamp),
		startTime: date(point.startTime),
		endTime: date(point.endTime),
		localDate: point.localDate,
		physicalCoverageKey: point.physicalCoverageKey ?? null,
		civilCoverageTime: point.civilCoverageTime ?? null,
		primaryValue: point.primaryValue ?? null,
		primaryUnit: point.primaryUnit ?? null,
		sourcePlatform: point.sourcePlatform ?? null,
		sourceApplication: point.sourceApplication ?? null,
		sourceDevice: point.sourceDevice ?? null,
		recordingMethod: point.recordingMethod ?? null,
		sourceFamily: point.sourceFamily ?? null,
		googleCreateTime: date(point.googleCreateTime),
		googleUpdateTime: date(point.googleUpdateTime),
		payloadDigest: point.payloadDigest,
		payload,
		sleepInBedSeconds: sleep?.inBedSeconds ?? null,
		sleepAwakeSeconds: sleep?.awakeSeconds ?? null,
		sleepDeepSeconds: sleep?.deepSeconds ?? null,
		sleepLightSeconds: sleep?.lightSeconds ?? null,
		sleepRemSeconds: sleep?.remSeconds ?? null,
		sleepDurationsParsed: point.dataType === 'sleep',
		seenEpoch,
		lastSeenSyncId: syncId
	};
}

/**
 * Idempotently upserts one page of normalized points for a connection. Records deleted through a
 * webhook stay deleted for reconciliation passes that may have fetched them before the deletion,
 * and an older pass never overwrites what a newer one stored.
 */
export async function applyPoints(
	tx: Executor,
	owner: PointOwner,
	dataType: string,
	points: readonly NormalizedHealthPoint[],
	options: { syncId: string; seenEpoch: number }
): Promise<ApplyPointsResult> {
	const result: ApplyPointsResult = {
		inserted: 0,
		updated: 0,
		skipped: 0,
		affectedDates: new Set()
	};
	const definition = getMetricDefinition(dataType);
	if (definition === null) throw new Error('unsupported Google Health data type');
	const byKey = new Map<string, NormalizedHealthPoint>();
	for (const point of points) {
		if (point.dataType !== dataType || point.category !== definition.category) {
			throw new Error('Google Health point does not match its data type');
		}
		if (byKey.has(point.recordKey)) result.skipped += 1;
		byKey.set(point.recordKey, point);
	}

	for (const batch of chunks([...byKey.values()])) {
		const keys = batch.map((point) => point.recordKey);
		const tombstones = await tx
			.select({
				recordKey: googleHealthRecordTombstone.recordKey,
				blockedThroughEpoch: googleHealthRecordTombstone.blockedThroughEpoch
			})
			.from(googleHealthRecordTombstone)
			.where(
				and(
					eq(googleHealthRecordTombstone.connectionId, owner.connectionId),
					eq(googleHealthRecordTombstone.generation, owner.generation),
					inArray(googleHealthRecordTombstone.recordKey, keys)
				)
			);
		const blocked = new Set<string>();
		const expired: string[] = [];
		for (const tombstone of tombstones) {
			if (options.seenEpoch <= tombstone.blockedThroughEpoch) blocked.add(tombstone.recordKey);
			else expired.push(tombstone.recordKey);
		}
		if (expired.length > 0) {
			await tx
				.delete(googleHealthRecordTombstone)
				.where(
					and(
						eq(googleHealthRecordTombstone.connectionId, owner.connectionId),
						eq(googleHealthRecordTombstone.generation, owner.generation),
						inArray(googleHealthRecordTombstone.recordKey, expired)
					)
				);
		}

		const existingRows = await tx
			.select({
				id: healthDataPoint.id,
				recordKey: healthDataPoint.recordKey,
				connectionId: healthDataPoint.connectionId,
				dataType: healthDataPoint.dataType,
				localDate: healthDataPoint.localDate,
				payloadDigest: healthDataPoint.payloadDigest,
				seenEpoch: healthDataPoint.seenEpoch
			})
			.from(healthDataPoint)
			.where(
				and(eq(healthDataPoint.userId, owner.userId), inArray(healthDataPoint.recordKey, keys))
			);
		const existing = new Map(existingRows.map((row) => [row.recordKey, row]));

		const writes: ReturnType<typeof toRow>[] = [];
		const touched: string[] = [];
		for (const point of batch) {
			if (blocked.has(point.recordKey)) {
				result.skipped += 1;
				continue;
			}
			const current = existing.get(point.recordKey);
			if (current === undefined) {
				writes.push(toRow(owner, point, options.syncId, options.seenEpoch));
				result.inserted += 1;
				result.affectedDates.add(point.localDate);
				continue;
			}
			if (current.connectionId !== owner.connectionId || current.dataType !== dataType) {
				throw new Error('Google Health record key ownership conflict');
			}
			if (current.seenEpoch > options.seenEpoch) {
				result.skipped += 1;
				continue;
			}
			if (current.payloadDigest === point.payloadDigest) {
				touched.push(current.id);
				result.skipped += 1;
				continue;
			}
			writes.push(toRow(owner, point, options.syncId, options.seenEpoch));
			result.updated += 1;
			result.affectedDates.add(current.localDate);
			result.affectedDates.add(point.localDate);
		}

		if (touched.length > 0) {
			await tx
				.update(healthDataPoint)
				.set({ seenEpoch: options.seenEpoch, lastSeenSyncId: options.syncId })
				.where(inArray(healthDataPoint.id, touched));
		}
		if (writes.length > 0) {
			await tx
				.insert(healthDataPoint)
				.values(writes)
				.onConflictDoUpdate({
					target: [healthDataPoint.userId, healthDataPoint.recordKey],
					set: UPSERT_SET
				});
		}
	}
	return result;
}

/**
 * Deletes the points of a fully reconciled window that the completed pass did not see, which is
 * how corrections and provider-side deletions without a stable record name are applied.
 */
export async function deleteUnseenInRange(
	tx: Executor,
	owner: PointOwner,
	dataType: string,
	range: CoveredRange,
	cleanupEpoch: number
): Promise<{ deleted: number; affectedDates: Set<string> }> {
	const rangeFilter =
		range.kind === 'physical'
			? and(
					gte(healthDataPoint.physicalCoverageKey, range.startKey),
					lt(healthDataPoint.physicalCoverageKey, range.endKeyExclusive)
				)
			: and(
					gte(healthDataPoint.civilCoverageTime, range.startDate),
					lt(healthDataPoint.civilCoverageTime, range.endDateExclusive)
				);
	const deleted = await tx
		.delete(healthDataPoint)
		.where(
			and(
				eq(healthDataPoint.connectionId, owner.connectionId),
				eq(healthDataPoint.dataType, dataType),
				lt(healthDataPoint.seenEpoch, cleanupEpoch),
				rangeFilter
			)
		)
		.returning({ localDate: healthDataPoint.localDate });
	return {
		deleted: deleted.length,
		affectedDates: new Set(deleted.map((row) => row.localDate))
	};
}

export function namedRecordKey(dataType: string, googleDataPointName: string): string {
	return sha256Base64Url(
		`${dataType}\n${canonicalJson({ kind: 'named', name: googleDataPointName })}`
	);
}

/**
 * Deletes identifiable records reported deleted by a webhook and blocks any in-flight
 * reconciliation pass from re-importing them. Returns whether a local record or tombstone matched.
 */
export async function deleteNamedPoints(
	tx: Executor,
	owner: PointOwner & { reconciliationEpoch: number },
	dataType: string,
	googleDataPointNames: readonly string[]
): Promise<boolean> {
	const keys = [...new Set(googleDataPointNames)].map((name) => namedRecordKey(dataType, name));
	if (keys.length === 0) return false;
	const existingTombstones = await tx
		.select({ recordKey: googleHealthRecordTombstone.recordKey })
		.from(googleHealthRecordTombstone)
		.where(
			and(
				eq(googleHealthRecordTombstone.connectionId, owner.connectionId),
				eq(googleHealthRecordTombstone.generation, owner.generation),
				inArray(googleHealthRecordTombstone.recordKey, keys)
			)
		);
	const deleted = await tx
		.delete(healthDataPoint)
		.where(
			and(
				eq(healthDataPoint.userId, owner.userId),
				eq(healthDataPoint.connectionId, owner.connectionId),
				eq(healthDataPoint.dataType, dataType),
				inArray(healthDataPoint.recordKey, keys)
			)
		)
		.returning({ recordKey: healthDataPoint.recordKey, localDate: healthDataPoint.localDate });
	const tombstoneKeys = new Set([
		...existingTombstones.map((row) => row.recordKey),
		...deleted.map((row) => row.recordKey)
	]);
	if (tombstoneKeys.size === 0) return false;
	await tx
		.insert(googleHealthRecordTombstone)
		.values(
			[...tombstoneKeys].map((recordKey) => ({
				connectionId: owner.connectionId,
				generation: owner.generation,
				recordKey,
				dataType,
				blockedThroughEpoch: owner.reconciliationEpoch
			}))
		)
		.onConflictDoUpdate({
			target: [
				googleHealthRecordTombstone.connectionId,
				googleHealthRecordTombstone.generation,
				googleHealthRecordTombstone.recordKey
			],
			set: {
				blockedThroughEpoch: sql`greatest(${googleHealthRecordTombstone.blockedThroughEpoch}, excluded.blocked_through_epoch)`,
				updatedAt: new Date()
			}
		});
	await rebuildDailySummaries(tx, owner, dataType, new Set(deleted.map((row) => row.localDate)));
	return true;
}

/** Clears tombstones for identifiable records that Google reports as re-created. */
export async function clearNamedTombstones(
	tx: Executor,
	owner: PointOwner,
	dataType: string,
	googleDataPointNames: readonly string[]
): Promise<void> {
	const keys = [...new Set(googleDataPointNames)].map((name) => namedRecordKey(dataType, name));
	if (keys.length === 0) return;
	await tx
		.delete(googleHealthRecordTombstone)
		.where(
			and(
				eq(googleHealthRecordTombstone.connectionId, owner.connectionId),
				eq(googleHealthRecordTombstone.generation, owner.generation),
				inArray(googleHealthRecordTombstone.recordKey, keys)
			)
		);
}

/**
 * Recomputes the chart-ready daily summaries of the given local dates from the stored points.
 * Dates without remaining points lose their summary row.
 */
export async function rebuildDailySummaries(
	tx: Executor,
	owner: Pick<PointOwner, 'connectionId' | 'userId'>,
	dataType: string,
	localDates: ReadonlySet<string>
): Promise<void> {
	if (localDates.size === 0) return;
	const dates = [...localDates];
	const category: HealthCategory = getMetricDefinition(dataType)?.category ?? 'other';
	const point = healthDataPoint;
	await tx.execute(sql`
		insert into ${healthDailySummary} (
			user_id, data_type, local_date, connection_id, category, count, latest_value,
			latest_timestamp, sum, average, min, max, duration_seconds, computed_at
		)
		select
			${point.userId}, ${point.dataType}, ${point.localDate}, ${owner.connectionId}::uuid,
			${category}::text,
			count(*)::int,
			(array_agg(${point.primaryValue} order by ${point.recordTimestamp} desc, ${point.id} desc))[1],
			max(${point.recordTimestamp}),
			sum(${point.primaryValue}),
			avg(${point.primaryValue}),
			min(${point.primaryValue}),
			max(${point.primaryValue}),
			nullif(
				coalesce(
					sum(extract(epoch from (${point.endTime} - ${point.startTime})))
						filter (where ${point.endTime} >= ${point.startTime}),
					0
				),
				0
			)::float8,
			now()
		from ${point}
		where ${point.userId} = ${owner.userId}
			and ${point.dataType} = ${dataType}
			and ${point.localDate} in (${sql.join(
				dates.map((date) => sql`${date}::date`),
				sql`, `
			)})
		group by ${point.userId}, ${point.dataType}, ${point.localDate}
		on conflict (user_id, data_type, local_date) do update set
			connection_id = excluded.connection_id,
			category = excluded.category,
			count = excluded.count,
			latest_value = excluded.latest_value,
			latest_timestamp = excluded.latest_timestamp,
			sum = excluded.sum,
			average = excluded.average,
			min = excluded.min,
			max = excluded.max,
			duration_seconds = excluded.duration_seconds,
			computed_at = excluded.computed_at
	`);
	await tx.execute(sql`
		delete from ${healthDailySummary} summary
		where summary.user_id = ${owner.userId}
			and summary.data_type = ${dataType}
			and summary.local_date in (${sql.join(
				dates.map((date) => sql`${date}::date`),
				sql`, `
			)})
			and not exists (
				select 1 from ${point}
				where ${point.userId} = summary.user_id
					and ${point.dataType} = summary.data_type
					and ${point.localDate} = summary.local_date
			)
	`);
}
