import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  sleepRecords: defineTable({
    userId: v.string(),
    wentToBed: v.number(), // epoch ms
    wokeUp: v.number(), // epoch ms
    sleepQuality: v.number(), // 0-100
    timeInBedSeconds: v.number(),
    timeAsleepSeconds: v.number(),
    asleepAfterSeconds: v.number(),
    regularity: v.optional(v.number()), // 0-100
    didSnore: v.boolean(),
    snoreTimeSeconds: v.number(),
    steps: v.optional(v.number()),
    weatherTempC: v.optional(v.number()),
    weatherType: v.optional(v.string()),
    city: v.optional(v.string()),
    movementsPerHour: v.optional(v.number()),
    notes: v.array(v.string()),
    mood: v.optional(v.string()),
  }).index("by_user_and_wokeUp", ["userId", "wokeUp"]),

  workouts: defineTable({
    userId: v.string(),
    title: v.string(),
    startTime: v.number(), // epoch ms
    endTime: v.number(), // epoch ms
    description: v.optional(v.string()),
  }).index("by_user_and_startTime", ["userId", "startTime"]),

  workoutSets: defineTable({
    workoutId: v.id("workouts"),
    userId: v.string(),
    // Denormalized from the parent workout so exercise history queries can
    // order by session date directly through the index.
    startTime: v.number(), // epoch ms
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
  })
    .index("by_workout", ["workoutId"])
    .index("by_user_and_exercise_and_startTime", [
      "userId",
      "exerciseTitle",
      "startTime",
    ]),
});
