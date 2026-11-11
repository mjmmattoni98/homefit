import { Temporal } from '@js-temporal/polyfill';

/**
 * Minimal RFC-4180-style parser for delimited text (CSV/semicolon-CSV).
 * Handles quoted fields, escaped quotes ("") and CRLF line endings.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	let i = 0;

	while (i < text.length) {
		const c = text[i];

		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += c;
			i++;
			continue;
		}

		if (c === '"') {
			inQuotes = true;
			i++;
			continue;
		}
		if (c === delimiter) {
			row.push(field);
			field = '';
			i++;
			continue;
		}
		if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			field = '';
			// Skip completely empty lines
			if (row.length > 1 || row[0].trim() !== '') rows.push(row);
			row = [];
			i++;
			continue;
		}
		field += c;
		i++;
	}
	if (field !== '' || row.length > 0) {
		row.push(field);
		if (row.length > 1 || row[0].trim() !== '') rows.push(row);
	}
	return rows;
}

/** Parses a number, returning undefined for empty/invalid values. */
export function toNumber(value: string | undefined): number | undefined {
	if (value == null) return undefined;
	const cleaned = value.trim().replace(',', '.');
	if (cleaned === '' || cleaned === '—' || cleaned === '-') return undefined;
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : undefined;
}

/** Parses a percentage like "81%" into 81. */
export function toPercent(value: string | undefined): number | undefined {
	if (value == null) return undefined;
	return toNumber(value.replace('%', ''));
}

/** Named-zone wall times: choose the earlier overlap instant and shift gaps forward. */
export function toLocalTimestamp(value: string | undefined, timeZone = 'UTC'): number | undefined {
	if (!value || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value.trim()))
		return undefined;
	try {
		return Temporal.PlainDateTime.from(value.trim().replace(' ', 'T'), {
			overflow: 'reject'
		}).toZonedDateTime(timeZone, { disambiguation: 'compatible' }).epochMilliseconds;
	} catch {
		return undefined;
	}
}
