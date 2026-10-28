import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../db/schema';
import type { Database } from '../db/types';

export interface TestDatabase {
	db: Database;
	close(): Promise<void>;
}

/** An in-process PostgreSQL (PGlite) with every migration applied. */
export async function createTestDatabase(): Promise<TestDatabase> {
	const client = new PGlite();
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
	return { db: db as unknown as Database, close: () => client.close() };
}

let userCounter = 0;

/** Inserts a Better Auth user row and returns its ID. */
export async function createUser(db: Database, name = 'Test user'): Promise<string> {
	userCounter += 1;
	const id = `user-${userCounter}-${Math.random().toString(36).slice(2, 8)}`;
	await db.insert(schema.user).values({ id, name, email: `${id}@example.com` });
	return id;
}
