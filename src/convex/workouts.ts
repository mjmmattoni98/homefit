import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./helpers";

const setInput = v.object({
  exerciseTitle: v.string(),
  setIndex: v.number(),
  setType: v.string(),
  weightKg: v.optional(v.number()),
  reps: v.optional(v.number()),
  distanceKm: v.optional(v.number()),
  durationSeconds: v.optional(v.number()),
  rpe: v.optional(v.number()),
  supersetId: v.optional(v.string()),
  exerciseNotes: v.optional(v.string()),
});

/**
 * Imports a batch of workouts (with their sets) parsed from a Hevy CSV
 * export. Workouts are deduplicated by (startTime, title) per user.
 */
export const importBatch = mutation({
  args: {
    workouts: v.array(
      v.object({
        title: v.string(),
        startTime: v.number(),
        endTime: v.number(),
        description: v.optional(v.string()),
        sets: v.array(setInput),
      }),
    ),
  },
  returns: v.object({
    imported: v.number(),
    skipped: v.number(),
    setsImported: v.number(),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    const existing = await ctx.db
      .query("workouts")
      .withIndex("by_user_and_startTime", (q) => q.eq("userId", userId))
      .take(10000);
    const seen = new Set(existing.map((w) => `${w.startTime}|${w.title}`));

    let imported = 0;
    let skipped = 0;
    let setsImported = 0;
    for (const workout of args.workouts) {
      const key = `${workout.startTime}|${workout.title}`;
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);

      const workoutId = await ctx.db.insert("workouts", {
        userId,
        title: workout.title,
        startTime: workout.startTime,
        endTime: workout.endTime,
        description: workout.description,
      });
      for (const set of workout.sets) {
        await ctx.db.insert("workoutSets", {
          workoutId,
          userId,
          startTime: workout.startTime,
          ...set,
        });
        setsImported++;
      }
      imported++;
    }
    return { imported, skipped, setsImported };
  },
});

/**
 * Deletes every workout (and its sets) owned by the current user.
 */
export const removeAll = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const sets = await ctx.db
      .query("workoutSets")
      .withIndex("by_user_and_exercise_and_startTime", (q) =>
        q.eq("userId", userId),
      )
      .take(20000);
    for (const set of sets) {
      await ctx.db.delete("workoutSets", set._id);
    }
    const workouts = await ctx.db
      .query("workouts")
      .withIndex("by_user_and_startTime", (q) => q.eq("userId", userId))
      .take(10000);
    for (const workout of workouts) {
      await ctx.db.delete("workouts", workout._id);
    }
    return null;
  },
});

/**
 * Lists workouts for the current user (newest first) with the training
 * volume (sum of weight x reps) and set count computed for each one.
 */
export const listWorkouts = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const workouts = await ctx.db
      .query("workouts")
      .withIndex("by_user_and_startTime", (q) => q.eq("userId", userId))
      .order("desc")
      .take(1000);

    const result = [];
    for (const workout of workouts) {
      const sets = await ctx.db
        .query("workoutSets")
        .withIndex("by_workout", (q) => q.eq("workoutId", workout._id))
        .take(500);
      let volume = 0;
      let totalReps = 0;
      const exercises = new Set<string>();
      for (const set of sets) {
        exercises.add(set.exerciseTitle);
        if (set.weightKg != null && set.reps != null) {
          volume += set.weightKg * set.reps;
        }
        if (set.reps != null) {
          totalReps += set.reps;
        }
      }
      result.push({
        ...workout,
        setsCount: sets.length,
        volume,
        totalReps,
        exerciseTitles: [...exercises],
      });
    }
    return result;
  },
});

/**
 * Lists the distinct exercise titles the current user has ever logged,
 * with the number of sets and the last time each was performed.
 */
export const listExercises = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const sets = await ctx.db
      .query("workoutSets")
      .withIndex("by_user_and_exercise_and_startTime", (q) =>
        q.eq("userId", userId),
      )
      .take(20000);

    const byExercise = new Map<
      string,
      { exerciseTitle: string; setsCount: number; lastPerformed: number }
    >();
    for (const set of sets) {
      const entry = byExercise.get(set.exerciseTitle);
      if (entry) {
        entry.setsCount++;
        entry.lastPerformed = Math.max(entry.lastPerformed, set.startTime);
      } else {
        byExercise.set(set.exerciseTitle, {
          exerciseTitle: set.exerciseTitle,
          setsCount: 1,
          lastPerformed: set.startTime,
        });
      }
    }
    return [...byExercise.values()].sort((a, b) =>
      a.exerciseTitle.localeCompare(b.exerciseTitle),
    );
  },
});

/**
 * Returns every set for a given exercise, oldest first, for progression
 * charts.
 */
export const exerciseHistory = query({
  args: { exerciseTitle: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    return await ctx.db
      .query("workoutSets")
      .withIndex("by_user_and_exercise_and_startTime", (q) =>
        q.eq("userId", userId).eq("exerciseTitle", args.exerciseTitle),
      )
      .take(5000);
  },
});
