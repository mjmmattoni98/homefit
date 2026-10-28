import { parseDelimited, toNumber } from './parse';

export interface ParsedSet {
	exerciseTitle: string;
	setIndex: number;
	setType: string;
	weightKg?: number;
	reps?: number;
	distanceKm?: number;
	durationSeconds?: number;
	rpe?: number;
	supersetId?: string;
	exerciseNotes?: string;
}

export interface ParsedWorkout {
	title: string;
	startTime: number;
	endTime: number;
	description?: string;
	sets: ParsedSet[];
}

const MONTHS: Record<string, number> = {
	ene: 0,
	jan: 0,
	feb: 1,
	mar: 2,
	abr: 3,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	ago: 7,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dic: 11,
	dec: 11
};

// Hevy formats timestamps with the phone's locale, e.g. "17 jul 2026, 18:35" (day first) or
// "Jul 17, 2026, 6:35 PM" (month first), optionally with an AM/PM or "a. m."/"p. m." suffix.
const TIME = String.raw`(?<hour>\d{1,2}):(?<minute>\d{2})(?:\s*(?<meridiem>[ap])\.?\s*m\.?)?`;
const DAY_FIRST = new RegExp(
	String.raw`^(?<day>\d{1,2})\s+(?<month>[a-záéíóú]{3,})\.?\s+(?<year>\d{4}),?\s+${TIME}`,
	'i'
);
const MONTH_FIRST = new RegExp(
	String.raw`^(?<month>[a-záéíóú]{3,})\.?\s+(?<day>\d{1,2}),?\s+(?<year>\d{4}),?\s+${TIME}`,
	'i'
);

/** Parses a Hevy timestamp (Spanish or English month, 12- or 24-hour clock) into epoch ms. */
function toHevyTimestamp(value: string | undefined): number | undefined {
	if (value == null) return undefined;
	const text = value.trim();
	const groups = (DAY_FIRST.exec(text) ?? MONTH_FIRST.exec(text))?.groups;
	if (!groups) return undefined;
	const month = MONTHS[groups.month.toLowerCase().slice(0, 3)];
	if (month == null) return undefined;
	let hour = Number(groups.hour);
	if (groups.meridiem) {
		if (hour < 1 || hour > 12) return undefined;
		hour = (hour % 12) + (groups.meridiem.toLowerCase() === 'p' ? 12 : 0);
	}
	const date = new Date(
		Number(groups.year),
		month,
		Number(groups.day),
		hour,
		Number(groups.minute)
	);
	const time = date.getTime();
	return Number.isFinite(time) ? time : undefined;
}

function emptyToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

/**
 * Parses a Hevy CSV export (comma separated, quoted, first row headers) and
 * groups the set rows into workouts keyed by (title, start_time, end_time).
 */
export function parseHevyCsv(text: string): ParsedWorkout[] {
	const rows = parseDelimited(text, ',');
	if (rows.length < 2) return [];

	const headers = rows[0].map((h) => h.trim().toLowerCase());
	const col = (name: string) => headers.indexOf(name);

	const cTitle = col('title');
	const cStart = col('start_time');
	const cEnd = col('end_time');
	const cDesc = col('description');
	const cExercise = col('exercise_title');
	const cSuperset = col('superset_id');
	const cExNotes = col('exercise_notes');
	const cSetIndex = col('set_index');
	const cSetType = col('set_type');
	const cWeight = col('weight_kg');
	const cReps = col('reps');
	const cDistance = col('distance_km');
	const cDuration = col('duration_seconds');
	const cRpe = col('rpe');

	if (cTitle === -1 || cStart === -1 || cEnd === -1 || cExercise === -1) {
		throw new Error('Not a Hevy export');
	}

	const workouts = new Map<string, ParsedWorkout>();

	for (const row of rows.slice(1)) {
		const startTime = toHevyTimestamp(row[cStart]);
		const endTime = toHevyTimestamp(row[cEnd]);
		const title = row[cTitle]?.trim();
		if (startTime == null || endTime == null || !title) continue;

		const key = `${title}|${startTime}|${endTime}`;
		let workout = workouts.get(key);
		if (!workout) {
			workout = {
				title,
				startTime,
				endTime,
				description: emptyToUndefined(row[cDesc]),
				sets: []
			};
			workouts.set(key, workout);
		}

		const exerciseTitle = row[cExercise]?.trim();
		if (!exerciseTitle) continue;
		workout.sets.push({
			exerciseTitle,
			setIndex: toNumber(row[cSetIndex]) ?? 0,
			setType: row[cSetType]?.trim() || 'normal',
			weightKg: toNumber(row[cWeight]),
			reps: toNumber(row[cReps]),
			distanceKm: toNumber(row[cDistance]),
			durationSeconds: toNumber(row[cDuration]),
			rpe: toNumber(row[cRpe]),
			supersetId: emptyToUndefined(row[cSuperset]),
			exerciseNotes: emptyToUndefined(row[cExNotes])
		});
	}

	return [...workouts.values()].sort((a, b) => a.startTime - b.startTime);
}
