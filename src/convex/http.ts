import { httpRouter } from 'convex/server';
import { internal } from './_generated/api';
import { env, httpAction } from './_generated/server';

const CALLBACK_PATH = '/google-health/oauth/callback';
const WEBHOOK_PATH = '/google-health/webhook';
const IMPORT_PATH = '/dashboard/import';
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

type RawBodyResult = { kind: 'ok'; value: string } | { kind: 'invalid' } | { kind: 'too_large' };

async function readBoundedRawBody(request: Request): Promise<RawBodyResult> {
	const contentLength = request.headers.get('content-length');
	if (contentLength !== null) {
		if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) return { kind: 'invalid' };
		if (Number(contentLength) > MAX_WEBHOOK_BODY_BYTES) return { kind: 'too_large' };
	}
	if (request.body === null) return { kind: 'invalid' };
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let complete = false;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) {
				complete = true;
				break;
			}
			total += result.value.byteLength;
			if (total > MAX_WEBHOOK_BODY_BYTES) return { kind: 'too_large' };
			chunks.push(result.value);
		}
	} finally {
		if (complete) reader.releaseLock();
		else void reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return {
			kind: 'ok',
			value: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
		};
	} catch {
		return { kind: 'invalid' };
	}
}

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
	return new Response(null, {
		status: 302,
		headers: {
			location: `${origin}${IMPORT_PATH}?googleHealth=${status}`,
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer'
		}
	});
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

http.route({
	path: WEBHOOK_PATH,
	method: 'POST',
	handler: httpAction(async (ctx, request) => {
		const rawBody = await readBoundedRawBody(request);
		if (rawBody.kind === 'too_large') return new Response(null, { status: 413 });
		if (rawBody.kind === 'invalid') return new Response(null, { status: 400 });
		try {
			const result = await ctx.runAction(internal.googleHealth.webhook.verifyAndQueue, {
				rawBody: rawBody.value,
				...(request.headers.get('authorization') === null
					? {}
					: { authorization: request.headers.get('authorization') ?? undefined }),
				...(request.headers.get('google-health-api-signature') === null
					? {}
					: { signature: request.headers.get('google-health-api-signature') ?? undefined })
			});
			switch (result.kind) {
				case 'verification':
					return new Response(null, { status: 201 });
				case 'notification':
					return new Response(null, { status: 204 });
				case 'unauthorized':
					return new Response(null, { status: 401 });
				case 'invalid':
					return new Response(null, { status: 400 });
				default: {
					const exhaustive: never = result;
					return exhaustive;
				}
			}
		} catch {
			return new Response(null, { status: 503 });
		}
	})
});

export default http;
