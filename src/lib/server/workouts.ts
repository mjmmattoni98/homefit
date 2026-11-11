import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from './db/types';
import { user, workout, workoutSet } from './db/schema';

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

export class AmbiguousWorkoutError extends Error {}

export type ExerciseMode = 'weighted' | 'bodyweight' | 'cardio' | 'duration';

export interface WorkoutSummary {
	id: string;
	title: string;
	startTime: number;
	endTime: number;
	description?: string;
	setsCount: number;
	workingSets: number;
	hardSets: number;
	meanRpe?: number;
	volume: number;
	totalReps: number;
	exerciseTitles: string[];
}

export interface ExerciseSummary {
	exerciseTitle: string;
	setsCount: number;
	lastPerformed: number;
	mode: ExerciseMode;
}

/** Training on one local calendar day. */
export interface TrainingDay {
	/** Local date, `YYYY-MM-DD`. */
	day: string;
	workouts: number;
	volume: number;
	workingSets?: number;
	hardSets?: number;
	meanRpe?: number;
	latestEndTime?: number;
}

export interface RepMaxEntry {
	reps: number;
	weight: number;
	startTime: number;
}

/** One workout's sets of a single exercise, summarized for progression charts. */
export interface ExerciseSession {
	workoutId: string;
	startTime: number;
	sets: number;
	workingSets: number;
	hardSets: number;
	/** Heaviest weight lifted on a working set (or any set if all were warm-ups), or 0 without load. */
	maxWeight: number;
	/** Best Epley estimated 1RM (`weight * (1 + reps / 30)`) in the session, or 0 without load. */
	e1rm: number;
	volume: number;
	maxReps: number;
	totalReps: number;
	distanceKm: number;
	durationSeconds: number;
	meanRpe?: number;
	/** Heaviest weight lifted at each rep count in this session, for rep-max PR tracking. */
	repMaxes: { reps: number; weight: number }[];
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

const WORKING_SET = sql`lower(coalesce(${workoutSet.setType}, 'normal')) <> 'warmup'`;
const HARD_SET = sql`(${WORKING_SET} and (lower(coalesce(${workoutSet.setType}, '')) = 'failure' or coalesce(${workoutSet.rpe}, 0) >= 8))`;

/** Rows per insert statement, keeping each one well under PostgreSQL's bind-parameter limit. */
const SET_INSERT_CHUNK = 2_000;

// Compare data rather than database IDs or CSV order; null and omitted optional fields agree.
function canonicalSets(
	sets: readonly { [K in keyof WorkoutSetInput]: WorkoutSetInput[K] | null }[]
): string {
	return JSON.stringify(
		sets
			.map((set) =>
				Object.fromEntries(
					Object.entries(set)
						.filter(([, value]) => value != null)
						.sort(([a], [b]) => a.localeCompare(b))
				)
			)
			.map((set) => JSON.stringify(set))
			.sort()
	);
}

/**
 * Imports Hevy workouts with their sets. A workout is identified by its start time and title per
 * user, so the same export can be imported repeatedly: unchanged workouts are skipped, edited
 * ones are updated in place, and a renamed one is matched through the complete export.
 */
export async function importWorkouts(
	db: Database,
	userId: string,
	workouts: readonly WorkoutInput[],
	// Complete file identities, not just this batch, prevent a rename consuming another session.
	manifest: readonly Pick<WorkoutInput, 'startTime' | 'endTime' | 'title'>[] = workouts
): Promise<{ imported: number; updated: number; skipped: number; setsImported: number }> {
	return db.transaction(async (tx) => {
		await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update');
		const result = { imported: 0, updated: 0, skipped: 0, setsImported: 0 };
		const identities = new Map<string, number>();
		for (const row of manifest) {
			const key = JSON.stringify([row.startTime, row.title]);
			const previousEnd = identities.get(key);
			if (previousEnd !== undefined && previousEnd !== row.endTime)
				throw new AmbiguousWorkoutError(
					'Ambiguous Hevy sessions with the same title and start time.'
				);
			identities.set(key, row.endTime);
		}
		if (workouts.length === 0) return result;
		const starts = [...new Set(workouts.map((input) => input.startTime))].map((t) => new Date(t));
		const stored = await tx
			.select()
			.from(workout)
			.where(and(eq(workout.userId, userId), inArray(workout.startTime, starts)));
		const storedSets =
			stored.length === 0
				? []
				: await tx
						.select()
						.from(workoutSet)
						.where(
							inArray(
								workoutSet.workoutId,
								stored.map((row) => row.id)
							)
						);
		type Session = Pick<
			typeof workout.$inferSelect,
			'id' | 'title' | 'startTime' | 'endTime' | 'description'
		>;
		const byStart = new Map<number, Session[]>();
		const setsByWorkout = new Map<
			string,
			(
				| WorkoutSetInput
				| Omit<typeof workoutSet.$inferSelect, 'id' | 'workoutId' | 'userId' | 'startTime'>
			)[]
		>();
		for (const row of stored) {
			const time = row.startTime.getTime();
			const group = byStart.get(time) ?? [];
			group.push(row);
			byStart.set(time, group);
		}
		for (const {
			id: _id,
			workoutId,
			userId: _userId,
			startTime: _startTime,
			...set
		} of storedSets) {
			const group = setsByWorkout.get(workoutId) ?? [];
			group.push(set);
			setsByWorkout.set(workoutId, group);
		}
		const titlesByStart = new Map<number, Set<string>>();
		for (const row of manifest) {
			const titles = titlesByStart.get(row.startTime) ?? new Set<string>();
			titles.add(row.title);
			titlesByStart.set(row.startTime, titles);
		}
		const newIds = new Set<string>();
		const changed = new Map<string, Session>();
		for (const input of workouts) {
			const candidates = byStart.get(input.startTime) ?? [];
			let existing = candidates.find((row) => row.title === input.title);
			if (!existing) {
				const exportTitles = titlesByStart.get(input.startTime) ?? new Set<string>();
				const unclaimed = candidates.filter((row) => !exportTitles.has(row.title));
				const newTitles = [...exportTitles].filter(
					(title) => !candidates.some((row) => row.title === title)
				);
				// A complete export that omits a stored title at this instant means it was renamed
				// or deleted in Hevy: replacement is correct in either case. Sessions that both
				// still exist in the export are never merged.
				if (unclaimed.length === 1 && newTitles.length === 1) existing = unclaimed[0];
				else if (unclaimed.length > 0)
					throw new AmbiguousWorkoutError(
						'Ambiguous Hevy sessions at the same start time. Delete imported Hevy data and import the complete export.'
					);
			}
			const values = {
				title: input.title,
				startTime: new Date(input.startTime),
				endTime: new Date(input.endTime),
				description: input.description ?? null
			};
			if (existing) {
				if (
					existing.title === input.title &&
					existing.endTime.getTime() === input.endTime &&
					existing.description === values.description &&
					canonicalSets(setsByWorkout.get(existing.id) ?? []) === canonicalSets(input.sets)
				) {
					result.skipped++;
					continue;
				}
				Object.assign(existing, values);
				result.updated++;
			} else {
				existing = { id: crypto.randomUUID(), ...values };
				newIds.add(existing.id);
				candidates.push(existing);
				byStart.set(input.startTime, candidates);
				result.imported++;
			}
			changed.set(existing.id, existing);
			setsByWorkout.set(existing.id, input.sets);
			result.setsImported += input.sets.length;
		}
		const inserts = [...changed.values()].filter((row) => newIds.has(row.id));
		for (let i = 0; i < inserts.length; i += SET_INSERT_CHUNK)
			await tx
				.insert(workout)
				.values(inserts.slice(i, i + SET_INSERT_CHUNK).map((row) => ({ ...row, userId })));
		const sets: (typeof workoutSet.$inferInsert)[] = [];
		for (const row of changed.values()) {
			if (!newIds.has(row.id)) {
				await tx
					.update(workout)
					.set({ title: row.title, endTime: row.endTime, description: row.description })
					.where(eq(workout.id, row.id));
				await tx.delete(workoutSet).where(eq(workoutSet.workoutId, row.id));
			}
			sets.push(
				...(setsByWorkout.get(row.id) ?? []).map((set) => ({
					...set,
					workoutId: row.id,
					userId,
					startTime: row.startTime
				}))
			);
		}
		for (let i = 0; i < sets.length; i += SET_INSERT_CHUNK)
			await tx.insert(workoutSet).values(sets.slice(i, i + SET_INSERT_CHUNK));
		return result;
	});
}

/** Lists the `limit` newest workouts with their working volume, set breakdown, RPE and exercises. */
export async function listWorkouts(
	db: Database,
	userId: string,
	limit: number
): Promise<WorkoutSummary[]> {
	// Pick the workouts first. Joining every historical set and only then limiting recounts years
	// of training to return a handful of sessions.
	const recent = db.$with('recent_workouts').as(
		db
			.select({
				id: workout.id,
				title: workout.title,
				startTime: workout.startTime,
				endTime: workout.endTime,
				description: workout.description
			})
			.from(workout)
			.where(eq(workout.userId, userId))
			.orderBy(desc(workout.startTime))
			.limit(limit)
	);
	const rows = await db
		.with(recent)
		.select({
			id: recent.id,
			title: recent.title,
			startTime: recent.startTime,
			endTime: recent.endTime,
			description: recent.description,
			setsCount: sql<number>`count(${workoutSet.id})::int`,
			workingSets: sql<number>`count(${workoutSet.id}) filter (where ${WORKING_SET})::int`,
			hardSets: sql<number>`count(${workoutSet.id}) filter (where ${HARD_SET})::int`,
			meanRpe: sql<
				number | null
			>`avg(${workoutSet.rpe}) filter (where ${WORKING_SET} and ${workoutSet.rpe} is not null)::float8`,
			volume: sql<number>`coalesce(sum(${workoutSet.weightKg} * ${workoutSet.reps}) filter (where ${WORKING_SET}), 0)::float8`,
			totalReps: sql<number>`coalesce(sum(${workoutSet.reps}), 0)::float8`,
			exerciseTitles: sql<
				string[]
			>`coalesce(array_agg(distinct ${workoutSet.exerciseTitle}) filter (where ${workoutSet.id} is not null), '{}')`
		})
		.from(recent)
		.leftJoin(workoutSet, eq(workoutSet.workoutId, recent.id))
		.groupBy(recent.id, recent.title, recent.startTime, recent.endTime, recent.description)
		.orderBy(desc(recent.startTime));
	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		startTime: row.startTime.getTime(),
		endTime: row.endTime.getTime(),
		description: row.description ?? undefined,
		setsCount: row.setsCount,
		workingSets: row.workingSets,
		hardSets: row.hardSets,
		meanRpe: row.meanRpe ?? undefined,
		volume: row.volume,
		totalReps: row.totalReps,
		exerciseTitles: row.exerciseTitles
	}));
}

/**
 * Lists every logged exercise — weighted, bodyweight, cardio, or timed — with its primary mode so
 * the progression page can render the right chart for each movement.
 */
export async function listExercises(db: Database, userId: string): Promise<ExerciseSummary[]> {
	const rows = await db
		.select({
			exerciseTitle: workoutSet.exerciseTitle,
			setsCount: sql<number>`count(*)::int`,
			lastPerformed: sql<Date>`max(${workoutSet.startTime})`.mapWith(workoutSet.startTime),
			hasWeight: sql<boolean>`coalesce(bool_or(${workoutSet.weightKg} > 0), false)`,
			hasDistance: sql<boolean>`coalesce(bool_or(${workoutSet.distanceKm} > 0), false)`,
			hasReps: sql<boolean>`coalesce(bool_or(${workoutSet.reps} > 0), false)`,
			hasDuration: sql<boolean>`coalesce(bool_or(${workoutSet.durationSeconds} > 0), false)`
		})
		.from(workoutSet)
		.where(eq(workoutSet.userId, userId))
		.groupBy(workoutSet.exerciseTitle);
	return rows
		.map((row) => {
			const mode: ExerciseMode = row.hasWeight
				? 'weighted'
				: row.hasDistance
					? 'cardio'
					: row.hasReps
						? 'bodyweight'
						: 'duration';
			return {
				exerciseTitle: row.exerciseTitle,
				setsCount: row.setsCount,
				lastPerformed: row.lastPerformed.getTime(),
				mode
			};
		})
		.sort((a, b) => a.exerciseTitle.localeCompare(b.exerciseTitle));
}

/**
 * Sums every workout's working volume, effort and latest finish per local day in `timeZone`,
 * oldest first. Covers the whole history in one row per training day.
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
				endTime: workout.endTime,
				volume:
					sql<number>`coalesce(sum(${workoutSet.weightKg} * ${workoutSet.reps}) filter (where ${WORKING_SET}), 0)`.as(
						'volume'
					),
				workingSets: sql<number>`count(${workoutSet.id}) filter (where ${WORKING_SET})::int`.as(
					'working_sets'
				),
				hardSets: sql<number>`count(${workoutSet.id}) filter (where ${HARD_SET})::int`.as(
					'hard_sets'
				),
				rpeSum:
					sql<number>`coalesce(sum(${workoutSet.rpe}) filter (where ${WORKING_SET} and ${workoutSet.rpe} is not null), 0)`.as(
						'rpe_sum'
					),
				rpeCount:
					sql<number>`count(${workoutSet.id}) filter (where ${WORKING_SET} and ${workoutSet.rpe} is not null)::int`.as(
						'rpe_count'
					)
			})
			.from(workout)
			.leftJoin(workoutSet, eq(workoutSet.workoutId, workout.id))
			.where(eq(workout.userId, userId))
			.groupBy(workout.id)
	);
	const rows = await db
		.with(perWorkout)
		.select({
			day: perWorkout.day,
			workouts: sql<number>`count(*)::int`,
			volume: sql<number>`sum(${perWorkout.volume})::float8`,
			workingSets: sql<number>`sum(${perWorkout.workingSets})::int`,
			hardSets: sql<number>`sum(${perWorkout.hardSets})::int`,
			rpeSum: sql<number>`sum(${perWorkout.rpeSum})::float8`,
			rpeCount: sql<number>`sum(${perWorkout.rpeCount})::int`,
			latestEndTime: sql<Date>`max(${perWorkout.endTime})`.mapWith(workout.endTime)
		})
		.from(perWorkout)
		.groupBy(perWorkout.day)
		.orderBy(asc(perWorkout.day));
	return rows.map((row) => ({
		day: row.day,
		workouts: row.workouts,
		volume: row.volume,
		workingSets: row.workingSets,
		hardSets: row.hardSets,
		meanRpe: row.rpeCount > 0 ? row.rpeSum / row.rpeCount : undefined,
		latestEndTime: row.latestEndTime.getTime()
	}));
}

/** Epley estimated one-rep max (`weight * (1 + reps / 30)`), capped at 15 reps for reliability. */
export function estimateOneRepMax(weightKg: number, reps: number): number {
	if (weightKg <= 0 || reps <= 0) return 0;
	if (reps === 1) return weightKg;
	const effectiveReps = Math.min(reps, 15);
	return weightKg * (1 + effectiveReps / 30);
}

/** Summarizes each workout's sets of one exercise, oldest first, for progression charts. */
export async function exerciseSessions(
	db: Database,
	userId: string,
	exerciseTitle: string
): Promise<ExerciseSession[]> {
	const sets = await db
		.select({
			workoutId: workoutSet.workoutId,
			startTime: workoutSet.startTime,
			setType: workoutSet.setType,
			weightKg: workoutSet.weightKg,
			reps: workoutSet.reps,
			distanceKm: workoutSet.distanceKm,
			durationSeconds: workoutSet.durationSeconds,
			rpe: workoutSet.rpe
		})
		.from(workoutSet)
		.where(and(eq(workoutSet.userId, userId), eq(workoutSet.exerciseTitle, exerciseTitle)))
		.orderBy(asc(workoutSet.startTime), asc(workoutSet.setIndex));

	const byWorkout = new Map<
		string,
		{
			workoutId: string;
			startTime: number;
			sets: typeof sets;
		}
	>();
	for (const set of sets) {
		const existing = byWorkout.get(set.workoutId);
		if (existing) {
			existing.sets.push(set);
		} else {
			byWorkout.set(set.workoutId, {
				workoutId: set.workoutId,
				startTime: set.startTime.getTime(),
				sets: [set]
			});
		}
	}

	const sessions: ExerciseSession[] = [];
	for (const group of byWorkout.values()) {
		const working = group.sets.filter((s) => s.setType.toLowerCase() !== 'warmup');
		const counted = working.length > 0 ? working : group.sets;

		let maxWeight = 0;
		let e1rm = 0;
		let volume = 0;
		let maxReps = 0;
		let totalReps = 0;
		let distanceKm = 0;
		let durationSeconds = 0;
		let rpeSum = 0;
		let rpeCount = 0;
		let hardSets = 0;
		const repMaxMap = new Map<number, number>();

		for (const set of counted) {
			const weight = Math.max(0, set.weightKg ?? 0);
			const reps = Math.max(0, set.reps ?? 0);
			const dist = Math.max(0, set.distanceKm ?? 0);
			const dur = Math.max(0, set.durationSeconds ?? 0);

			if (weight > maxWeight) maxWeight = weight;
			if (weight > 0 && reps > 0) {
				volume += weight * reps;
				const estimated = estimateOneRepMax(weight, reps);
				if (estimated > e1rm) e1rm = estimated;
				const wholeReps = Math.round(reps);
				if (wholeReps >= 1) {
					const prev = repMaxMap.get(wholeReps) ?? 0;
					if (weight > prev) repMaxMap.set(wholeReps, weight);
				}
			}
			if (reps > maxReps) maxReps = reps;
			totalReps += reps;
			distanceKm += dist;
			durationSeconds += dur;
			if (set.rpe !== null && Number.isFinite(set.rpe)) {
				rpeSum += set.rpe;
				rpeCount += 1;
			}
			if (set.setType.toLowerCase() === 'failure' || (set.rpe !== null && set.rpe >= 8)) {
				hardSets += 1;
			}
		}

		sessions.push({
			workoutId: group.workoutId,
			startTime: group.startTime,
			sets: group.sets.length,
			workingSets: working.length,
			hardSets,
			maxWeight,
			e1rm,
			volume,
			maxReps,
			totalReps,
			distanceKm,
			durationSeconds,
			meanRpe: rpeCount > 0 ? rpeSum / rpeCount : undefined,
			repMaxes: [...repMaxMap.entries()]
				.map(([reps, weight]) => ({ reps, weight }))
				.sort((a, b) => a.reps - b.reps)
		});
	}

	return sessions.sort((a, b) => a.startTime - b.startTime);
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
