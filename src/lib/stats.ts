/** Mean of `values`, or null when there are none. */
export function mean(values: readonly number[]): number | null {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: readonly number[], average: number): number {
	return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
}

/** Two groups are only compared once each holds this many values. */
export const MIN_COMPARED_NIGHTS = 10;
/** Paired days needed before a correlation coefficient is reported. */
export const MIN_CORRELATION_DAYS = 20;

// Lanczos approximation, for positive arguments used by the beta distribution.
function logGamma(z: number): number {
	const coefficients = [
		676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
		12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7
	];
	if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
	z -= 1;
	let x = 0.9999999999998099;
	for (let i = 0; i < coefficients.length; i++) x += coefficients[i] / (z + i + 1);
	const t = z + 7.5;
	return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized incomplete beta via the modified Lentz continued fraction. */
export function regularizedBeta(x: number, a: number, b: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	if (x > (a + 1) / (a + b + 2)) return 1 - regularizedBeta(1 - x, b, a);
	const floor = (v: number) => (Math.abs(v) < 1e-300 ? 1e-300 : v);
	let c = 1;
	let d = 1 / floor(1 - ((a + b) * x) / (a + 1));
	let h = d;
	for (let m = 1; m <= 10000; m++) {
		const even = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
		d = 1 / floor(1 + even * d);
		c = floor(1 + even / c);
		h *= d * c;
		const odd = (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
		d = 1 / floor(1 + odd * d);
		c = floor(1 + odd / c);
		const delta = d * c;
		h *= delta;
		if (Math.abs(delta - 1) < 3e-14)
			return Math.max(
				0,
				Math.min(
					1,
					(Math.exp(
						logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x)
					) *
						h) /
						a
				)
			);
	}
	throw new Error('Incomplete beta did not converge');
}

export function studentTCdf(t: number, df: number): number {
	const tail = regularizedBeta(df / (df + t * t), df / 2, 0.5) / 2;
	return t >= 0 ? 1 - tail : tail;
}

/** Welch's two-sided t-test. Constant equal samples have p=1; unequal constants p=0. */
export function compareMeans(
	a: readonly number[],
	b: readonly number[],
	minimum = MIN_COMPARED_NIGHTS
): { difference: number; clear: boolean; t: number; df: number; p: number } | null {
	if (a.length < Math.max(2, minimum) || b.length < Math.max(2, minimum)) return null;
	const meanA = mean(a) ?? 0,
		meanB = mean(b) ?? 0;
	const va = sampleVariance(a, meanA) / a.length,
		vb = sampleVariance(b, meanB) / b.length;
	const difference = meanA - meanB;
	if (va + vb === 0)
		return {
			difference,
			clear: difference !== 0,
			t: difference === 0 ? 0 : Math.sign(difference) * Infinity,
			df: Infinity,
			p: difference === 0 ? 1 : 0
		};
	const t = difference / Math.sqrt(va + vb);
	const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
	// Compute the tail directly to avoid cancellation for strong evidence.
	const p = regularizedBeta(df / (df + t * t), df / 2, 0.5);
	return { difference, clear: p <= 0.05, t, df, p };
}

/** Benjamini–Hochberg step-up rejection indices for one family of comparisons. */
export function falseDiscoveryRejections(pValues: readonly number[], rate = 0.05): Set<number> {
	const ordered = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
	let last = -1;
	for (let i = 0; i < ordered.length; i++)
		if (ordered[i].p <= (rate * (i + 1)) / ordered.length) last = i;
	return new Set(ordered.slice(0, last + 1).map(({ index }) => index));
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
	minimum = MIN_CORRELATION_DAYS
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
