import { describe, expect, it } from 'vitest';
import { timeAxis } from './charts';
import { formatDate, formatMonthAxis } from './format';

// Local-time constructors keep these tests independent of the machine's time zone.
const at = (year: number, month: number, day: number, hour = 12) =>
	new Date(year, month - 1, day, hour).getTime();

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
		expect(long.tickSpacing).toBeGreaterThan(short.tickSpacing);
	});
});
