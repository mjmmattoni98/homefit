import { describe, expect, it } from 'vitest';
import { compareMeans, mean, relativeChange } from './stats';

describe('mean', () => {
	it('averages values and has none for an empty list', () => {
		expect(mean([70, 80, 90])).toBe(80);
		expect(mean([])).toBeNull();
	});
});

describe('compareMeans', () => {
	it('calls a difference clear only when it exceeds ordinary variation', () => {
		const noisy = [60, 90, 70, 85, 65, 80, 75, 72];
		const similar = [62, 88, 71, 84, 66, 79, 76, 70];
		const higher = [88, 92, 90, 91, 89, 93, 90, 92];

		expect(compareMeans(noisy, similar)).toEqual({ difference: 0.125, clear: false });
		expect(compareMeans(higher, noisy)).toMatchObject({ clear: true });
		expect(compareMeans(noisy, higher)?.difference).toBeLessThan(0);
	});

	it('needs enough values in both samples', () => {
		expect(compareMeans([80], [70, 75])).toBeNull();
		expect(compareMeans([80, 82, 81], [70, 75, 72], 4)).toBeNull();
		expect(compareMeans([80, 82, 81, 83], [70, 75, 72, 71], 4)).not.toBeNull();
	});
});

describe('relativeChange', () => {
	it('compares with the previous value when there is one', () => {
		expect(relativeChange(110, 100)).toBeCloseTo(0.1);
		expect(relativeChange(90, 100)).toBeCloseTo(-0.1);
		expect(relativeChange(5, 0)).toBeNull();
		expect(relativeChange(null, 100)).toBeNull();
		expect(relativeChange(100, null)).toBeNull();
	});
});
