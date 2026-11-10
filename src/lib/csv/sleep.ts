import * as v from 'valibot';
import { parseDelimited, toLocalTimestamp, toNumber, toPercent } from './parse';
import { sleepRecordSchema, type ParsedSleepRecord } from './sleep-schema';

export type { ParsedSleepRecord } from './sleep-schema';

export interface SleepCsvResult {
	records: ParsedSleepRecord[];
	/** CSV record numbers including the header, starting at 1. */
	invalidRows: number[];
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
 * Keeps valid records and reports invalid rows so one bad night cannot block the export.
 */
export function parseSleepCsv(text: string): SleepCsvResult {
	const rows = parseDelimited(text, ';');
	const records: ParsedSleepRecord[] = [];
	const invalidRows: number[] = [];
	if (rows.length === 0) return { records, invalidRows };

	const headers = rows[0].map((h) => h.trim().toLowerCase());
	const col = (name: string) => headers.findIndex((h) => h.startsWith(name));
	const idx = Object.fromEntries(
		Object.entries(HEADER_MAP).map(([key, header]) => [key, col(header)])
	) as Record<keyof typeof HEADER_MAP, number>;

	if (idx.wentToBed === -1 || idx.wokeUp === -1 || idx.sleepQuality === -1) {
		throw new Error('Not a Sleep Cycle export');
	}

	const at = (row: string[], i: number) => (i === -1 ? undefined : row[i]);

	for (const [index, row] of rows.slice(1).entries()) {
		const wentToBed = toLocalTimestamp(at(row, idx.wentToBed));
		const wokeUp = toLocalTimestamp(at(row, idx.wokeUp));
		const sleepQuality = toPercent(at(row, idx.sleepQuality));
		if (wentToBed == null || wokeUp == null || sleepQuality == null) {
			invalidRows.push(index + 2);
			continue;
		}
		let invalidNumber = false;
		const numberAt = (column: number, parse = toNumber) => {
			const raw = at(row, column)?.trim();
			const value = parse(raw);
			if (raw && raw !== '—' && raw !== '-' && value === undefined) invalidNumber = true;
			return value;
		};

		const notesRaw = emptyToUndefined(at(row, idx.notes));
		const parsed = v.safeParse(sleepRecordSchema, {
			wentToBed,
			wokeUp,
			sleepQuality,
			timeInBedSeconds: numberAt(idx.timeInBed) ?? 0,
			timeAsleepSeconds: numberAt(idx.timeAsleep) ?? 0,
			asleepAfterSeconds: numberAt(idx.asleepAfter) ?? 0,
			regularity: numberAt(idx.regularity, toPercent),
			didSnore: at(row, idx.didSnore)?.trim().toLowerCase() === 'true',
			snoreTimeSeconds: numberAt(idx.snoreTime) ?? 0,
			steps: numberAt(idx.steps),
			weatherTempC: numberAt(idx.weatherTemp),
			weatherType: emptyToUndefined(at(row, idx.weatherType)),
			city: emptyToUndefined(at(row, idx.city)),
			movementsPerHour: numberAt(idx.movements),
			notes: notesRaw
				? notesRaw
						.split(':')
						.map((n) => n.trim())
						.filter(Boolean)
				: [],
			mood: emptyToUndefined(at(row, idx.mood))
		});
		if (!parsed.success || invalidNumber) {
			invalidRows.push(index + 2);
			continue;
		}
		records.push(parsed.output);
	}
	return { records, invalidRows };
}
