import * as v from 'valibot';

const finite = v.pipe(v.number(), v.finite());
const timestamp = v.pipe(finite, v.minValue(-8.64e15), v.maxValue(8.64e15));
const nonnegative = v.pipe(finite, v.minValue(0));
const percentage = v.pipe(nonnegative, v.maxValue(100));
const text = (max: number) => v.pipe(v.string(), v.maxLength(max));

/** Shared validation for CSV input and the remote import boundary. */
export const sleepRecordSchema = v.pipe(
	v.object({
		wentToBed: timestamp,
		wokeUp: timestamp,
		sleepQuality: percentage,
		timeInBedSeconds: nonnegative,
		timeAsleepSeconds: nonnegative,
		asleepAfterSeconds: nonnegative,
		regularity: v.optional(percentage),
		didSnore: v.boolean(),
		snoreTimeSeconds: nonnegative,
		steps: v.optional(nonnegative),
		weatherTempC: v.optional(finite),
		weatherType: v.optional(text(200)),
		city: v.optional(text(200)),
		movementsPerHour: v.optional(nonnegative),
		notes: v.pipe(v.array(text(500)), v.maxLength(100)),
		mood: v.optional(text(200))
	}),
	v.check((record) => record.wokeUp > record.wentToBed, 'Wake-up time must follow bedtime')
);

export type ParsedSleepRecord = v.InferOutput<typeof sleepRecordSchema>;
