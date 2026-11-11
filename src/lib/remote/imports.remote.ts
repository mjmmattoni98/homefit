import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import * as v from 'valibot';
import { command, getRequestEvent, query } from '$app/server';
import * as m from '#lib/paraglide/messages.js';
import { CSV_DELETE_CONFIRMATION } from '#lib/csv/confirmation.js';
import { workoutSchema } from '#lib/csv/hevy-schema.js';
import { sleepRecordSchema } from '#lib/csv/sleep-schema.js';
import { csvSettings } from '#lib/server/db/schema.js';
import {
	importTimeZone,
	setImportTimeZone,
	ImportTimeZoneChangedError,
	withImportTimeZone
} from '#lib/server/csv-settings.js';
import {
	listScaleWeights,
	loadDashboard,
	loadSleepWindow,
	resolveTimeZone
} from '#lib/server/dashboard.js';
import { db } from '#lib/server/db/index.js';
import { requireUserId } from '#lib/server/session.js';
import { importSleepRecords, removeAllSleepRecords } from '#lib/server/sleep.js';
import {
	AmbiguousWorkoutError,
	exerciseSessions,
	getWorkoutDetail,
	importWorkouts,
	listExercises,
	removeAllWorkouts
} from '#lib/server/workouts.js';
import { TIME_ZONE_COOKIE } from '#lib/time-zone.js';

const text = (max = 2_000) => v.pipe(v.string(), v.maxLength(max));
export const getDashboard = query(async () => {
	const userId = requireUserId();
	const timeZone = resolveTimeZone(getRequestEvent().cookies.get(TIME_ZONE_COOKIE));
	return await loadDashboard(db, userId, timeZone);
});

export const getSleepWindow = query(
	v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(366)),
	async (days) => {
		const userId = requireUserId();
		const timeZone = resolveTimeZone(getRequestEvent().cookies.get(TIME_ZONE_COOKIE));
		return await loadSleepWindow(db, userId, timeZone, days);
	}
);

export const getWorkout = query(v.pipe(v.string(), v.uuid()), async (workoutId) =>
	getWorkoutDetail(db, requireUserId(), workoutId)
);

export const getExercises = query(async () => await listExercises(db, requireUserId()));

export const getExerciseSessions = query(text(500), async (exerciseTitle) =>
	exerciseSessions(db, requireUserId(), exerciseTitle)
);

export const getScaleWeights = query(async () => await listScaleWeights(db, requireUserId()));

function reportImportError(cause: unknown): never {
	if (cause instanceof AmbiguousWorkoutError) error(409, m.import_ambiguous());
	if (cause instanceof ImportTimeZoneChangedError) error(409, m.import_timezone_changed());
	throw cause;
}

export const importSleepBatch = command(
	v.object({ timeZone: text(100), records: v.pipe(v.array(sleepRecordSchema), v.maxLength(500)) }),
	async ({ records, timeZone }) => {
		const userId = requireUserId();
		return withImportTimeZone(db, userId, timeZone, (tx) =>
			importSleepRecords(tx, userId, records)
		).catch(reportImportError);
	}
);

export const importWorkoutBatch = command(
	v.object({
		workouts: v.pipe(v.array(workoutSchema), v.maxLength(100)),
		timeZone: text(100),
		manifest: v.pipe(
			v.array(
				v.object({
					startTime: v.pipe(v.number(), v.integer()),
					endTime: v.pipe(v.number(), v.integer()),
					title: text(500)
				})
			),
			v.maxLength(50000)
		)
	}),
	async ({ workouts, manifest, timeZone }) => {
		const userId = requireUserId();
		return withImportTimeZone(db, userId, timeZone, (tx) =>
			importWorkouts(tx, userId, workouts, manifest)
		).catch(reportImportError);
	}
);

const zone = v.pipe(
	v.string(),
	v.maxLength(100),
	v.check((value) => {
		try {
			new Intl.DateTimeFormat('en', { timeZone: value });
			return !/^[+-]/.test(value);
		} catch {
			return false;
		}
	})
);
export const getImportTimeZone = command(zone, async (browserZone) =>
	importTimeZone(db, requireUserId(), browserZone)
);
export const updateImportTimeZone = command(zone, async (timeZone) =>
	setImportTimeZone(db, requireUserId(), timeZone)
);
export const deleteCsvData = command(
	v.pipe(
		v.object({ source: v.picklist(['sleep', 'hevy']), confirmation: v.string() }),
		v.check(({ source, confirmation }) => confirmation === CSV_DELETE_CONFIRMATION[source])
	),
	async ({ source }) => {
		const userId = requireUserId();
		if (source === 'sleep') await removeAllSleepRecords(db, userId);
		else await removeAllWorkouts(db, userId);
	}
);

export const getCsvSettings = query(
	async () =>
		(await db.select().from(csvSettings).where(eq(csvSettings.userId, requireUserId())))[0]
			?.timeZone ?? null
);
