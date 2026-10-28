import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { SERVER_ONLY_AUTH_PATHS, createAuth } from './auth-config';
import { sleepRecord, user } from './db/schema';
import { importSleepRecords } from './sleep';
import { createTestDatabase, type TestDatabase } from './testing/database';

let database: TestDatabase;

beforeAll(async () => {
	database = await createTestDatabase();
});

afterAll(async () => {
	await database.close();
});

async function signUp(auth: ReturnType<typeof createAuth>, email: string) {
	const { headers, response } = await auth.api.signUpEmail({
		body: { name: 'Owner', email, password: 'correct-horse-1' },
		returnHeaders: true
	});
	const cookie = headers.get('set-cookie')?.split(';')[0] ?? '';
	return { userId: response.user.id, headers: new Headers({ cookie }) };
}

describe('authentication policy', () => {
	it('requires the password to delete an account, even with a fresh session', async () => {
		const beforeDeleteUser = vi.fn(async () => undefined);
		const auth = createAuth({
			db: database.db,
			baseURL: 'http://localhost:3000',
			secret: 'test-secret-0123456789abcdef0123456789',
			disableSignUp: false,
			beforeDeleteUser
		});
		const { userId, headers } = await signUp(auth, 'delete-me@example.com');
		await importSleepRecords(database.db, userId, [
			{
				wentToBed: 0,
				wokeUp: 8 * 3_600_000,
				sleepQuality: 80,
				timeInBedSeconds: 28_800,
				timeAsleepSeconds: 25_200,
				asleepAfterSeconds: 600,
				didSnore: false,
				snoreTimeSeconds: 0,
				notes: []
			}
		]);

		await expect(auth.api.deleteUser({ body: {}, headers })).rejects.toMatchObject({
			body: { code: 'PASSWORD_REQUIRED' }
		});
		await expect(
			auth.api.deleteUser({ body: { password: 'wrong-password' }, headers })
		).rejects.toThrow();
		expect(await database.db.select().from(user).where(eq(user.id, userId))).toHaveLength(1);

		await auth.api.deleteUser({ body: { password: 'correct-horse-1' }, headers });
		expect(beforeDeleteUser).toHaveBeenCalledWith(userId);
		expect(await database.db.select().from(user).where(eq(user.id, userId))).toEqual([]);
		// Imported data goes with the account.
		expect(
			await database.db.select().from(sleepRecord).where(eq(sleepRecord.userId, userId))
		).toEqual([]);
	});

	it('keeps credential endpoints behind the rate-limited form actions', async () => {
		const auth = createAuth({
			db: database.db,
			baseURL: 'http://localhost:3000',
			secret: 'test-secret-0123456789abcdef0123456789',
			disableSignUp: false
		});
		await signUp(auth, 'forms-only@example.com');
		for (const path of SERVER_ONLY_AUTH_PATHS) {
			const response = await auth.handler(
				new Request(`http://localhost:3000/api/auth${path}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
					body: JSON.stringify({ email: 'forms-only@example.com', password: 'correct-horse-1' })
				})
			);
			expect(response.status, path).toBe(404);
		}
		// The server-side API used by the form actions still works.
		await expect(
			auth.api.signInEmail({
				body: { email: 'forms-only@example.com', password: 'correct-horse-1' }
			})
		).resolves.toMatchObject({ user: { email: 'forms-only@example.com' } });
	});

	it('does not let a signed-in client test passwords over HTTP', async () => {
		const auth = createAuth({
			db: database.db,
			baseURL: 'http://localhost:3000',
			secret: 'test-secret-0123456789abcdef0123456789',
			disableSignUp: false
		});
		const { headers } = await signUp(auth, 'verify-password@example.com');
		headers.set('content-type', 'application/json');
		headers.set('origin', 'http://localhost:3000');
		const response = await auth.handler(
			new Request('http://localhost:3000/api/auth/verify-password', {
				method: 'POST',
				headers,
				body: JSON.stringify({ password: 'wrong-password' })
			})
		);
		expect(response.status).toBe(404);
	});

	it('refuses new accounts when sign-up is disabled', async () => {
		const auth = createAuth({
			db: database.db,
			baseURL: 'http://localhost:3000',
			secret: 'test-secret-0123456789abcdef0123456789',
			disableSignUp: true
		});
		await expect(signUp(auth, 'closed@example.com')).rejects.toThrow();
	});
});
