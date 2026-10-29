import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/types';
import { healthDataPoint } from '../db/schema';

/** Stage totals copied off a sleep payload so dashboard reads never touch the JSON document. */
export interface GoogleSleepDurations {
	inBedSeconds: number | null;
	awakeSeconds: number | null;
	deepSeconds: number | null;
	lightSeconds: number | null;
	remSeconds: number | null;
}

const EMPTY: GoogleSleepDurations = {
	inBedSeconds: null,
	awakeSeconds: null,
	deepSeconds: null,
	lightSeconds: null,
	remSeconds: null
};

const BACKFILL_BATCH = 200;

function readNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/**
 * Google stores the session under `sleep`. Older rows and fixtures put `summary` at the top.
 * Prefer the nested session when it actually carries stages.
 */
function sleepBody(payload: unknown): unknown {
	if (typeof payload !== 'object' || payload === null) return payload;
	const nested = Reflect.get(payload, 'sleep');
	if (typeof nested !== 'object' || nested === null) return payload;
	if (Reflect.get(nested, 'summary') !== undefined || Reflect.get(nested, 'stages') !== undefined) {
		return nested;
	}
	return payload;
}

/** Seconds in bed and in each stage, or null where the payload does not say. */
export function googleSleepDurations(payload: unknown): GoogleSleepDurations {
	const body = sleepBody(payload);
	if (typeof body !== 'object' || body === null) return EMPTY;

	const summary = Reflect.get(body, 'summary');
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

	const stages = Reflect.get(body, 'stages');
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

	return {
		inBedSeconds: minutesInBed === null ? null : minutesInBed * 60,
		awakeSeconds: minutesAwake === null ? null : minutesAwake * 60,
		deepSeconds,
		lightSeconds,
		remSeconds
	};
}

/**
 * Fills stage columns for sleep rows imported before those columns existed. New writes set the
 * columns themselves, so this only touches rows still marked unparsed.
 */
export async function backfillSleepDurations(db: Database): Promise<number> {
	let updated = 0;
	for (;;) {
		const rows = await db
			.select({ id: healthDataPoint.id, payload: healthDataPoint.payload })
			.from(healthDataPoint)
			.where(
				and(eq(healthDataPoint.dataType, 'sleep'), eq(healthDataPoint.sleepDurationsParsed, false))
			)
			.limit(BACKFILL_BATCH);
		if (rows.length === 0) return updated;
		await db.transaction(async (tx) => {
			for (const row of rows) {
				const durations = googleSleepDurations(row.payload);
				await tx
					.update(healthDataPoint)
					.set({
						sleepInBedSeconds: durations.inBedSeconds,
						sleepAwakeSeconds: durations.awakeSeconds,
						sleepDeepSeconds: durations.deepSeconds,
						sleepLightSeconds: durations.lightSeconds,
						sleepRemSeconds: durations.remSeconds,
						sleepDurationsParsed: true
					})
					.where(eq(healthDataPoint.id, row.id));
			}
		});
		updated += rows.length;
	}
}
