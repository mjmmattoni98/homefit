import { describe, expect, it } from 'vitest';
import { formatSigned, splitUnit } from './format';

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

describe('splitUnit', () => {
	it('separates a number from the unit after it', () => {
		expect(splitUnit('126,868 kg')).toEqual({ number: '126,868', unit: 'kg' });
		expect(splitUnit('6.7 h')).toEqual({ number: '6.7', unit: 'h' });
		expect(splitUnit('16\u00a0breaths/min')).toEqual({ number: '16', unit: 'breaths/min' });
	});

	it('leaves values that are not one number and a unit whole', () => {
		expect(splitUnit('77%')).toEqual({ number: '77%', unit: '' });
		expect(splitUnit('1 h 30 min')).toEqual({ number: '1 h 30 min', unit: '' });
		expect(splitUnit('Recorded')).toEqual({ number: 'Recorded', unit: '' });
	});
});
