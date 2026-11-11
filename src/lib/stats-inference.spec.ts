import { describe, expect, it } from 'vitest';
import { compareMeans, falseDiscoveryRejections, regularizedBeta, studentTCdf } from './stats';

describe('Welch inference', () => {
	it('matches analytic and published t reference values', () => {
		expect(studentTCdf(1, 1)).toBeCloseTo(0.75, 12);
		expect(studentTCdf(-1, 1)).toBeCloseTo(0.25, 12);
		expect(studentTCdf(2.2281388519649385, 10)).toBeCloseTo(0.975, 10);
		expect(studentTCdf(1.9839715184496334, 100)).toBeCloseTo(0.975, 10);
		expect(regularizedBeta(0.5, 2, 2)).toBeCloseTo(0.5, 12);
		expect(regularizedBeta(0.2, 1, 1)).toBeCloseTo(0.2, 12);
		expect(regularizedBeta(0, 2, 3)).toBe(0);
		expect(regularizedBeta(1, 2, 3)).toBe(1);
	});
	it('does not use the normal approximation on tiny samples', () => {
		const result = compareMeans([1, 3], [4, 6], 2);
		expect(result?.t).toBeCloseTo(-2.1213203435596424, 12);
		expect(result?.df).toBeCloseTo(2, 12);
		expect(result?.p).toBeCloseTo(0.167949705662156, 12);
		expect(result?.clear).toBe(false);
	});
	it('defines equal and unequal zero-variance samples and one constant group', () => {
		expect(compareMeans([2, 2], [2, 2], 2)).toMatchObject({
			t: 0,
			df: Infinity,
			p: 1,
			clear: false
		});
		expect(compareMeans([3, 3], [2, 2], 2)).toMatchObject({
			t: Infinity,
			df: Infinity,
			p: 0,
			clear: true
		});
		expect(compareMeans([1, 1], [2, 4], 2)?.df).toBe(1);
	});
	it('uses BH step-up across the complete target family', () => {
		expect([...falseDiscoveryRejections([0.04, 0.001, 0.02, 0.8])]).toEqual([1, 2]);
		expect([...falseDiscoveryRejections([0.04, 0.049])]).toEqual([0, 1]);
		expect([...falseDiscoveryRejections([])]).toEqual([]);
	});
});
