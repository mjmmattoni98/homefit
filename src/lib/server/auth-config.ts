import type { BetterAuthPlugin } from 'better-auth';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import type { Database } from './db/types';
import { account, session, user, verification } from './db/schema';

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Endpoints that check a password. HomeFit calls them only from its own rate-limited form
 * actions, or not at all; their JSON equivalents under `/api/auth` would let a client test
 * passwords without the per-account limits.
 */
export const SERVER_ONLY_AUTH_PATHS = [
	'/sign-in/email',
	'/sign-up/email',
	'/change-password',
	'/delete-user',
	'/verify-password'
];

export interface AuthSettings {
	db: Database;
	baseURL: string;
	secret: string;
	disableSignUp: boolean;
	/** Runs before a user and (by cascade) all of their data are deleted. */
	beforeDeleteUser?: (userId: string) => Promise<void>;
	plugins?: BetterAuthPlugin[];
}

/** HomeFit's Better Auth configuration: email and password accounts stored in PostgreSQL. */
export function createAuth(settings: AuthSettings) {
	return betterAuth({
		appName: 'HomeFit',
		baseURL: settings.baseURL,
		secret: settings.secret,
		// Only blocks HTTP requests; `auth.api` calls from the server are unaffected.
		disabledPaths: SERVER_ONLY_AUTH_PATHS,
		database: drizzleAdapter(settings.db, {
			provider: 'pg',
			schema: { user, session, account, verification }
		}),
		emailAndPassword: {
			enabled: true,
			disableSignUp: settings.disableSignUp,
			minPasswordLength: MIN_PASSWORD_LENGTH,
			autoSignIn: true
		},
		user: {
			deleteUser: {
				enabled: true,
				beforeDelete: async (deleted) => {
					await settings.beforeDeleteUser?.(deleted.id);
				}
			}
		},
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				// Better Auth would otherwise accept a recent session instead of the password, which
				// lets anyone with access to an unlocked browser erase the account and its data.
				const password: unknown = (ctx.body as { password?: unknown } | undefined)?.password;
				if (ctx.path === '/delete-user' && (typeof password !== 'string' || password === '')) {
					throw new APIError('BAD_REQUEST', {
						code: 'PASSWORD_REQUIRED',
						message: 'Enter your password to delete your account'
					});
				}
			})
		},
		plugins: settings.plugins ?? []
	});
}
