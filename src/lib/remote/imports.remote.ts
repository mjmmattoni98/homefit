import * as v from 'valibot';
import { command, getRequestEvent, query } from '$app/server';
import { loadDashboard, resolveTimeZone } from '#lib/server/dashboard.js';
import { db } from '#lib/server/db/index.js';
import { requireUserId } from '#lib/server/session.js';
import { importSleepRecords } from '#lib/server/sleep.js';
import {
	exerciseSessions,
	getWorkoutDetail,
	importWorkouts,
	listExercises
} from '#lib/server/workouts.js';
import { TIME_ZONE_COOKIE } from '#lib/time-zone.js';

const finite = v.pipe(v.number(), v.finite());
const text = (max = 2_000) => v.pipe(v.string(), v.maxLength(max));
const optionalFinite = v.optional(finite);
const optionalText = (max?: number) => v.optional(text(max));

const sleepRecordSchema = v.object({
	wentToBed: finite,
	wokeUp: finite,
	sleepQuality: finite,
	timeInBedSeconds: finite,
	timeAsleepSeconds: finite,
	asleepAfterSeconds: finite,
	regularity: optionalFinite,
	didSnore: v.boolean(),
	snoreTimeSeconds: finite,
	steps: optionalFinite,
	weatherTempC: optionalFinite,
	weatherType: optionalText(200),
	city: optionalText(200),
	movementsPerHour: optionalFinite,
	notes: v.pipe(v.array(text(500)), v.maxLength(100)),
	mood: optionalText(200)
});

const workoutSetSchema = v.object({
	exerciseTitle: text(500),
	setIndex: v.pipe(v.number(), v.integer()),
	setType: text(100),
	weightKg: optionalFinite,
	reps: optionalFinite,
	distanceKm: optionalFinite,
	durationSeconds: optionalFinite,
	rpe: optionalFinite,
	supersetId: optionalText(100),
	exerciseNotes: optionalText()
});

const workoutSchema = v.object({
	title: text(500),
	startTime: finite,
	endTime: finite,
	description: optionalText(),
	sets: v.pipe(v.array(workoutSetSchema), v.maxLength(500))
});

export const getDashboard = query(async () => {
	const userId = requireUserId();
	const timeZone = resolveTimeZone(getRequestEvent().cookies.get(TIME_ZONE_COOKIE));
	return await loadDashboard(db, userId, timeZone);
});

export const getWorkout = query(v.pipe(v.string(), v.uuid()), async (workoutId) =>
	getWorkoutDetail(db, requireUserId(), workoutId)
);

export const getExercises = query(async () => await listExercises(db, requireUserId()));

export const getExerciseSessions = query(text(500), async (exerciseTitle) =>
	exerciseSessions(db, requireUserId(), exerciseTitle)
);

export const importSleepBatch = command(
	v.object({ records: v.pipe(v.array(sleepRecordSchema), v.maxLength(500)) }),
	async ({ records }) => await importSleepRecords(db, requireUserId(), records)
);

export const importWorkoutBatch = command(
	v.object({ workouts: v.pipe(v.array(workoutSchema), v.maxLength(100)) }),
	async ({ workouts }) => await importWorkouts(db, requireUserId(), workouts)
);
