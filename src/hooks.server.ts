import { sequence, type Handle, type ServerInit } from '@sveltejs/kit/hooks';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { building } from '$app/env';
import { BACKGROUND_JOBS, RUN_MIGRATIONS } from '$app/env/private';
import { getTextDirection } from '#lib/paraglide/runtime.js';
import { paraglideMiddleware } from '#lib/paraglide/server.js';
import { auth } from '#lib/server/auth.js';
import { googleHealthConfig } from '#lib/server/config.js';
import { databaseUrl, db, pool } from '#lib/server/db/index.js';
import { runMigrations } from '#lib/server/db/migrate.js';
import { startJobs, stopJobs } from '#lib/server/jobs.js';
import { authEndpointRequests } from '#lib/server/rate-limit.js';

export const init: ServerInit = async () => {
	if (building) return;
	if (RUN_MIGRATIONS) await runMigrations(pool);
	if (googleHealthConfig !== null) {
		await startJobs({
			connectionString: databaseUrl,
			db,
			googleHealth: googleHealthConfig,
			worker: BACKGROUND_JOBS
		});
	}
	process.once('sveltekit:shutdown', async () => {
		await stopJobs();
		await pool.end();
	});
};

const handleRateLimit: Handle = async ({ event, resolve }) => {
	if (
		event.request.method === 'POST' &&
		event.url.pathname.startsWith('/api/auth/') &&
		!authEndpointRequests.consume(event.getClientAddress())
	) {
		return new Response('Too many requests', { status: 429, headers: { 'retry-after': '60' } });
	}
	return resolve(event);
};

const handleAuth: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });
	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}
	return svelteKitHandler({ event, resolve, auth, building });
};

const handleParaglide: Handle = ({ event, resolve }) =>
	paraglideMiddleware(event.request, ({ request, locale }) => {
		return resolve(
			{ ...event, request },
			{
				transformPageChunk: ({ html }) =>
					html
						.replace('%paraglide.lang%', locale)
						.replace('%paraglide.dir%', getTextDirection(locale))
			}
		);
	});

const handleSecurityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	try {
		response.headers.set('x-content-type-options', 'nosniff');
		response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
		response.headers.set('x-frame-options', 'DENY');
	} catch {
		// Responses created with `Response.redirect()` have immutable headers.
	}
	return response;
};

export const handle: Handle = sequence(
	handleSecurityHeaders,
	handleRateLimit,
	handleAuth,
	handleParaglide
);
