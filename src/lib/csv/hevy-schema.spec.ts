import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { workoutSchema } from './hevy-schema';

const workout = {
	title: 'Training',
	startTime: 0,
	endTime: 3600_000,
	sets: [{ exerciseTitle: 'Squat', setIndex: 0, setType: 'normal', weightKg: 60, reps: 8 }]
};

describe('workout import boundary', () => {
	it.each([
		{ startTime: NaN },
		{ startTime: -Infinity },
		{ endTime: 9e15 },
		{ endTime: -1 },
		{ title: ' ' },
		{ sets: [] }
	])('rejects invalid workout values %j', (changes) => {
		expect(v.safeParse(workoutSchema, { ...workout, ...changes }).success).toBe(false);
	});

	it.each([
		{ setIndex: -1 },
		{ setIndex: 0.5 },
		{ exerciseTitle: ' ' },
		{ weightKg: -1 },
		{ reps: -1 },
		{ reps: 1.5 },
		{ distanceKm: -1 },
		{ durationSeconds: -1 },
		{ rpe: 11 },
		{ rpe: Infinity }
	])('rejects invalid set values %j', (changes) => {
		expect(
			v.safeParse(workoutSchema, {
				...workout,
				sets: [{ ...workout.sets[0], ...changes }]
			}).success
		).toBe(false);
	});

	it('accepts a short workout within the same exported minute', () => {
		expect(v.safeParse(workoutSchema, { ...workout, endTime: workout.startTime }).success).toBe(
			true
		);
	});

	it('accepts unloaded, timed, cardio and fractional RPE/weight values', () => {
		expect(
			v.safeParse(workoutSchema, {
				...workout,
				sets: [
					{ ...workout.sets[0], weightKg: 62.5, rpe: 8.5 },
					{ exerciseTitle: 'Push-up', setIndex: 0, setType: 'normal', reps: 0 },
					{
						exerciseTitle: 'Run',
						setIndex: 0,
						setType: 'normal',
						distanceKm: 5.2,
						durationSeconds: 1800
					},
					{ exerciseTitle: 'Plank', setIndex: 0, setType: 'normal', durationSeconds: 30 }
				]
			}).success
		).toBe(true);
	});
});
