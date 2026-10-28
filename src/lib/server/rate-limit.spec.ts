import { describe, expect, it } from 'vitest';
import { RateLimiter, consumeSignInAttempt } from './rate-limit';

describe('RateLimiter', () => {
	it('allows the limit within a window, then blocks until the window resets', () => {
		const limiter = new RateLimiter(2, 1_000);
		expect([limiter.consume('a', 0), limiter.consume('a', 10), limiter.consume('a', 20)]).toEqual([
			true,
			true,
			false
		]);
		expect(limiter.consume('b', 20)).toBe(true);
		expect(limiter.consume('a', 1_000)).toBe(true);
	});

	it('records nothing for an email once the client address is blocked', () => {
		const limiter = new RateLimiter(1, 1_000);
		const email = `${'x'.repeat(100_000)}@example.com`;
		expect(consumeSignInAttempt(limiter, 'a', 'first@example.com')).toBe(true);
		expect(consumeSignInAttempt(limiter, 'a', email)).toBe(false);
		expect(consumeSignInAttempt(limiter, 'b', email.toUpperCase())).toBe(true);
		expect(consumeSignInAttempt(limiter, 'c', email)).toBe(false);
	});
});
