/**
 * Calendar dates as `YYYY-MM-DD` strings. Arithmetic runs on UTC day numbers, so results are the
 * same whether the page renders on the server or in the browser.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function parts(day: string): [number, number, number] {
	const [year, month, date] = day.split('-').map(Number);
	return [year, month, date];
}

/** Days since 1970-01-01. */
export function dayNumber(day: string): number {
	const [year, month, date] = parts(day);
	return Date.UTC(year, month - 1, date) / DAY_MS;
}

/** The date `n` days after 1970-01-01. */
export function dayFromNumber(n: number): string {
	return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday starting the week of `day`. */
export function weekStart(day: string): string {
	const n = dayNumber(day);
	// 1970-01-01 was a Thursday, the fourth day of a Monday-based week.
	return dayFromNumber(n - ((((n + 3) % 7) + 7) % 7));
}

/** Months since January of year 0, for counting months between dates. */
export function monthNumber(day: string): number {
	const [year, month] = parts(day);
	return year * 12 + month - 1;
}

/** The first day of the month of `day`. */
export function monthStart(day: string): string {
	return `${day.slice(0, 7)}-01`;
}

/** The first day of the month before the one starting on `start`. */
export function previousMonth(start: string): string {
	const [year, month] = parts(start);
	return month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, '0')}-01`;
}

/** Local midnight of `day`, for charts and formatting. */
export function dayToDate(day: string): Date {
	const [year, month, date] = parts(day);
	return new Date(year, month - 1, date);
}
