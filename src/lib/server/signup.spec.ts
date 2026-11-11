import { expect, it } from 'vitest';
import { createAuth } from './auth-config';
import { SignupClosedError, signupEnabled, withSignupPolicy } from './signup';
import { createTestDatabase } from './testing/database';

it('serializes first registrations and follows live account state', async () => {
	const database = await createTestDatabase();
	try {
		expect(await signupEnabled(database.db, 'first-user')).toBe(true);
		const results = await Promise.allSettled(
			[1, 2].map((i) =>
				withSignupPolicy(database.db, 'first-user', async (tx) => {
					const auth = createAuth({
						db: tx,
						baseURL: 'http://localhost:3000',
						secret: 'test-secret-0123456789abcdef0123456789',
						disableSignUp: false
					});
					return auth.api.signUpEmail({
						body: {
							name: 'Synthetic',
							email: `first-${i}@example.com`,
							password: 'synthetic-password-1'
						}
					});
				})
			)
		);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		const loser = results.find((r) => r.status === 'rejected');
		expect(loser?.reason).toBeInstanceOf(SignupClosedError);
		expect(await signupEnabled(database.db, 'first-user')).toBe(false);
		expect(await signupEnabled(database.db, 'open')).toBe(true);
		expect(await signupEnabled(database.db, 'closed')).toBe(false);
		await expect(withSignupPolicy(database.db, 'closed', async () => null)).rejects.toThrow(
			'disabled'
		);
	} finally {
		await database.close();
	}
});
