import { getLocale } from '$lib/paraglide/runtime';

export function formatDate(ms: number, options?: Intl.DateTimeFormatOptions): string {
	return new Date(ms).toLocaleDateString(
		getLocale(),
		options ?? { day: 'numeric', month: 'short' }
	);
}

export function formatDateLong(ms: number): string {
	return formatDate(ms, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Short date with 2-digit year ("17 nov 24") for axis labels on multi-year spans. */
export function formatDateAxis(ms: number): string {
	return formatDate(ms, { day: 'numeric', month: 'short', year: '2-digit' });
}

/** Formats seconds as "7.5 h". */
export function formatHours(seconds: number): string {
	return `${(seconds / 3600).toFixed(1)} h`;
}

export function formatNumber(n: number, maximumFractionDigits = 0): string {
	return n.toLocaleString(getLocale(), { maximumFractionDigits });
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
