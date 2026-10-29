import { describe, expect, it } from 'vitest';
import type { GoogleSleepNight, SleepNight } from '#lib/server/sleep.js';
import { compareSleepSources, eveningOffsetMinutes, formatEveningMinute } from './sleep-sources';

function scNight(
	night: string,
	bedIso: string,
	wakeIso: string,
	asleepMin: number,
	inBedMin: number,
	quality = 80
): SleepNight {
	return {
		night,
		wentToBed: Date.parse(bedIso),
		wokeUp: Date.parse(wakeIso),
		sleepQuality: quality,
		timeAsleepSeconds: asleepMin * 60,
		timeInBedSeconds: inBedMin * 60,
		notes: []
	};
}

function ghNight(
	night: string,
	startIso: string,
	endIso: string,
	asleepMin: number,
	inBedMin: number,
	stages?: { deepMin: number; lightMin: number; remMin: number; awakeMin: number }
): GoogleSleepNight {
	return {
		night,
		startTime: Date.parse(startIso),
		endTime: Date.parse(endIso),
		timeAsleepSeconds: asleepMin * 60,
		timeInBedSeconds: inBedMin * 60,
		...(stages
			? {
					deepSeconds: stages.deepMin * 60,
					lightSeconds: stages.lightMin * 60,
					remSeconds: stages.remMin * 60,
					awakeSeconds: stages.awakeMin * 60
				}
			: {})
	};
}

describe('eveningOffsetMinutes & formatEveningMinute', () => {
	it('places evenings before and after midnight on one monotonic scale', () => {
		const beforeMidnight = eveningOffsetMinutes(Date.parse('2026-10-10T23:30:00Z'), 'UTC');
		const afterMidnight = eveningOffsetMinutes(Date.parse('2026-10-11T00:30:00Z'), 'UTC');
		const morning = eveningOffsetMinutes(Date.parse('2026-10-11T07:45:00Z'), 'UTC');
		expect(beforeMidnight).toBe(330);
		expect(afterMidnight).toBe(390);
		expect(morning).toBe(825);
		expect(formatEveningMinute(beforeMidnight)).toBe('23:30');
		expect(formatEveningMinute(afterMidnight)).toBe('00:30');
		expect(formatEveningMinute(morning)).toBe('07:45');
	});
});

describe('compareSleepSources', () => {
	it('pairs overlapping Sleep Cycle and Google Health nights without summing them', () => {
		const sc = [
			// Started 23:50 UTC, woke 07:50 UTC (480m in bed, 440m asleep)
			scNight('2026-10-10', '2026-10-10T23:50:00Z', '2026-10-11T07:50:00Z', 440, 480),
			// Sleep Cycle only night
			scNight('2026-10-11', '2026-10-11T23:30:00Z', '2026-10-12T07:30:00Z', 450, 480)
		];
		const gh = [
			// Started 00:05 UTC (15 min later), woke 07:45 UTC (5 min earlier), 410m asleep, 460m in bed
			ghNight('2026-10-10', '2026-10-11T00:05:00Z', '2026-10-11T07:45:00Z', 410, 460, {
				deepMin: 80,
				lightMin: 240,
				remMin: 90,
				awakeMin: 50
			}),
			// Google Health only night
			ghNight('2026-10-12', '2026-10-12T23:40:00Z', '2026-10-13T07:20:00Z', 420, 460)
		];

		const summary = compareSleepSources(sc, gh, 'UTC');
		expect(summary.sharedNights).toBe(1);
		expect(summary.sleepCycleOnlyNights).toBe(1);
		expect(summary.googleOnlyNights).toBe(1);
		expect(summary.points).toHaveLength(3);

		// Sleep Cycle measured +30 min more asleep and +20 min more in bed on the shared night.
		expect(summary.meanSleepCycleAsleepMin).toBe(440);
		expect(summary.meanGoogleAsleepMin).toBe(410);
		expect(summary.asleepDeltaMin).toBe(30);
		expect(summary.asleepMeanAbsDiffMin).toBe(30);
		expect(summary.inBedDeltaMin).toBe(20);
		// Sleep Cycle went to bed 15 min earlier (-15) and woke 5 min later (+5).
		expect(summary.bedtimeOffsetMin).toBe(-15);
		expect(summary.wakeOffsetMin).toBe(5);
		expect(summary.googleStages).toEqual({
			nights: 1,
			deepMin: 80,
			lightMin: 240,
			remMin: 90,
			awakeMin: 50
		});
	});
});
