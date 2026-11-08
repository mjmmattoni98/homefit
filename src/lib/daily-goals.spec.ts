import { describe, expect, it } from 'vitest';
import {
	WORKWEEK_MASK,
	evaluateDay,
	isScheduled,
	scheduleOn,
	summarizeHistory,
	targetOn,
	weekdayIndex,
	type DayTotals,
	type GoalRules,
	type ScheduleVersion
} from './daily-goals';

const workweek: ScheduleVersion[] = [{ effectiveFrom: '2026-10-01', weekdays: WORKWEEK_MASK }];
const pushUps: GoalRules = {
	id: 'push',
	archivedOn: null,
	targets: [
		{ effectiveFrom: '2026-11-04', target: 120 },
		{ effectiveFrom: '2026-10-01', target: 100 }
	]
};
const walk: GoalRules = {
	id: 'walk',
	archivedOn: null,
	targets: [{ effectiveFrom: '2026-10-01', target: 60 }]
};
const totals = (entries: Record<string, number>): DayTotals => new Map(Object.entries(entries));

describe('weekdayIndex', () => {
	it('counts from Monday', () => {
		expect(weekdayIndex('2026-11-02')).toBe(0);
		expect(weekdayIndex('2026-11-08')).toBe(6);
	});
});

describe('targetOn', () => {
	it('uses the latest version on or before the day', () => {
		expect(targetOn(pushUps, '2026-09-30')).toBeNull();
		expect(targetOn(pushUps, '2026-11-03')).toBe(100);
		expect(targetOn(pushUps, '2026-11-04')).toBe(120);
	});

	it('stops on the archive day', () => {
		const archived = { ...walk, archivedOn: '2026-11-05' };
		expect(targetOn(archived, '2026-11-04')).toBe(60);
		expect(targetOn(archived, '2026-11-05')).toBeNull();
	});
});

describe('schedule', () => {
	it('follows the version in effect', () => {
		const schedule = [
			...workweek,
			{ effectiveFrom: '2026-11-07', weekdays: WORKWEEK_MASK | (1 << 5) }
		];
		expect(isScheduled(schedule, '2026-10-31')).toBe(false);
		expect(isScheduled(schedule, '2026-11-02')).toBe(true);
		expect(isScheduled(schedule, '2026-11-07')).toBe(true);
		expect(isScheduled(schedule, '2026-11-08')).toBe(false);
		expect(scheduleOn(schedule, '2026-11-07')).toBe(WORKWEEK_MASK | (1 << 5));
	});

	it('schedules nothing before the first version', () => {
		expect(isScheduled([], '2026-11-02')).toBe(false);
		expect(scheduleOn(workweek, '2026-09-30')).toBeNull();
	});
});

describe('evaluateDay', () => {
	const today = '2026-11-06';

	it('is done when every active goal is met on a scheduled day', () => {
		const result = evaluateDay(
			[pushUps, walk],
			workweek,
			totals({ push: 100, walk: 75 }),
			'2026-11-03',
			today
		);
		expect(result.status).toBe('done');
		expect(
			result.goals.map((check) => [check.goal.id, check.target, check.total, check.met])
		).toEqual([
			['push', 100, 100, true],
			['walk', 60, 75, true]
		]);
	});

	it('judges each day by the target it had', () => {
		const result = evaluateDay([pushUps], workweek, totals({ push: 100 }), '2026-11-04', today);
		expect(result.status).toBe('missed');
	});

	it('keeps today in progress until every goal is met', () => {
		expect(evaluateDay([pushUps, walk], workweek, totals({ push: 120 }), today, today).status).toBe(
			'in-progress'
		);
		expect(
			evaluateDay([pushUps, walk], workweek, totals({ push: 120, walk: 60 }), today, today).status
		).toBe('done');
	});

	it('marks unscheduled days as rest and notes when every goal was met', () => {
		expect(
			evaluateDay([walk], workweek, totals({ walk: 60 }), '2026-11-07', '2026-11-08')
		).toMatchObject({ scheduled: false, status: 'rest', allMet: true });
		expect(evaluateDay([walk], workweek, undefined, '2026-11-08', '2026-11-08').status).toBe(
			'rest'
		);
	});

	it('counts a scheduled day without active goals as missed', () => {
		const archived = { ...walk, archivedOn: '2026-11-02' };
		expect(evaluateDay([archived], workweek, undefined, '2026-11-03', today)).toMatchObject({
			status: 'missed',
			allMet: false,
			goals: []
		});
	});

	it('leaves out goals that did not apply that day', () => {
		const plank: GoalRules = {
			id: 'plank',
			archivedOn: null,
			targets: [{ effectiveFrom: '2026-11-05', target: 120 }]
		};
		const result = evaluateDay([walk, plank], workweek, totals({ walk: 60 }), '2026-11-04', today);
		expect(result.goals.map((check) => check.goal.id)).toEqual(['walk']);
		expect(result.status).toBe('done');
	});
});

describe('summarizeHistory', () => {
	const goal: GoalRules = {
		id: 'walk',
		archivedOn: null,
		targets: [{ effectiveFrom: '2026-10-26', target: 60 }]
	};
	const schedule: ScheduleVersion[] = [{ effectiveFrom: '2026-10-26', weekdays: WORKWEEK_MASK }];
	const met = (...days: string[]) =>
		new Map<string, DayTotals>(days.map((day) => [day, totals({ walk: 60 })]));

	it('returns the window oldest first, ending today', () => {
		const history = summarizeHistory([goal], schedule, met(), '2026-11-08', 7);
		expect(history.days.map((day) => day.day)).toEqual([
			'2026-11-02',
			'2026-11-03',
			'2026-11-04',
			'2026-11-05',
			'2026-11-06',
			'2026-11-07',
			'2026-11-08'
		]);
	});

	it('keeps the streak across rest days and an unfinished today', () => {
		const history = summarizeHistory(
			[goal],
			schedule,
			met('2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'),
			'2026-11-06',
			14
		);
		expect(history.currentStreak).toBe(6);
		expect(history.bestStreak).toBe(6);
		expect(history.days.at(-1)).toEqual({
			day: '2026-11-06',
			status: 'in-progress',
			allMet: false
		});
	});

	it('resets on a missed day and remembers the best run', () => {
		const history = summarizeHistory(
			[goal],
			schedule,
			met(
				'2026-10-26',
				'2026-10-27',
				'2026-10-28',
				'2026-10-29',
				'2026-10-30',
				'2026-11-03',
				'2026-11-04',
				'2026-11-05'
			),
			'2026-11-05',
			14
		);
		expect(history.currentStreak).toBe(3);
		expect(history.bestStreak).toBe(5);
	});

	it('does not count goals met on rest days', () => {
		const history = summarizeHistory(
			[goal],
			schedule,
			met('2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'),
			'2026-11-02',
			7
		);
		expect(history.currentStreak).toBe(2);
		expect(history.days.find((day) => day.day === '2026-10-31')).toEqual({
			day: '2026-10-31',
			status: 'rest',
			allMet: true
		});
	});

	it('has no streak without goals', () => {
		expect(summarizeHistory([], [], new Map(), '2026-11-08', 3)).toEqual({
			days: [
				{ day: '2026-11-06', status: 'rest', allMet: false },
				{ day: '2026-11-07', status: 'rest', allMet: false },
				{ day: '2026-11-08', status: 'rest', allMet: false }
			],
			currentStreak: 0,
			bestStreak: 0
		});
	});
});
