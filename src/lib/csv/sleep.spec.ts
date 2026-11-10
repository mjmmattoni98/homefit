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
		expect(parseSleepCsv(csv()).records[0]).toMatchObject({
			sleepQuality: 80,
			regularity: 85,
			timeAsleepSeconds: 25200
		});
		expect(
			parseSleepCsv('Went to bed;Woke up;Sleep quality\n2026-10-27 23:00:00;2026-10-28 07:00:00;0%')
				.records[0]
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
		{ 3: 'invalid' },
		{ 4: 'Infinity' },
		{ 6: 'unknown' },
		{ 0: '2026-10-28 23:00:00' },
		{ 0: '2026-02-30 23:00:00' },
		{ 1: '2026-13-28 07:00:00' },
		{ 1: '2026-10-28 25:00:00' }
	])('rejects an invalid row instead of importing it: %j', (overrides) => {
		expect(parseSleepCsv(csv(overrides))).toEqual({ records: [], invalidRows: [2] });
	});

	it('keeps valid rows before and after invalid rows', () => {
		const result = parseSleepCsv(
			`${csv()}\n${csv({ 2: '150%' }).split('\n')[1]}\n${valid.join(';')}`
		);
		expect(result.records).toHaveLength(2);
		expect(result.records.every((record) => record.sleepQuality === 80)).toBe(true);
		expect(result.invalidRows).toEqual([3]);
	});

	it('reports every invalid row, including an invalid first data row', () => {
		const result = parseSleepCsv(
			`${csv({ 2: '150%' })}\n${valid.join(';')}\n${csv({ 1: 'invalid' }).split('\n')[1]}`
		);
		expect(result.records).toHaveLength(1);
		expect(result.invalidRows).toEqual([2, 4]);
	});

	it('rejects an unrecognized export and accepts empty input without records', () => {
		expect(() => parseSleepCsv('wrong;headers\na;b')).toThrow('Not a Sleep Cycle export');
		expect(parseSleepCsv('')).toEqual({ records: [], invalidRows: [] });
	});
});
