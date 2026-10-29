import { describe, expect, it } from 'vitest';
import { googleSleepDurations } from './sleep-durations';

describe('googleSleepDurations', () => {
	it('reads a top-level summary', () => {
		expect(
			googleSleepDurations({
				summary: {
					minutesInBed: 480,
					minutesAwake: 50,
					minutesDeep: 85,
					minutesLight: 245,
					minutesRem: 100
				}
			})
		).toEqual({
			inBedSeconds: 480 * 60,
			awakeSeconds: 50 * 60,
			deepSeconds: 85 * 60,
			lightSeconds: 245 * 60,
			remSeconds: 100 * 60
		});
	});

	it('reads the nested Google session and fills gaps from stages', () => {
		expect(
			googleSleepDurations({
				dataPointName: 'users/me/dataTypes/sleep/dataPoints/1',
				sleep: {
					type: 'STAGES',
					summary: { minutesAsleep: 430 },
					stages: [
						{
							type: 'DEEP',
							startTime: '2026-10-11T23:00:00Z',
							endTime: '2026-10-12T01:00:00Z'
						},
						{ stage: 'LIGHT', minutes: 30 },
						{ type: 'AWAKE', minutes: 10 }
					]
				}
			})
		).toEqual({
			inBedSeconds: null,
			awakeSeconds: 10 * 60,
			deepSeconds: 2 * 3600,
			lightSeconds: 30 * 60,
			remSeconds: null
		});
	});

	it('ignores a sleep object that is not a session', () => {
		expect(googleSleepDurations({ sleep: 'asleep', summary: { minutesDeep: 1 } })).toEqual({
			inBedSeconds: null,
			awakeSeconds: null,
			deepSeconds: 60,
			lightSeconds: null,
			remSeconds: null
		});
	});
});
