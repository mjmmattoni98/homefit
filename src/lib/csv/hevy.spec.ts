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

		expect(workout.startTime).toBe(new Date(2026, 6, 17, 18, 35).getTime());
		expect(workout.endTime).toBe(new Date(2026, 6, 17, 19, 37).getTime());
	});

	it('reads month-first timestamps with a 12-hour clock', () => {
		const workouts = parseHevyCsv(
			csv(
				'"Back","Jul 17, 2026, 6:35 PM","Jul 17, 2026, 7:37 PM","","Lat Pulldown (Cable)",,"",0,"normal",55,11,,,',
				'"Back","Jul 17, 2026, 6:35 PM","Jul 17, 2026, 7:37 PM","","Lat Pulldown (Cable)",,"",1,"normal",55,10,,,'
			)
		);

		expect(workouts).toHaveLength(1);
		expect(workouts[0].startTime).toBe(new Date(2026, 6, 17, 18, 35).getTime());
		expect(workouts[0].endTime).toBe(new Date(2026, 6, 17, 19, 37).getTime());
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
		).toEqual([new Date(2023, 10, 17, 0, 5).getTime(), new Date(2023, 10, 17, 12, 30).getTime()]);
	});

	it('reads Spanish 12-hour suffixes', () => {
		expect(
			startTimes(
				csv(
					'"Noche","17 jul 2026, 6:35 p. m.","17 jul 2026, 7:37 p. m.","","Curl",,"",0,"normal",10,8,,,'
				)
			)
		).toEqual([new Date(2026, 6, 17, 18, 35).getTime()]);
	});

	it('skips rows whose timestamps cannot be read', () => {
		expect(
			parseHevyCsv(
				csv('"Back","2026-07-17 18:35","2026-07-17 19:37","","Curl",,"",0,"normal",10,8,,,')
			)
		).toEqual([]);
	});
});
