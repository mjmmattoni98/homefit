import { defineConfig } from 'drizzle-kit';
import { postgresConnectionString } from './src/lib/server/db/url';

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		url: postgresConnectionString({
			user: process.env.POSTGRES_USER,
			password: process.env.POSTGRES_PASSWORD,
			database: process.env.POSTGRES_DB,
			host: process.env.POSTGRES_HOST,
			port: process.env.POSTGRES_PORT
		})
	},
	verbose: true,
	strict: true
});
