import { getLocale } from '#lib/paraglide/runtime.js';

// Creating an Intl formatter is far slower than using one, and charts format every tick, bar and
// tooltip, so formatters are reused per locale and options.
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();

function dateFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const locale = getLocale();
	const key = `${locale}|${JSON.stringify(options)}`;
	let formatter = dateFormatters.get(key);
	if (formatter === undefined) {
		formatter = new Intl.DateTimeFormat(locale, options);
		dateFormatters.set(key, formatter);
	}
	return formatter;
}

export function formatDate(ms: number, options?: Intl.DateTimeFormatOptions): string {
	return dateFormatter(options ?? { day: 'numeric', month: 'short' }).format(ms);
}

export function formatDateLong(ms: number): string {
	return formatDate(ms, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Month and year ("Nov 2024") for axis labels on spans of several months. */
export function formatMonthAxis(ms: number): string {
	return formatDate(ms, { month: 'short', year: 'numeric' });
}

/** Formats seconds as "7.5 h". */
export function formatHours(seconds: number): string {
	return `${(seconds / 3600).toFixed(1)} h`;
}

export function formatNumber(n: number, maximumFractionDigits = 0): string {
	const locale = getLocale();
	const key = `${locale}|${maximumFractionDigits}`;
	let formatter = numberFormatters.get(key);
	if (formatter === undefined) {
		formatter = new Intl.NumberFormat(locale, { maximumFractionDigits });
		numberFormatters.set(key, formatter);
	}
	return formatter.format(n);
}

/** Formats a change with its sign: "+5.4", "−1.1", or "±0" when it rounds to nothing. */
export function formatSigned(n: number, maximumFractionDigits = 0): string {
	const rounded = Number(n.toFixed(maximumFractionDigits));
	if (rounded === 0) return '±0';
	return `${rounded > 0 ? '+' : '−'}${formatNumber(Math.abs(rounded), maximumFractionDigits)}`;
}

/** Formats large numbers compactly for axis labels: 1200 -> "1.2k", 15000 -> "15k". */
export function formatCompact(n: number): string {
	const abs = Math.abs(n);
	if (abs >= 1000) return `${(n / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
	return `${n}`;
}

/** Local calendar-day key used to match sleeps with workouts. */
export function dayKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Calendar-day key for the night a sleep belongs to. Nights starting between
 * midnight and 5 AM are attributed to the previous day, so an evening workout
 * still counts as the same "day" as the following night.
 */
export function sleepNightKey(wentToBedMs: number): string {
	const d = new Date(wentToBedMs);
	if (d.getHours() < 5) {
		d.setDate(d.getDate() - 1);
	}
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
