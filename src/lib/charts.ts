/**
 * Shared chart styling and axis utilities.
 */
import { formatDate, formatDateLong, formatMonthAxis } from '#lib/format.js';

/**
 * Chart colours as theme variables, so they follow light and dark mode. Training is the sun on the
 * day ground; sleep is moonlight on the night field. Use them through `style:` (or a chart
 * config), not as SVG presentation attributes.
 */
export const CHART_COLORS = {
	quality: 'var(--color-sleep)',
	asleep: 'var(--color-sleep)',
	inBed: 'var(--color-sleep-dim)',
	volume: 'var(--color-sun)',
	weight: 'var(--color-sun)'
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
// Above this span a time axis labels months instead of days.
const MONTH_TICKS_AFTER_MS = 120 * DAY_MS;
// Pixels per tick label on a time axis.
const DAY_TICK_SPACING = 80;
const MONTH_TICK_SPACING = 120;

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
	const months = span > MONTH_TICKS_AFTER_MS;
	const format = months ? formatMonthAxis : (ms: number) => formatDate(ms);
	return {
		format: (value: unknown) => (value instanceof Date ? format(value.getTime()) : String(value)),
		// Month and year labels are wider than the default spacing allows on wide charts.
		tickSpacing: months ? MONTH_TICK_SPACING : DAY_TICK_SPACING,
		tickOcclusion: true
	};
}

/** Tooltip heading for a point on a date axis. */
export function tooltipDate(value: unknown): string {
	return value instanceof Date ? formatDateLong(value.getTime()) : String(value);
}
