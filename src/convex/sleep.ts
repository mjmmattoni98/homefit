import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireUserId } from "./helpers";

const sleepRecordInput = v.object({
  wentToBed: v.number(),
  wokeUp: v.number(),
  sleepQuality: v.number(),
  timeInBedSeconds: v.number(),
  timeAsleepSeconds: v.number(),
  asleepAfterSeconds: v.number(),
  regularity: v.optional(v.number()),
  didSnore: v.boolean(),
  snoreTimeSeconds: v.number(),
  steps: v.optional(v.number()),
  weatherTempC: v.optional(v.number()),
  weatherType: v.optional(v.string()),
  city: v.optional(v.string()),
  movementsPerHour: v.optional(v.number()),
  notes: v.array(v.string()),
  mood: v.optional(v.string()),
});

/**
 * Imports a batch of sleep records parsed from a Sleep Cycle CSV export.
 * Records are deduplicated by their `wokeUp` timestamp per user, so the
 * same export can be imported multiple times safely.
 */
export const importBatch = mutation({
  args: { records: v.array(sleepRecordInput) },
  returns: v.object({ imported: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);

    const existing = await ctx.db
      .query("sleepRecords")
      .withIndex("by_user_and_wokeUp", (q) => q.eq("userId", userId))
      .take(10000);
    const seen = new Set(existing.map((r) => r.wokeUp));

    let imported = 0;
    let skipped = 0;
    for (const record of args.records) {
      if (seen.has(record.wokeUp)) {
        skipped++;
        continue;
      }
      seen.add(record.wokeUp);
      await ctx.db.insert("sleepRecords", { userId, ...record });
      imported++;
    }
    return { imported, skipped };
  },
});

/**
 * Deletes every sleep record owned by the current user.
 */
export const removeAll = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const records = await ctx.db
      .query("sleepRecords")
      .withIndex("by_user_and_wokeUp", (q) => q.eq("userId", userId))
      .take(10000);
    for (const record of records) {
      await ctx.db.delete("sleepRecords", record._id);
    }
    return null;
  },
});

/**
 * Lists all sleep records for the current user, oldest first.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return await ctx.db
      .query("sleepRecords")
      .withIndex("by_user_and_wokeUp", (q) => q.eq("userId", userId))
      .take(10000);
  },
});
