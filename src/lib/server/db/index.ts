import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { building } from '$app/env';
import {
	GOOGLE_HEALTH_CLIENT_ID,
	GOOGLE_HEALTH_CLIENT_SECRET,
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY,
	HOMEFIT_INSTANCE,
	POSTGRES_DB,
	POSTGRES_HOST,
	POSTGRES_PASSWORD,
	POSTGRES_PORT,
	POSTGRES_USER
} from '$app/env/private';
import { assertInstanceBoundary } from '../instance';
import * as schema from './schema';
import { postgresConnectionString } from './url';

if (!building && process.env.VITEST === undefined) {
	assertInstanceBoundary({
		instance: HOMEFIT_INSTANCE,
		database: POSTGRES_DB,
		googleHealthClientId: GOOGLE_HEALTH_CLIENT_ID,
		googleHealthClientSecret: GOOGLE_HEALTH_CLIENT_SECRET,
		googleHealthEncryptionKey: GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY
	});
}

export const databaseUrl = postgresConnectionString({
	user: POSTGRES_USER,
	password: POSTGRES_PASSWORD,
	database: POSTGRES_DB,
	host: POSTGRES_HOST,
	port: POSTGRES_PORT
});

export const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });

export const db = drizzle(pool, { schema });
