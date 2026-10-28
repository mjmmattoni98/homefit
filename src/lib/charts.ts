/**
 * Shared chart styling and data utilities.
 */
import {
	dayFromNumber,
	dayNumber,
	dayToDate,
	monthStart,
	previousMonth,
	weekStart
} from '#lib/days.js';
import { formatDate, formatDateLong, formatMonthAxis } from '#lib/format.js';

/** Explicit palette so charts don't fall back to the grayscale theme vars. */
export const CHART_COLORS = {
	quality: '#6366f1', // indigo
	asleep: '#10b981', // emerald
	inBed: '#94a3b8', // slate
	volume: '#f59e0b', // amber
	weight: '#8b5cf6' // violet
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_GAP_MS = 21 * DAY_MS;
// Above this span a time axis labels months instead of days.
const MONTH_TICKS_AFTER_MS = 120 * DAY_MS;

/**
 * Inserts an undefined-valued break point between two data points that are
 * more than `maxGapMs` apart, so line/area charts break cleanly instead of
 * drawing a misleading straight line across long periods without data.
 */
export function breakGaps<T extends Record<string, unknown> & { date: Date }>(
	data: T[],
	maxGapMs = DEFAULT_MAX_GAP_MS
): T[] {
	if (data.length < 2) return data;
	const result: T[] = [data[0]];
	for (let i = 1; i < data.length; i++) {
		const prev = data[i - 1];
		const curr = data[i];
		const gap = curr.date.getTime() - prev.date.getTime();
		if (gap > maxGapMs) {
			const breakPoint = { ...curr, date: new Date(prev.date.getTime() + gap / 2) };
			for (const key of Object.keys(breakPoint)) {
				if (key !== 'date') {
					(breakPoint as Record<string, unknown>)[key] = undefined;
				}
			}
			result.push(breakPoint);
		}
		result.push(curr);
	}
	return result;
}

/**
 * Returns a TicksConfig function that keeps at most `max` labels on a
 * categorical (band) axis, so date labels never overlap.
 */
export function sparseTicks(max = 6): (scale: { domain: () => unknown[] }) => unknown[] {
	return (scale) => {
		const values = scale.domain();
		const step = Math.max(1, Math.ceil(values.length / max));
		return values.filter((_, i) => i % step === 0);
	};
}

/**
 * Axis props for a time x axis over `data` (sorted by date): days for short spans, months and
 * years for longer ones, and labels that would collide are dropped.
 */
export function timeAxis(data: readonly { date: Date }[]) {
	const span = data.length < 2 ? 0 : data[data.length - 1].date.getTime() - data[0].date.getTime();
	const format = span > MONTH_TICKS_AFTER_MS ? formatMonthAxis : (ms: number) => formatDate(ms);
	return {
		format: (value: unknown) => (value instanceof Date ? format(value.getTime()) : String(value)),
		tickOcclusion: true
	};
}

/** Tooltip heading for a point on a date axis. */
export function tooltipDate(value: unknown): string {
	return value instanceof Date ? formatDateLong(value.getTime()) : String(value);
}

/**
 * Training volume per week (from Monday) or calendar month for the `count` periods up to the one
 * containing `today`, oldest first. Periods without training are kept with zero volume so breaks
 * stay visible.
 */
export function volumeByPeriod(
	days: readonly { day: string; volume: number }[],
	unit: 'week' | 'month',
	count: number,
	today: string
): { date: Date; volume: number }[] {
	const periodOf = unit === 'week' ? weekStart : monthStart;
	const periods: string[] = [];
	for (let period = periodOf(today); periods.length < count;) {
		periods.unshift(period);
		period = unit === 'week' ? dayFromNumber(dayNumber(period) - 7) : previousMonth(period);
	}
	const totals = new Map(periods.map((period) => [period, 0]));
	for (const { day, volume } of days) {
		const period = periodOf(day);
		const total = totals.get(period);
		if (total !== undefined) totals.set(period, total + volume);
	}
	return periods.map((period) => ({
		date: dayToDate(period),
		volume: Math.round(totals.get(period) ?? 0)
	}));
}
