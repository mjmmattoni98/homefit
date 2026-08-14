import { httpRouter } from 'convex/server';
import { internal } from './_generated/api';
import { env, httpAction } from './_generated/server';

const CALLBACK_PATH = '/google-health/oauth/callback';
const IMPORT_PATH = '/dashboard/import';

function applicationOrigin(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	const isLocalHttp =
		url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
	if (
		(url.protocol !== 'https:' && !isLocalHttp) ||
		url.username !== '' ||
		url.password !== '' ||
		(url.pathname !== '/' && url.pathname !== '') ||
		url.search !== '' ||
		url.hash !== ''
	) {
		return null;
	}
	return url.origin;
}

function callbackRedirect(origin: string, status: 'connected' | 'error'): Response {
	return Response.redirect(`${origin}${IMPORT_PATH}?googleHealth=${status}`, 302);
}

const http = httpRouter();

http.route({
	path: CALLBACK_PATH,
	method: 'GET',
	handler: httpAction(async (ctx, request) => {
		const origin = applicationOrigin(env.HOMEFIT_APP_URL);
		if (origin === null) {
			return new Response('Google Health callback configuration error', { status: 500 });
		}

		const url = new URL(request.url);
		const codes = url.searchParams.getAll('code');
		const states = url.searchParams.getAll('state');
		if (
			codes.length !== 1 ||
			states.length !== 1 ||
			codes[0].length === 0 ||
			codes[0].length > 16_384 ||
			[...codes[0]].some((character) => {
				const characterCode = character.charCodeAt(0);
				return characterCode <= 31 || characterCode === 127;
			}) ||
			!/^[A-Za-z0-9_-]{43}$/.test(states[0])
		) {
			return callbackRedirect(origin, 'error');
		}

		try {
			await ctx.runAction(internal.googleHealth.oauth.completeOAuth, {
				code: codes[0],
				state: states[0]
			});
			return callbackRedirect(origin, 'connected');
		} catch {
			return callbackRedirect(origin, 'error');
		}
	})
});

export default http;
