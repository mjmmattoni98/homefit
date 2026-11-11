import { describe, expect, it } from 'vitest';
import { parseHevyCsv } from './hevy';

const HEADER =
	'"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_kg","reps","distance_km","duration_seconds","rpe"';

function csv(...rows: string[]): string {
	return [HEADER, ...rows].join('\n');
}

function startTimes(text: string): number[] {
	return parseHevyCsv(text).map((workout) => workout.startTime);
}

describe('parseHevyCsv', () => {
	it('reads day-first timestamps with a 24-hour clock', () => {
		const [workout] = parseHevyCsv(
			csv('"Pierna","17 jul 2026, 18:35","17 jul 2026, 19:37","","Squat",,"",0,"normal",100,5,,,')
		);

		expect(workout.startTime).toBe(Date.UTC(2026, 6, 17, 18, 35));
		expect(workout.endTime).toBe(Date.UTC(2026, 6, 17, 19, 37));
	});

	it('reads month-first timestamps with a 12-hour clock', () => {
		const workouts = parseHevyCsv(
			csv(
				'"Back","Jul 17, 2026, 6:35 PM","Jul 17, 2026, 7:37 PM","","Lat Pulldown (Cable)",,"",0,"normal",55,11,,,',
				'"Back","Jul 17, 2026, 6:35 PM","Jul 17, 2026, 7:37 PM","","Lat Pulldown (Cable)",,"",1,"normal",55,10,,,'
			)
		);

		expect(workouts).toHaveLength(1);
		expect(workouts[0].startTime).toBe(Date.UTC(2026, 6, 17, 18, 35));
		expect(workouts[0].endTime).toBe(Date.UTC(2026, 6, 17, 19, 37));
		expect(workouts[0].sets).toMatchObject([
			{ exerciseTitle: 'Lat Pulldown (Cable)', setIndex: 0, weightKg: 55, reps: 11 },
			{ exerciseTitle: 'Lat Pulldown (Cable)', setIndex: 1, weightKg: 55, reps: 10 }
		]);
	});

	it('maps 12 AM to midnight and 12 PM to noon', () => {
		expect(
			startTimes(
				csv(
					'"Late","Nov 17, 2023, 12:05 AM","Nov 17, 2023, 1:00 AM","","Curl",,"",0,"normal",10,8,,,',
					'"Noon","Nov 17, 2023, 12:30 PM","Nov 17, 2023, 1:15 PM","","Curl",,"",0,"normal",10,8,,,'
				)
			)
		).toEqual([Date.UTC(2023, 10, 17, 0, 5), Date.UTC(2023, 10, 17, 12, 30)]);
	});

	it('reads Spanish 12-hour suffixes', () => {
		expect(
			startTimes(
				csv(
					'"Noche","17 jul 2026, 6:35 p. m.","17 jul 2026, 7:37 p. m.","","Curl",,"",0,"normal",10,8,,,'
				)
			)
		).toEqual([Date.UTC(2026, 6, 17, 18, 35)]);
	});

	it('rejects rows whose timestamps cannot be read', () => {
		expect(() =>
			parseHevyCsv(
				csv('"Back","2026-07-17 18:35","2026-07-17 19:37","","Curl",,"",0,"normal",10,8,,,')
			)
		).toThrow(/row 2/i);
	});
});

describe('Hevy invalid input', () => {
	const row = [
		'Back',
		'17 jul 2026, 18:35',
		'17 jul 2026, 19:37',
		'',
		'Curl',
		'',
		'',
		'0',
		'normal',
		'10',
		'8',
		'',
		'',
		'8'
	];
	const line = (values: string[]) => values.map((value) => JSON.stringify(value)).join(',');

	it.each([
		[1, '31 feb 2026, 18:35'],
		[1, '17 jul 2026, 25:35'],
		[1, '17 jul 2026, 18:99'],
		[1, '17 jul 2026, 18:35 garbage'],
		[2, '17 jul 2026, 17:00'],
		[4, ''],
		[7, '-1'],
		[7, '0.5'],
		[9, '-10'],
		[10, '-8'],
		[10, '2.5'],
		[10, 'invalid'],
		[11, '-1'],
		[12, '-120'],
		[13, '11']
	])('rejects invalid column %i value %s without partially accepting the file', (column, value) => {
		const invalid = row.map((field, index) => (index === column ? String(value) : field));
		expect(() => parseHevyCsv(csv(line(row), line(invalid)))).toThrow(/row 3/i);
	});
});
