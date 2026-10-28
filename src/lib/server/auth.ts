import { sveltekitCookies } from 'better-auth/svelte-kit';
import { building } from '$app/env';
import { getRequestEvent } from '$app/server';
import { BETTER_AUTH_SECRET, DISABLE_SIGNUP, ORIGIN } from '$app/env/private';
import { createAuth } from './auth-config';
import { googleHealthConfig } from './config';
import { db } from './db/index';
import { revokeUserAccess } from './google-health/connection';

// `vite build` imports server modules to analyse routes, without runtime secrets. Better Auth
// refuses to start without a secret, so the build uses a placeholder that never serves requests.
const BUILD_PLACEHOLDER_SECRET = 'build-time-placeholder-secret-never-used-at-runtime';

export const auth = createAuth({
	db,
	baseURL: building ? 'http://localhost' : ORIGIN,
	secret: building ? BUILD_PLACEHOLDER_SECRET : BETTER_AUTH_SECRET,
	disableSignUp: DISABLE_SIGNUP,
	// Imported data is removed by foreign-key cascades; revoke the Google grant first.
	beforeDeleteUser: async (userId) => {
		if (googleHealthConfig !== null) await revokeUserAccess(db, googleHealthConfig, userId);
	},
	// Must stay last so cookies set by other plugins are forwarded to SvelteKit.
	plugins: [sveltekitCookies(getRequestEvent)]
});

export type SessionUser = typeof auth.$Infer.Session.user;
