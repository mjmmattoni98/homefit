import { describe, expect, it } from 'vitest';
import {
	dayFromNumber,
	dayNumber,
	dayToDate,
	monthNumber,
	monthStart,
	previousMonth,
	weekStart
} from './days';

describe('calendar days', () => {
	it('converts between dates and day numbers', () => {
		expect(dayNumber('1970-01-02')).toBe(1);
		expect(dayFromNumber(dayNumber('2026-10-27'))).toBe('2026-10-27');
		expect(dayNumber('2026-03-01') - dayNumber('2026-02-28')).toBe(1);
	});

	it('finds the Monday starting each week', () => {
		expect(weekStart('2026-10-22')).toBe('2026-10-19'); // Thursday
		expect(weekStart('2026-10-19')).toBe('2026-10-19'); // Monday
		expect(weekStart('2026-10-25')).toBe('2026-10-19'); // Sunday
		expect(weekStart('2026-01-01')).toBe('2025-12-29');
	});

	it('steps through months', () => {
		expect(monthStart('2026-10-27')).toBe('2026-10-01');
		expect(previousMonth('2026-10-01')).toBe('2026-09-01');
		expect(previousMonth('2026-01-01')).toBe('2025-12-01');
		expect(monthNumber('2026-01-15') - monthNumber('2025-11-30')).toBe(2);
	});

	it('maps a day to local midnight', () => {
		expect(dayToDate('2026-10-27')).toEqual(new Date(2026, 9, 27));
	});
});
