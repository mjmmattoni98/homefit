import { eq } from 'drizzle-orm';
import type { Database, Transaction } from './db/types';
import { signupGate, user } from './db/schema';

export type SignupMode = 'first-user' | 'open' | 'closed';

/** Registration closed, possibly between the page being shown and the form being sent. */
export class SignupClosedError extends Error {
	constructor() {
		super('Sign-ups are disabled');
		this.name = 'SignupClosedError';
	}
}

export async function signupEnabled(db: Database, mode: SignupMode): Promise<boolean> {
	return (
		mode === 'open' ||
		(mode === 'first-user' && (await db.select({ id: user.id }).from(user).limit(1)).length === 0)
	);
}

/** Hold the singleton lock until account, credentials and session are committed together. */
export async function withSignupPolicy<T>(
	db: Database,
	mode: SignupMode,
	register: (tx: Transaction) => Promise<T>
): Promise<T> {
	return db.transaction(async (tx) => {
		await tx.insert(signupGate).values({ id: 1 }).onConflictDoNothing();
		await tx.select().from(signupGate).where(eq(signupGate.id, 1)).for('update');
		if (!(await signupEnabled(tx, mode))) throw new SignupClosedError();
		return register(tx);
	});
}
