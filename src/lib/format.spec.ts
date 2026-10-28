import { describe, expect, it } from 'vitest';
import { formatSigned } from './format';

describe('formatSigned', () => {
	it('signs changes and rounds them to the given digits', () => {
		expect(formatSigned(5.44, 1)).toBe('+5.4');
		expect(formatSigned(-14.62, 1)).toBe('−14.6');
		expect(formatSigned(1234)).toBe('+1,234');
	});

	it('shows changes that round to zero as ±0', () => {
		expect(formatSigned(0.04, 1)).toBe('±0');
		expect(formatSigned(-0.4)).toBe('±0');
	});
});
