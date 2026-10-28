import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from './db/types';
import { sleepRecord } from './db/schema';

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
}

const MAX_LISTED_RECORDS = 10_000;

/**
 * Imports Sleep Cycle records. Nights are deduplicated by wake-up time per user, so the same
 * export can be imported repeatedly.
 */
export async function importSleepRecords(
	db: Database,
	userId: string,
	records: readonly SleepRecordInput[]
): Promise<{ imported: number; skipped: number }> {
	if (records.length === 0) return { imported: 0, skipped: 0 };
	const inserted = await db
		.insert(sleepRecord)
		.values(
			records.map((record) => ({
				...record,
				userId,
				wentToBed: new Date(record.wentToBed),
				wokeUp: new Date(record.wokeUp)
			}))
		)
		.onConflictDoNothing({ target: [sleepRecord.userId, sleepRecord.wokeUp] })
		.returning({ id: sleepRecord.id });
	return { imported: inserted.length, skipped: records.length - inserted.length };
}

/**
 * Lists the user's most recent nights, oldest first, dated in `timeZone`. Only the columns the
 * dashboard reads are selected, since every night is sent to the browser.
 */
export async function listNights(
	db: Database,
	userId: string,
	timeZone: string
): Promise<SleepNight[]> {
	const rows = await db
		.select({
			night: sql<string>`to_char((${sleepRecord.wentToBed} at time zone ${timeZone}::text) - interval '5 hours', 'YYYY-MM-DD')`,
			wokeUp: sleepRecord.wokeUp,
			sleepQuality: sleepRecord.sleepQuality,
			timeInBedSeconds: sleepRecord.timeInBedSeconds,
			timeAsleepSeconds: sleepRecord.timeAsleepSeconds,
			notes: sleepRecord.notes
		})
		.from(sleepRecord)
		.where(eq(sleepRecord.userId, userId))
		.orderBy(desc(sleepRecord.wokeUp))
		.limit(MAX_LISTED_RECORDS);
	return rows.reverse().map((row) => ({ ...row, wokeUp: row.wokeUp.getTime() }));
}

export async function removeAllSleepRecords(db: Database, userId: string): Promise<void> {
	await db.delete(sleepRecord).where(eq(sleepRecord.userId, userId));
}
