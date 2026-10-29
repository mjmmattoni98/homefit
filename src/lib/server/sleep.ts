import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from './db/types';
import { healthDataPoint, sleepRecord } from './db/schema';

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
	didSnore?: boolean;
	snoreTimeSeconds?: number;
	movementsPerHour?: number;
	mood?: string;
	steps?: number;
	weatherTempC?: number;
	city?: string;
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
			wentToBed: sleepRecord.wentToBed,
			wokeUp: sleepRecord.wokeUp,
			sleepQuality: sleepRecord.sleepQuality,
			timeInBedSeconds: sleepRecord.timeInBedSeconds,
			timeAsleepSeconds: sleepRecord.timeAsleepSeconds,
			asleepAfterSeconds: sleepRecord.asleepAfterSeconds,
			regularity: sleepRecord.regularity,
			didSnore: sleepRecord.didSnore,
			snoreTimeSeconds: sleepRecord.snoreTimeSeconds,
			movementsPerHour: sleepRecord.movementsPerHour,
			mood: sleepRecord.mood,
			steps: sleepRecord.steps,
			weatherTempC: sleepRecord.weatherTempC,
			city: sleepRecord.city,
			notes: sleepRecord.notes
		})
		.from(sleepRecord)
		.where(eq(sleepRecord.userId, userId))
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
		didSnore: row.didSnore,
		snoreTimeSeconds: row.snoreTimeSeconds,
		movementsPerHour: row.movementsPerHour ?? undefined,
		mood: row.mood ?? undefined,
		steps: row.steps ?? undefined,
		weatherTempC: row.weatherTempC ?? undefined,
		city: row.city ?? undefined,
		notes: row.notes
	}));
}

function readNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function parseGoogleSleepStages(payload: unknown): {
	minutesInBed: number | null;
	minutesAwake: number | null;
	deepSeconds: number | null;
	lightSeconds: number | null;
	remSeconds: number | null;
} {
	if (typeof payload !== 'object' || payload === null) {
		return {
			minutesInBed: null,
			minutesAwake: null,
			deepSeconds: null,
			lightSeconds: null,
			remSeconds: null
		};
	}
	const summary = Reflect.get(payload, 'summary');
	let minutesInBed: number | null = null;
	let minutesAwake: number | null = null;
	let deepSeconds: number | null = null;
	let lightSeconds: number | null = null;
	let remSeconds: number | null = null;

	if (typeof summary === 'object' && summary !== null) {
		minutesInBed = readNumber(Reflect.get(summary, 'minutesInBed'));
		minutesAwake = readNumber(Reflect.get(summary, 'minutesAwake'));
		const deep = readNumber(
			Reflect.get(summary, 'minutesDeep') ?? Reflect.get(summary, 'deepMinutes')
		);
		const light = readNumber(
			Reflect.get(summary, 'minutesLight') ?? Reflect.get(summary, 'lightMinutes')
		);
		const rem = readNumber(
			Reflect.get(summary, 'minutesRem') ?? Reflect.get(summary, 'remMinutes')
		);
		if (deep !== null) deepSeconds = deep * 60;
		if (light !== null) lightSeconds = light * 60;
		if (rem !== null) remSeconds = rem * 60;
	}

	const stages = Reflect.get(payload, 'stages');
	if (Array.isArray(stages) && stages.length <= 256) {
		let awake = 0;
		let deep = 0;
		let light = 0;
		let rem = 0;
		let hasStage = false;
		for (const item of stages) {
			if (typeof item !== 'object' || item === null) continue;
			const stageType = String(
				Reflect.get(item, 'type') ?? Reflect.get(item, 'stage') ?? ''
			).toUpperCase();
			const startRaw = Reflect.get(item, 'startTime');
			const endRaw = Reflect.get(item, 'endTime');
			const startMs = typeof startRaw === 'string' ? Date.parse(startRaw) : NaN;
			const endMs = typeof endRaw === 'string' ? Date.parse(endRaw) : NaN;
			const seconds =
				Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
					? (endMs - startMs) / 1000
					: (readNumber(Reflect.get(item, 'minutes')) ?? 0) * 60;
			if (seconds <= 0) continue;
			if (stageType.includes('AWAKE') || stageType.includes('WAKE')) {
				awake += seconds;
				hasStage = true;
			} else if (stageType.includes('DEEP')) {
				deep += seconds;
				hasStage = true;
			} else if (stageType.includes('LIGHT')) {
				light += seconds;
				hasStage = true;
			} else if (stageType.includes('REM')) {
				rem += seconds;
				hasStage = true;
			}
		}
		if (hasStage) {
			if (minutesAwake === null && awake > 0) minutesAwake = awake / 60;
			if (deepSeconds === null && deep > 0) deepSeconds = deep;
			if (lightSeconds === null && light > 0) lightSeconds = light;
			if (remSeconds === null && rem > 0) remSeconds = rem;
		}
	}

	return { minutesInBed, minutesAwake, deepSeconds, lightSeconds, remSeconds };
}

/**
 * Lists sleep sessions imported from Google Health, oldest first, dated by the same 5 AM evening
 * rule as Sleep Cycle so overlapping nights align even when one source starts just before midnight
 * and the other just after.
 */
export async function listGoogleSleepNights(
	db: Database,
	userId: string,
	timeZone: string
): Promise<GoogleSleepNight[]> {
	const startExpr = sql`coalesce(${healthDataPoint.startTime}, ${healthDataPoint.recordTimestamp})`;
	const rows = await db
		.select({
			night: sql<string>`to_char((${startExpr} at time zone ${timeZone}::text) - interval '5 hours', 'YYYY-MM-DD')`,
			recordTimestamp: healthDataPoint.recordTimestamp,
			startTime: healthDataPoint.startTime,
			endTime: healthDataPoint.endTime,
			primaryValue: healthDataPoint.primaryValue,
			sourceApplication: healthDataPoint.sourceApplication,
			sourceDevice: healthDataPoint.sourceDevice,
			payload: healthDataPoint.payload
		})
		.from(healthDataPoint)
		.where(and(eq(healthDataPoint.userId, userId), eq(healthDataPoint.dataType, 'sleep')))
		.orderBy(desc(healthDataPoint.recordTimestamp))
		.limit(MAX_LISTED_RECORDS);

	return rows.reverse().flatMap((row) => {
		const startTime = (row.startTime ?? row.recordTimestamp).getTime();
		const parsed = parseGoogleSleepStages(row.payload);
		const endTime =
			row.endTime?.getTime() ??
			(parsed.minutesInBed !== null
				? startTime + parsed.minutesInBed * 60_000
				: row.primaryValue !== null
					? startTime + row.primaryValue * 60_000
					: startTime);
		const spanSeconds = Math.max(0, (endTime - startTime) / 1000);
		const timeInBedSeconds =
			parsed.minutesInBed !== null && parsed.minutesInBed > 0
				? parsed.minutesInBed * 60
				: spanSeconds;
		const asleepFromMinutes =
			row.primaryValue !== null && row.primaryValue > 0 ? row.primaryValue * 60 : null;
		const timeAsleepSeconds =
			asleepFromMinutes ??
			(parsed.minutesAwake !== null && timeInBedSeconds > parsed.minutesAwake * 60
				? timeInBedSeconds - parsed.minutesAwake * 60
				: spanSeconds);
		if (timeAsleepSeconds <= 0 && timeInBedSeconds <= 0) return [];
		return [
			{
				night: row.night,
				startTime,
				endTime,
				timeInBedSeconds: Math.max(timeInBedSeconds, timeAsleepSeconds),
				timeAsleepSeconds,
				awakeSeconds: parsed.minutesAwake !== null ? parsed.minutesAwake * 60 : undefined,
				deepSeconds: parsed.deepSeconds ?? undefined,
				lightSeconds: parsed.lightSeconds ?? undefined,
				remSeconds: parsed.remSeconds ?? undefined,
				sourceApplication: row.sourceApplication ?? undefined,
				sourceDevice: row.sourceDevice ?? undefined
			}
		];
	});
}

export async function removeAllSleepRecords(db: Database, userId: string): Promise<void> {
	await db.delete(sleepRecord).where(eq(sleepRecord.userId, userId));
}
