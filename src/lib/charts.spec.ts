import { describe, expect, it } from 'vitest';
import { timeAxis, volumeByPeriod } from './charts';
import { formatDate, formatMonthAxis } from './format';

// Local-time constructors keep these tests independent of the machine's time zone.
const at = (year: number, month: number, day: number, hour = 12) =>
	new Date(year, month - 1, day, hour).getTime();

describe('volumeByPeriod', () => {
	const days = [
		{ day: '2026-09-01', volume: 9999 }, // Before the periods shown.
		{ day: '2026-10-06', volume: 300 },
		{ day: '2026-10-20', volume: 500 },
		{ day: '2026-10-21', volume: 1000.4 }
	];

	it('sums volume per Monday-based week, oldest first, keeping empty weeks', () => {
		// 2026-10-22 is a Thursday.
		expect(volumeByPeriod(days, 'week', 3, '2026-10-22')).toEqual([
			{ date: new Date(2026, 9, 5), volume: 300 },
			{ date: new Date(2026, 9, 12), volume: 0 },
			{ date: new Date(2026, 9, 19), volume: 1500 }
		]);
	});

	it('sums volume per calendar month across a year boundary', () => {
		expect(
			volumeByPeriod([{ day: '2025-12-31', volume: 10 }, ...days], 'month', 3, '2026-01-15')
		).toEqual([
			{ date: new Date(2025, 10, 1), volume: 0 },
			{ date: new Date(2025, 11, 1), volume: 10 },
			{ date: new Date(2026, 0, 1), volume: 0 }
		]);
		expect(volumeByPeriod(days, 'month', 2, '2026-10-22')).toEqual([
			{ date: new Date(2026, 8, 1), volume: 9999 },
			{ date: new Date(2026, 9, 1), volume: 1800 }
		]);
	});
});

describe('timeAxis', () => {
	it('labels days over short spans and months over long ones', () => {
		const point = new Date(at(2026, 3, 15));
		const short = timeAxis([
			{ date: new Date(at(2026, 3, 1)) },
			{ date: new Date(at(2026, 4, 1)) }
		]);
		const long = timeAxis([{ date: new Date(at(2025, 3, 1)) }, { date: new Date(at(2026, 4, 1)) }]);

		expect(short.format(point)).toBe(formatDate(point.getTime()));
		expect(long.format(point)).toBe(formatMonthAxis(point.getTime()));
	});
});
