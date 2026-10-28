import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import type * as schema from './schema';

export type Schema = typeof schema;

/** Any Drizzle PostgreSQL database (node-postgres in the app, PGlite in tests). */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

export type Transaction = PgTransaction<
	PgQueryResultHKT,
	Schema,
	ExtractTablesWithRelations<Schema>
>;

/** A database or an open transaction. */
export type Executor = Database | Transaction;
