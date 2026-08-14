/**
 * Shared chart styling utilities.
 */

/** Explicit palette so charts don't fall back to the grayscale theme vars. */
export const CHART_COLORS = {
	quality: '#6366f1', // indigo
	asleep: '#10b981', // emerald
	inBed: '#94a3b8', // slate
	volume: '#f59e0b', // amber
	weight: '#8b5cf6' // violet
} as const;

const DEFAULT_MAX_GAP_MS = 21 * 24 * 60 * 60 * 1000;

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
