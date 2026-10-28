import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { sleepRecordSchema } from './sleep-schema';

const valid = {
	wentToBed: Date.UTC(2026, 9, 27, 23),
	wokeUp: Date.UTC(2026, 9, 28, 7),
	sleepQuality: 80,
	timeInBedSeconds: 28800,
	timeAsleepSeconds: 25200,
	asleepAfterSeconds: 600,
	didSnore: false,
	snoreTimeSeconds: 0,
	notes: []
};

describe('remote sleep import validation', () => {
	it.each([
		{ sleepQuality: 150 },
		{ sleepQuality: -1 },
		{ regularity: 101 },
		{ timeInBedSeconds: -1 },
		{ timeAsleepSeconds: -1 },
		{ asleepAfterSeconds: -1 },
		{ snoreTimeSeconds: -1 },
		{ steps: -1 },
		{ movementsPerHour: -1 },
		{ wentToBed: valid.wokeUp },
		{ wokeUp: valid.wentToBed - 1 },
		{ wokeUp: Infinity },
		{ wentToBed: 9e15 },
		{ sleepQuality: NaN }
	])('rejects crafted invalid import data: %j', (overrides) => {
		expect(v.safeParse(sleepRecordSchema, { ...valid, ...overrides }).success).toBe(false);
	});

	it('accepts valid boundary values and negative temperatures', () => {
		expect(
			v.safeParse(sleepRecordSchema, {
				...valid,
				sleepQuality: 0,
				regularity: 100,
				weatherTempC: -10
			}).success
		).toBe(true);
	});
});
