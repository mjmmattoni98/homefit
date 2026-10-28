import { createHash } from 'node:crypto';

const MAX_TRACKED_KEYS = 10_000;

/**
 * Fixed-window attempt counter kept in memory. Limits apply per process, which suits a single
 * self-hosted instance; replicas each enforce their own budget.
 */
export class RateLimiter {
	private readonly windows = new Map<string, { count: number; resetAt: number }>();

	constructor(
		private readonly limit: number,
		private readonly windowMs: number
	) {}

	/** Records an attempt for `key` and returns whether it is still within the limit. */
	consume(key: string, now = Date.now()): boolean {
		const window = this.windows.get(key);
		if (window === undefined || window.resetAt <= now) {
			if (this.windows.size >= MAX_TRACKED_KEYS) this.prune(now);
			this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
			return true;
		}
		window.count += 1;
		return window.count <= this.limit;
	}

	private prune(now: number): void {
		for (const [key, window] of this.windows) {
			if (window.resetAt <= now) this.windows.delete(key);
		}
		// Under a flood of distinct keys, forget the oldest windows rather than grow without bound.
		for (const key of this.windows.keys()) {
			if (this.windows.size < MAX_TRACKED_KEYS) break;
			this.windows.delete(key);
		}
	}
}

/**
 * Records a sign-in attempt for the client address, then for the email address. A blocked address
 * records nothing more, and emails are digested so arbitrary input cannot grow the tracked keys.
 */
export function consumeSignInAttempt(
	limiter: RateLimiter,
	address: string,
	email: string
): boolean {
	if (!limiter.consume(`ip:${address}`)) return false;
	const digest = createHash('sha256').update(email.toLowerCase()).digest('base64url');
	return limiter.consume(`email:${digest}`);
}

/** Password guesses: per client address, per email address and per signed-in user. */
export const credentialAttempts = new RateLimiter(10, 15 * 60 * 1000);

/** Requests to Better Auth's own HTTP endpoints under /api/auth, per client address. */
export const authEndpointRequests = new RateLimiter(60, 60 * 1000);
