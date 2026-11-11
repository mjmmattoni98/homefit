import { eq } from 'drizzle-orm';
import type { Database, Transaction } from './db/types';
import { csvSettings, user } from './db/schema';

export class ImportTimeZoneChangedError extends Error {}

export async function importTimeZone(
	db: Database,
	userId: string,
	browserZone: string
): Promise<string> {
	await db.insert(csvSettings).values({ userId, timeZone: browserZone }).onConflictDoNothing();
	const [row] = await db.select().from(csvSettings).where(eq(csvSettings.userId, userId));
	return row.timeZone;
}

export async function setImportTimeZone(
	db: Database,
	userId: string,
	timeZone: string
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update');
		await tx
			.insert(csvSettings)
			.values({ userId, timeZone })
			.onConflictDoUpdate({ target: csvSettings.userId, set: { timeZone } });
	});
}

/** Refuse batches parsed before another tab changed the saved zone. */
export async function withImportTimeZone<T>(
	db: Database,
	userId: string,
	expectedZone: string,
	write: (tx: Transaction) => Promise<T>
): Promise<T> {
	return db.transaction(async (tx) => {
		await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update');
		const [settings] = await tx.select().from(csvSettings).where(eq(csvSettings.userId, userId));
		if (settings?.timeZone !== expectedZone)
			throw new ImportTimeZoneChangedError('Import time zone changed; select the file again.');
		return write(tx);
	});
}
