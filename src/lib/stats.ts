/** Mean of `values`, or null when there are none. */
export function mean(values: readonly number[]): number | null {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: readonly number[], average: number): number {
	return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
}

/**
 * Compares the means of two samples (`a` minus `b`). The difference is `clear` when it is larger
 * than about two standard errors (Welch), so it is unlikely to be ordinary variation between
 * nights. Returns null when either sample has fewer than `minimum` values (at least two).
 */
export function compareMeans(
	a: readonly number[],
	b: readonly number[],
	minimum = 2
): { difference: number; clear: boolean } | null {
	const required = Math.max(2, minimum);
	if (a.length < required || b.length < required) return null;
	const meanA = mean(a) ?? 0;
	const meanB = mean(b) ?? 0;
	const standardError = Math.sqrt(
		sampleVariance(a, meanA) / a.length + sampleVariance(b, meanB) / b.length
	);
	const difference = meanA - meanB;
	return { difference, clear: Math.abs(difference) > 2 * standardError };
}

/**
 * Relative change from `previous` to `current` (0.05 = 5 % more), or null when there is nothing
 * to compare against.
 */
export function relativeChange(current: number | null, previous: number | null): number | null {
	if (current === null || previous === null || previous === 0) return null;
	return (current - previous) / previous;
}

/**
 * Pearson correlation coefficient `r` in `[-1, 1]` across paired `(x, y)` observations, or null
 * when fewer than `minimum` pairs exist or either series has zero variance.
 */
export function pearsonCorrelation(
	pairs: readonly { x: number; y: number }[],
	minimum = 5
): number | null {
	if (pairs.length < Math.max(3, minimum)) return null;
	const meanX = mean(pairs.map((p) => p.x)) ?? 0;
	const meanY = mean(pairs.map((p) => p.y)) ?? 0;
	let cov = 0;
	let varX = 0;
	let varY = 0;
	for (const { x, y } of pairs) {
		const dx = x - meanX;
		const dy = y - meanY;
		cov += dx * dy;
		varX += dx * dx;
		varY += dy * dy;
	}
	const denom = Math.sqrt(varX * varY);
	if (denom === 0) return null;
	return Math.max(-1, Math.min(1, cov / denom));
}
