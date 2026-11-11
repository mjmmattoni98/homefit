import { and, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Database } from './db/types';
import { healthDataPoint, sleepRecord, user } from './db/schema';

export interface SleepRecordInput {
	wentToBed: number;
	wokeUp: number;
	sleepQuality: number;
	timeInBedSeconds: number;
	timeAsleepSeconds: number;
	asleepAfterSeconds: number;
	regularity?: number;
	didSnore: boolean;
	snoreTimeSeconds: number;
	steps?: number;
	weatherTempC?: number;
	weatherType?: string;
	city?: string;
	movementsPerHour?: number;
	notes: string[];
	mood?: string;
}

/** A night as the dashboard uses it: only the fields its statistics and charts read. */
export interface SleepNight extends Pick<
	SleepRecordInput,
	'wokeUp' | 'sleepQuality' | 'timeInBedSeconds' | 'timeAsleepSeconds' | 'notes'
> {
	/**
	 * Local date (`YYYY-MM-DD`) of the evening the night began. Bedtimes before 5 AM belong to the
	 * previous evening, so a late night still pairs with that day's workout.
	 */
	night: string;
	wentToBed?: number;
	asleepAfterSeconds?: number;
	regularity?: number;
	snoreTimeSeconds?: number;
	movementsPerHour?: number;
	city?: string;
}

/** Inclusive local dates (`YYYY-MM-DD`) of the evening a night began. */
export interface NightRange {
	from: string;
	to: string;
}

/** A sleep session imported from Google Health, dated by the same 5 AM evening rule. */
export interface GoogleSleepNight {
	night: string;
	startTime: number;
	endTime: number;
	timeInBedSeconds: number;
	timeAsleepSeconds: number;
	awakeSeconds?: number;
	deepSeconds?: number;
	lightSeconds?: number;
	remSeconds?: number;
	sourceApplication?: string;
	sourceDevice?: string;
}

const MAX_LISTED_RECORDS = 10_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string): void {
	if (!ISO_DATE.test(value)) throw new Error('Invalid night date');
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	const date = new Date(Date.UTC(year, month - 1, day));
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		throw new Error('Invalid night date');
	}
}

/** Timestamp bounds wide enough to cover the evening-date window in any offset, for the index. */
function indexedNightBounds(timeZone: string, range: NightRange) {
	assertIsoDate(range.from);
	assertIsoDate(range.to);
	return {
		start: sql`(${range.from}::timestamp at time zone ${timeZone}::text) - interval '2 days'`,
		end: sql`(${range.to}::timestamp at time zone ${timeZone}::text) + interval '3 days'`
	};
}

/** Rows per insert statement, keeping each one well under PostgreSQL's bind-parameter limit. */
const INSERT_CHUNK = 2_000;

/**
 * Imports Sleep Cycle records. A night is identified by its wake-up time per user, so the same
 * export can be imported repeatedly: unchanged nights are skipped and edited ones are updated.
 */
export async function importSleepRecords(
	db: Database,
	userId: string,
	records: readonly SleepRecordInput[]
): Promise<{ imported: number; updated: number; skipped: number }> {
	return db.transaction(async (tx) => {
		await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update');
		const result = { imported: 0, updated: 0, skipped: 0 };
		if (records.length === 0) return result;
		const stored = await tx
			.select()
			.from(sleepRecord)
			.where(
				and(
					eq(sleepRecord.userId, userId),
					inArray(
						sleepRecord.wokeUp,
						records.map((r) => new Date(r.wokeUp))
					)
				)
			);
		type Values = Omit<typeof sleepRecord.$inferInsert, 'id' | 'createdAt'>;
		const byWake = new Map<number, Values & { id?: string }>(
			stored.map(({ createdAt: _createdAt, ...row }) => [row.wokeUp.getTime(), row])
		);
		const inserts = new Map<number, Values>();
		const updates = new Map<string, Values>();
		for (const record of records) {
			const values: Values = {
				...record,
				userId,
				wentToBed: new Date(record.wentToBed),
				wokeUp: new Date(record.wokeUp),
				regularity: record.regularity ?? null,
				steps: record.steps ?? null,
				weatherTempC: record.weatherTempC ?? null,
				weatherType: record.weatherType ?? null,
				city: record.city ?? null,
				movementsPerHour: record.movementsPerHour ?? null,
				mood: record.mood ?? null
			};
			const existing = byWake.get(record.wokeUp);
			if (existing === undefined) {
				inserts.set(record.wokeUp, values);
				result.imported++;
			} else if (
				Object.entries(values).every(
					([key, value]) => JSON.stringify(value) === JSON.stringify(existing[key as keyof Values])
				)
			) {
				result.skipped++;
				continue;
			} else {
				// A night repeated in the batch corrects the row this batch is about to insert.
				if (existing.id === undefined) inserts.set(record.wokeUp, values);
				else updates.set(existing.id, values);
				result.updated++;
			}
			byWake.set(record.wokeUp, { ...values, id: existing?.id });
		}
		const rows = [...inserts.values()];
		for (let i = 0; i < rows.length; i += INSERT_CHUNK)
			await tx.insert(sleepRecord).values(rows.slice(i, i + INSERT_CHUNK));
		for (const [id, values] of updates)
			await tx.update(sleepRecord).set(values).where(eq(sleepRecord.id, id));
		return result;
	});
}

/**
 * Lists the user's most recent nights, oldest first, dated in `timeZone`. Only the columns the
 * dashboard reads are selected, since every night is sent to the browser.
 */
export async function listNights(
	db: Database,
	userId: string,
	timeZone: string,
	range?: NightRange
): Promise<SleepNight[]> {
	const night = sql<string>`to_char((${sleepRecord.wentToBed} at time zone ${timeZone}::text) - interval '5 hours', 'YYYY-MM-DD')`;
	const bounds = range === undefined ? undefined : indexedNightBounds(timeZone, range);
	const rows = await db
		.select({
			night,
			wentToBed: sleepRecord.wentToBed,
			wokeUp: sleepRecord.wokeUp,
			sleepQuality: sleepRecord.sleepQuality,
			timeInBedSeconds: sleepRecord.timeInBedSeconds,
			timeAsleepSeconds: sleepRecord.timeAsleepSeconds,
			asleepAfterSeconds: sleepRecord.asleepAfterSeconds,
			regularity: sleepRecord.regularity,
			snoreTimeSeconds: sleepRecord.snoreTimeSeconds,
			movementsPerHour: sleepRecord.movementsPerHour,
			city: sleepRecord.city,
			notes: sleepRecord.notes
		})
		.from(sleepRecord)
		.where(
			and(
				eq(sleepRecord.userId, userId),
				bounds === undefined ? undefined : gte(sleepRecord.wokeUp, bounds.start),
				bounds === undefined ? undefined : lt(sleepRecord.wokeUp, bounds.end),
				range === undefined ? undefined : gte(night, range.from),
				range === undefined ? undefined : lte(night, range.to)
			)
		)
		.orderBy(desc(sleepRecord.wokeUp))
		.limit(MAX_LISTED_RECORDS);
	return rows.reverse().map((row) => ({
		night: row.night,
		wentToBed: row.wentToBed.getTime(),
		wokeUp: row.wokeUp.getTime(),
		sleepQuality: row.sleepQuality,
		timeInBedSeconds: row.timeInBedSeconds,
		timeAsleepSeconds: row.timeAsleepSeconds,
		asleepAfterSeconds: row.asleepAfterSeconds,
		regularity: row.regularity ?? undefined,
		snoreTimeSeconds: row.snoreTimeSeconds,
		movementsPerHour: row.movementsPerHour ?? undefined,
		city: row.city ?? undefined,
		notes: row.notes
	}));
}

/**
 * Lists sleep sessions imported from Google Health, oldest first, dated by the same 5 AM evening
 * rule as Sleep Cycle so overlapping nights align even when one source starts just before midnight
 * and the other just after. Stage totals come from columns filled at import, not the JSON payload.
 */
export async function listGoogleSleepNights(
	db: Database,
	userId: string,
	timeZone: string,
	range?: NightRange
): Promise<GoogleSleepNight[]> {
	const startExpr = sql`coalesce(${healthDataPoint.startTime}, ${healthDataPoint.recordTimestamp})`;
	const night = sql<string>`to_char((${startExpr} at time zone ${timeZone}::text) - interval '5 hours', 'YYYY-MM-DD')`;
	const bounds = range === undefined ? undefined : indexedNightBounds(timeZone, range);
	const rows = await db
		.select({
			night,
			recordTimestamp: healthDataPoint.recordTimestamp,
			startTime: healthDataPoint.startTime,
			endTime: healthDataPoint.endTime,
			primaryValue: healthDataPoint.primaryValue,
			sourceApplication: healthDataPoint.sourceApplication,
			sourceDevice: healthDataPoint.sourceDevice,
			sleepInBedSeconds: healthDataPoint.sleepInBedSeconds,
			sleepAwakeSeconds: healthDataPoint.sleepAwakeSeconds,
			sleepDeepSeconds: healthDataPoint.sleepDeepSeconds,
			sleepLightSeconds: healthDataPoint.sleepLightSeconds,
			sleepRemSeconds: healthDataPoint.sleepRemSeconds
		})
		.from(healthDataPoint)
		.where(
			and(
				eq(healthDataPoint.userId, userId),
				eq(healthDataPoint.dataType, 'sleep'),
				bounds === undefined ? undefined : gte(healthDataPoint.recordTimestamp, bounds.start),
				bounds === undefined ? undefined : lt(healthDataPoint.recordTimestamp, bounds.end),
				range === undefined ? undefined : gte(night, range.from),
				range === undefined ? undefined : lte(night, range.to)
			)
		)
		.orderBy(desc(healthDataPoint.recordTimestamp))
		.limit(MAX_LISTED_RECORDS);

	return rows.reverse().flatMap((row) => {
		const startTime = (row.startTime ?? row.recordTimestamp).getTime();
		const endTime =
			row.endTime?.getTime() ??
			(row.sleepInBedSeconds !== null && row.sleepInBedSeconds > 0
				? startTime + row.sleepInBedSeconds * 1000
				: row.primaryValue !== null
					? startTime + row.primaryValue * 60_000
					: startTime);
		const spanSeconds = Math.max(0, (endTime - startTime) / 1000);
		const timeInBedSeconds =
			row.sleepInBedSeconds !== null && row.sleepInBedSeconds > 0
				? row.sleepInBedSeconds
				: spanSeconds;
		const asleepFromMinutes =
			row.primaryValue !== null && row.primaryValue > 0 ? row.primaryValue * 60 : null;
		const timeAsleepSeconds =
			asleepFromMinutes ??
			(row.sleepAwakeSeconds !== null && timeInBedSeconds > row.sleepAwakeSeconds
				? timeInBedSeconds - row.sleepAwakeSeconds
				: spanSeconds);
		if (timeAsleepSeconds <= 0 && timeInBedSeconds <= 0) return [];
		return [
			{
				night: row.night,
				startTime,
				endTime,
				timeInBedSeconds: Math.max(timeInBedSeconds, timeAsleepSeconds),
				timeAsleepSeconds,
				awakeSeconds: row.sleepAwakeSeconds ?? undefined,
				deepSeconds: row.sleepDeepSeconds ?? undefined,
				lightSeconds: row.sleepLightSeconds ?? undefined,
				remSeconds: row.sleepRemSeconds ?? undefined,
				sourceApplication: row.sourceApplication ?? undefined,
				sourceDevice: row.sourceDevice ?? undefined
			}
		];
	});
}

export async function removeAllSleepRecords(db: Database, userId: string): Promise<void> {
	await db.delete(sleepRecord).where(eq(sleepRecord.userId, userId));
}
