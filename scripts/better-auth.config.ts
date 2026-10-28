// Standalone Better Auth configuration used only by `bun run auth:schema`. The CLI cannot resolve
// SvelteKit virtual modules, so it loads the same factory the app uses with a mock database.
import { drizzle } from 'drizzle-orm/node-postgres';
import { createAuth } from '../src/lib/server/auth-config';
import type { Database } from '../src/lib/server/db/types';

export const auth = createAuth({
	db: drizzle.mock() as unknown as Database,
	baseURL: 'http://localhost',
	secret: 'schema-generation-only-secret-0123456789',
	disableSignUp: false
});
