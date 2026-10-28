import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

// Arbitrary constant shared by every HomeFit instance so concurrent replicas migrate one at a time.
const MIGRATION_LOCK_KEY = 4_206_913_377;

export async function runMigrations(
	pool: pg.Pool,
	migrationsFolder = resolve(process.cwd(), 'drizzle')
): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
		try {
			await migrate(drizzle(client), { migrationsFolder });
		} finally {
			await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
		}
	} finally {
		client.release();
	}
}
