import * as v from 'valibot';

const finite = v.pipe(v.number(), v.finite());
const timestamp = v.pipe(finite, v.minValue(-8.64e15), v.maxValue(8.64e15));
const nonnegative = v.pipe(finite, v.minValue(0));
const whole = v.pipe(nonnegative, v.integer());
const text = (max: number) => v.pipe(v.string(), v.maxLength(max));
const name = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500));

const workoutSetSchema = v.object({
	exerciseTitle: name,
	setIndex: whole,
	setType: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
	weightKg: v.optional(nonnegative),
	reps: v.optional(whole),
	distanceKm: v.optional(nonnegative),
	durationSeconds: v.optional(nonnegative),
	rpe: v.optional(v.pipe(nonnegative, v.maxValue(10))),
	supersetId: v.optional(text(100)),
	exerciseNotes: v.optional(text(2_000))
});

/** Shared validation for Hevy files and the remote import boundary. */
export const workoutSchema = v.pipe(
	v.object({
		title: name,
		startTime: timestamp,
		endTime: timestamp,
		description: v.optional(text(2_000)),
		sets: v.pipe(v.array(workoutSetSchema), v.minLength(1), v.maxLength(500))
	}),
	// Hevy exports minute precision, so a short workout can start and end in the same minute.
	v.check(
		(workout) => workout.endTime >= workout.startTime,
		'Workout end must not precede its start'
	)
);

export type ParsedWorkout = v.InferOutput<typeof workoutSchema>;
export type ParsedSet = ParsedWorkout['sets'][number];
