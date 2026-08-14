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

/** Parses "2025-05-11 23:34:36" (local time) into epoch ms. */
export function toLocalTimestamp(value: string | undefined): number | undefined {
	if (value == null) return undefined;
	const match = new RegExp(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/).exec(value
		.trim());
	if (!match) return undefined;
	const [, y, mo, d, h, mi, s] = match;
	const date = new Date(
		Number(y),
		Number(mo) - 1,
		Number(d),
		Number(h),
		Number(mi),
		Number(s ?? '0')
	);
	const time = date.getTime();
	return Number.isFinite(time) ? time : undefined;
}
