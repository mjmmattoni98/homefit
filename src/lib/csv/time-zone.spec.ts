import { expect, it } from 'vitest';
import { toLocalTimestamp } from './parse';

it('reads named-zone wall times independently of process time zone', () => {
	const previous = process.env.TZ;
	try {
		for (const zone of ['Asia/Tokyo', 'America/New_York']) {
			process.env.TZ = zone;
			expect(toLocalTimestamp('2026-07-17 18:35', 'Europe/Madrid')).toBe(
				Date.parse('2026-07-17T16:35:00Z')
			);
		}
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
});
it('shifts DST gaps forward and chooses the first overlap instant', () => {
	expect(toLocalTimestamp('2026-03-29 02:30', 'Europe/Madrid')).toBe(
		Date.parse('2026-03-29T01:30:00Z')
	);
	expect(toLocalTimestamp('2026-10-25 02:30', 'Europe/Madrid')).toBe(
		Date.parse('2026-10-25T00:30:00Z')
	);
	expect(toLocalTimestamp('2026-02-30 10:00', 'Europe/Madrid')).toBeUndefined();
	expect(toLocalTimestamp('2026-01-01 10:00', 'Invalid/Zone')).toBeUndefined();
});
