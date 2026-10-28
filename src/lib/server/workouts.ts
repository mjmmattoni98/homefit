import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from './db/types';
import { workout, workoutSet } from './db/schema';

export interface WorkoutSetInput {
	exerciseTitle: string;
	setIndex: number;
	setType: string;
	weightKg?: number;
	reps?: number;
	distanceKm?: number;
	durationSeconds?: number;
	rpe?: number;
	supersetId?: string;
	exerciseNotes?: string;
}

export interface WorkoutInput {
	title: string;
	startTime: number;
	endTime: number;
	description?: string;
	sets: WorkoutSetInput[];
}

export interface WorkoutSummary {
	id: string;
	title: string;
	startTime: number;
	endTime: number;
	description?: string;
	setsCount: number;
	volume: number;
	totalReps: number;
	exerciseTitles: string[];
}

export interface ExerciseSummary {
	exerciseTitle: string;
	setsCount: number;
	lastPerformed: number;
}

/** Training on one local calendar day. */
export interface TrainingDay {
	/** Local date, `YYYY-MM-DD`. */
	day: string;
	workouts: number;
	volume: number;
}

/** One workout's sets of a single exercise, summarized for progression charts. */
export interface ExerciseSession {
	workoutId: string;
	startTime: number;
	sets: number;
	/** Heaviest weight lifted, or 0 when no set carried weight. */
	maxWeight: number;
	volume: number;
}

export interface WorkoutDetail {
	id: string;
	title: string;
	startTime: number;
	endTime: number;
	description?: string;
	/** Exercises in alphabetical order (imports don't record the order they were performed in). */
	exercises: {
		exerciseTitle: string;
		notes?: string;
		sets: Omit<WorkoutSetInput, 'exerciseTitle' | 'exerciseNotes'>[];
	}[];
}

/**
 * Imports Hevy workouts with their sets. Workouts are deduplicated by start time and title per
 * user, so the same export can be imported repeatedly.
 */
export async function importWorkouts(
	db: Database,
	userId: string,
	workouts: readonly WorkoutInput[]
): Promise<{ imported: number; skipped: number; setsImported: number }> {
	return await db.transaction(async (tx) => {
		let imported = 0;
		let setsImported = 0;
		for (const { sets, ...input } of workouts) {
			const [created] = await tx
				.insert(workout)
				.values({
					...input,
					userId,
					startTime: new Date(input.startTime),
					endTime: new Date(input.endTime)
				})
				.onConflictDoNothing({ target: [workout.userId, workout.startTime, workout.title] })
				.returning({ id: workout.id, startTime: workout.startTime });
			if (created === undefined) continue;
			imported += 1;
			if (sets.length > 0) {
				await tx.insert(workoutSet).values(
					sets.map((set) => ({
						...set,
						workoutId: created.id,
						userId,
						startTime: created.startTime
					}))
				);
				setsImported += sets.length;
			}
		}
		return { imported, skipped: workouts.length - imported, setsImported };
	});
}

/** Lists the `limit` newest workouts with their training volume, set count and exercises. */
export async function listWorkouts(
	db: Database,
	userId: string,
	limit: number
): Promise<WorkoutSummary[]> {
	const rows = await db
		.select({
			id: workout.id,
			title: workout.title,
			startTime: workout.startTime,
			endTime: workout.endTime,
			description: workout.description,
			setsCount: sql<number>`count(${workoutSet.id})::int`,
			volume: sql<number>`coalesce(sum(${workoutSet.weightKg} * ${workoutSet.reps}), 0)::float8`,
			totalReps: sql<number>`coalesce(sum(${workoutSet.reps}), 0)::float8`,
			exerciseTitles: sql<
				string[]
			>`coalesce(array_agg(distinct ${workoutSet.exerciseTitle}) filter (where ${workoutSet.id} is not null), '{}')`
		})
		.from(workout)
		.leftJoin(workoutSet, eq(workoutSet.workoutId, workout.id))
		.where(eq(workout.userId, userId))
		.groupBy(workout.id)
		.orderBy(desc(workout.startTime))
		.limit(limit);
	return rows.map((row) => ({
		...row,
		startTime: row.startTime.getTime(),
		endTime: row.endTime.getTime(),
		description: row.description ?? undefined
	}));
}

/**
 * Lists exercises logged with actual load (at least one set with weight above zero). Bodyweight
 * and cardio-only titles are omitted because the exercises page charts weight and volume.
 */
export async function listExercises(db: Database, userId: string): Promise<ExerciseSummary[]> {
	const rows = await db
		.select({
			exerciseTitle: workoutSet.exerciseTitle,
			setsCount: sql<number>`count(*)::int`,
			lastPerformed: sql<Date>`max(${workoutSet.startTime})`.mapWith(workoutSet.startTime)
		})
		.from(workoutSet)
		.where(eq(workoutSet.userId, userId))
		.groupBy(workoutSet.exerciseTitle)
		.having(sql`bool_or(${workoutSet.weightKg} > 0)`);
	return rows
		.map((row) => ({ ...row, lastPerformed: row.lastPerformed.getTime() }))
		.sort((a, b) => a.exerciseTitle.localeCompare(b.exerciseTitle));
}

/**
 * Sums every workout's volume per local day in `timeZone`, oldest first. Covers the whole history
 * in one row per training day, so dashboard totals never miss older workouts.
 */
export async function listTrainingDays(
	db: Database,
	userId: string,
	timeZone: string
): Promise<TrainingDay[]> {
	const perWorkout = db.$with('per_workout').as(
		db
			.select({
				day: sql<string>`to_char(${workout.startTime} at time zone ${timeZone}::text, 'YYYY-MM-DD')`.as(
					'day'
				),
				volume: sql<number>`coalesce(sum(${workoutSet.weightKg} * ${workoutSet.reps}), 0)`.as(
					'volume'
				)
			})
			.from(workout)
			.leftJoin(workoutSet, eq(workoutSet.workoutId, workout.id))
			.where(eq(workout.userId, userId))
			.groupBy(workout.id)
	);
	return await db
		.with(perWorkout)
		.select({
			day: perWorkout.day,
			workouts: sql<number>`count(*)::int`,
			volume: sql<number>`sum(${perWorkout.volume})::float8`
		})
		.from(perWorkout)
		.groupBy(perWorkout.day)
		.orderBy(asc(perWorkout.day));
}

/** Summarizes each workout's sets of one exercise, oldest first, for progression charts. */
export async function exerciseSessions(
	db: Database,
	userId: string,
	exerciseTitle: string
): Promise<ExerciseSession[]> {
	const rows = await db
		.select({
			workoutId: workoutSet.workoutId,
			startTime: workoutSet.startTime,
			sets: sql<number>`count(*)::int`,
			maxWeight: sql<number>`greatest(coalesce(max(${workoutSet.weightKg}), 0), 0)::float8`,
			volume: sql<number>`coalesce(sum(${workoutSet.weightKg} * ${workoutSet.reps}), 0)::float8`
		})
		.from(workoutSet)
		.where(and(eq(workoutSet.userId, userId), eq(workoutSet.exerciseTitle, exerciseTitle)))
		.groupBy(workoutSet.workoutId, workoutSet.startTime)
		.orderBy(asc(workoutSet.startTime));
	return rows.map((row) => ({ ...row, startTime: row.startTime.getTime() }));
}

/** Returns one of the user's workouts with its sets grouped by exercise, or null. */
export async function getWorkoutDetail(
	db: Database,
	userId: string,
	workoutId: string
): Promise<WorkoutDetail | null> {
	const [row] = await db
		.select()
		.from(workout)
		.where(and(eq(workout.id, workoutId), eq(workout.userId, userId)));
	if (row === undefined) return null;
	const sets = await db
		.select()
		.from(workoutSet)
		.where(eq(workoutSet.workoutId, workoutId))
		.orderBy(asc(workoutSet.exerciseTitle), asc(workoutSet.setIndex));
	const exercises: WorkoutDetail['exercises'] = [];
	for (const set of sets) {
		let exercise = exercises.at(-1);
		if (exercise?.exerciseTitle !== set.exerciseTitle) {
			exercise = {
				exerciseTitle: set.exerciseTitle,
				notes: set.exerciseNotes ?? undefined,
				sets: []
			};
			exercises.push(exercise);
		}
		exercise.sets.push({
			setIndex: set.setIndex,
			setType: set.setType,
			weightKg: set.weightKg ?? undefined,
			reps: set.reps ?? undefined,
			distanceKm: set.distanceKm ?? undefined,
			durationSeconds: set.durationSeconds ?? undefined,
			rpe: set.rpe ?? undefined,
			supersetId: set.supersetId ?? undefined
		});
	}
	return {
		id: row.id,
		title: row.title,
		startTime: row.startTime.getTime(),
		endTime: row.endTime.getTime(),
		description: row.description ?? undefined,
		exercises
	};
}

export async function removeAllWorkouts(db: Database, userId: string): Promise<void> {
	// Sets are removed by the foreign-key cascade.
	await db.delete(workout).where(eq(workout.userId, userId));
}
