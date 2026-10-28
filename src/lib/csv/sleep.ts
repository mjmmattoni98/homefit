import * as v from 'valibot';
import { parseDelimited, toLocalTimestamp, toNumber, toPercent } from './parse';
import { sleepRecordSchema, type ParsedSleepRecord } from './sleep-schema';

export type { ParsedSleepRecord } from './sleep-schema';

export class SleepCsvError extends Error {
	constructor(readonly row: number) {
		super(`Invalid sleep data on CSV row ${row}`);
	}
}

const HEADER_MAP = {
	wentToBed: 'went to bed',
	wokeUp: 'woke up',
	sleepQuality: 'sleep quality',
	timeInBed: 'time in bed (seconds)',
	timeAsleep: 'time asleep (seconds)',
	asleepAfter: 'asleep after (seconds)',
	regularity: 'regularity',
	didSnore: 'did snore',
	snoreTime: 'snore time (seconds)',
	steps: 'steps',
	weatherTemp: 'weather temperature',
	weatherType: 'weather type',
	city: 'city',
	movements: 'movements per hour',
	notes: 'notes',
	mood: 'mood'
} as const;

function emptyToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

/**
 * Parses a Sleep Cycle CSV export (semicolon separated, first row headers).
 * Rejects a file containing an invalid row before any records can be imported.
 */
export function parseSleepCsv(text: string): ParsedSleepRecord[] {
	const rows = parseDelimited(text, ';');
	if (rows.length < 2) return [];

	const headers = rows[0].map((h) => h.trim().toLowerCase());
	const col = (name: string) => headers.findIndex((h) => h.startsWith(name));
	const idx = Object.fromEntries(
		Object.entries(HEADER_MAP).map(([key, header]) => [key, col(header)])
	) as Record<keyof typeof HEADER_MAP, number>;

	if (idx.wentToBed === -1 || idx.wokeUp === -1 || idx.sleepQuality === -1) {
		throw new Error('Not a Sleep Cycle export');
	}

	const at = (row: string[], i: number) => (i === -1 ? undefined : row[i]);
	const records: ParsedSleepRecord[] = [];

	for (const [index, row] of rows.slice(1).entries()) {
		const wentToBed = toLocalTimestamp(at(row, idx.wentToBed));
		const wokeUp = toLocalTimestamp(at(row, idx.wokeUp));
		const sleepQuality = toPercent(at(row, idx.sleepQuality));
		if (wentToBed == null || wokeUp == null || sleepQuality == null) {
			throw new SleepCsvError(index + 2);
		}

		const notesRaw = emptyToUndefined(at(row, idx.notes));
		const parsed = v.safeParse(sleepRecordSchema, {
			wentToBed,
			wokeUp,
			sleepQuality,
			timeInBedSeconds: toNumber(at(row, idx.timeInBed)) ?? 0,
			timeAsleepSeconds: toNumber(at(row, idx.timeAsleep)) ?? 0,
			asleepAfterSeconds: toNumber(at(row, idx.asleepAfter)) ?? 0,
			regularity: toPercent(at(row, idx.regularity)),
			didSnore: at(row, idx.didSnore)?.trim().toLowerCase() === 'true',
			snoreTimeSeconds: toNumber(at(row, idx.snoreTime)) ?? 0,
			steps: toNumber(at(row, idx.steps)),
			weatherTempC: toNumber(at(row, idx.weatherTemp)),
			weatherType: emptyToUndefined(at(row, idx.weatherType)),
			city: emptyToUndefined(at(row, idx.city)),
			movementsPerHour: toNumber(at(row, idx.movements)),
			notes: notesRaw
				? notesRaw
						.split(':')
						.map((n) => n.trim())
						.filter(Boolean)
				: [],
			mood: emptyToUndefined(at(row, idx.mood))
		});
		if (!parsed.success) throw new SleepCsvError(index + 2);
		records.push(parsed.output);
	}
	return records;
}
