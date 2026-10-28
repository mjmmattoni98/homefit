import { describe, expect, it } from 'vitest';
import { parseSleepCsv } from './sleep';

const columns = [
	'Went to bed',
	'Woke up',
	'Sleep quality',
	'Time in bed (seconds)',
	'Time asleep (seconds)',
	'Asleep after (seconds)',
	'Regularity',
	'Snore time (seconds)'
];
const valid = [
	'2026-10-27 23:00:00',
	'2026-10-28 07:00:00',
	'80%',
	'28800',
	'25200',
	'600',
	'85%',
	'0'
];

function csv(overrides: Partial<Record<number, string>> = {}): string {
	return [columns.join(';'), valid.map((value, index) => overrides[index] ?? value).join(';')].join(
		'\n'
	);
}

describe('Sleep Cycle input validation', () => {
	it('preserves valid exports and optional columns', () => {
		expect(parseSleepCsv(csv())[0]).toMatchObject({
			sleepQuality: 80,
			regularity: 85,
			timeAsleepSeconds: 25200
		});
		expect(
			parseSleepCsv(
				'Went to bed;Woke up;Sleep quality\n2026-10-27 23:00:00;2026-10-28 07:00:00;0%'
			)[0]
		).toMatchObject({ sleepQuality: 0, timeInBedSeconds: 0, timeAsleepSeconds: 0 });
	});

	it.each([
		{ 2: '150%' },
		{ 2: '-1%' },
		{ 6: '101%' },
		{ 3: '-3600' },
		{ 4: '-7200' },
		{ 5: '-60' },
		{ 7: '-30' },
		{ 0: '2026-10-28 23:00:00' },
		{ 0: '2026-02-30 23:00:00' },
		{ 1: '2026-13-28 07:00:00' },
		{ 1: '2026-10-28 25:00:00' }
	])('rejects an invalid row instead of importing it: %j', (overrides) => {
		expect(() => parseSleepCsv(csv(overrides))).toThrow(/row 2/i);
	});

	it('does not partially accept a file containing a bad later row', () => {
		expect(() => parseSleepCsv(`${csv()}\n${csv({ 2: '150%' }).split('\n')[1]}`)).toThrow(/row 3/i);
	});
});
