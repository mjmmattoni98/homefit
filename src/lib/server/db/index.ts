import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import {
	POSTGRES_DB,
	POSTGRES_HOST,
	POSTGRES_PASSWORD,
	POSTGRES_PORT,
	POSTGRES_USER
} from '$app/env/private';
import * as schema from './schema';
import { postgresConnectionString } from './url';

export const databaseUrl = postgresConnectionString({
	user: POSTGRES_USER,
	password: POSTGRES_PASSWORD,
	database: POSTGRES_DB,
	host: POSTGRES_HOST,
	port: POSTGRES_PORT
});

export const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });

export const db = drizzle(pool, { schema });
