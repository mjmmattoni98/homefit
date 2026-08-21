import { httpRouter } from 'convex/server';
import { internal } from './_generated/api';
import { env, httpAction } from './_generated/server';

const CALLBACK_PATH = '/google-health/oauth/callback';
const WEBHOOK_PATH = '/google-health/webhook';
const IMPORT_PATH = '/dashboard/import';
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const MAX_WEBHOOK_AUTHORIZATION_BYTES = 4096;
const MAX_WEBHOOK_SIGNATURE_LENGTH = 4096;
const WEBHOOK_BODY_TIMEOUT_MS = 5_000;

type RawBodyResult =
	| { kind: 'ok'; value: string }
	| { kind: 'invalid' }
	| { kind: 'too_large' }
	| { kind: 'timed_out' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function webhookAuthorizationMatches(received: string | null): boolean {
	if (received === null) return false;
	const expected = env.GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION;
	const encoder = new TextEncoder();
	const actualBytes = encoder.encode(received);
	const expectedBytes = encoder.encode(expected);
	if (
		actualBytes.byteLength === 0 ||
		actualBytes.byteLength > MAX_WEBHOOK_AUTHORIZATION_BYTES ||
		actualBytes.byteLength !== expectedBytes.byteLength
	) {
		return false;
	}
	let difference = 0;
	for (let index = 0; index < actualBytes.byteLength; index += 1) {
		difference |= actualBytes[index] ^ expectedBytes[index];
	}
	return difference === 0;
}

export async function readBoundedRawBody(request: Request): Promise<RawBodyResult> {
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
	let timedOut = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			timedOut = true;
			reject(new Error('Google Health webhook body timed out'));
		}, WEBHOOK_BODY_TIMEOUT_MS);
	});
	try {
		while (true) {
			const result = await Promise.race([reader.read(), timeout]);
			if (result.done) {
				complete = true;
				break;
			}
			total += result.value.byteLength;
			if (total > MAX_WEBHOOK_BODY_BYTES) return { kind: 'too_large' };
			chunks.push(result.value);
		}
	} catch {
		return { kind: timedOut ? 'timed_out' : 'invalid' };
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
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
		if (!webhookAuthorizationMatches(request.headers.get('authorization'))) {
			return new Response(null, { status: 401 });
		}
		const rawBody = await readBoundedRawBody(request);
		if (rawBody.kind === 'too_large') return new Response(null, { status: 413 });
		if (rawBody.kind === 'timed_out') return new Response(null, { status: 408 });
		if (rawBody.kind === 'invalid') return new Response(null, { status: 400 });
		let value: unknown;
		try {
			value = JSON.parse(rawBody.value);
		} catch {
			value = undefined;
		}
		if (isPlainObject(value) && 'type' in value) {
			return Object.keys(value).length === 1 && value.type === 'verification'
				? new Response(null, { status: 201 })
				: new Response(null, { status: 400 });
		}
		const signature = request.headers.get('google-health-api-signature');
		if (
			signature === null ||
			signature.length === 0 ||
			signature.length > MAX_WEBHOOK_SIGNATURE_LENGTH
		) {
			return new Response(null, { status: 401 });
		}
		try {
			await ctx.runMutation(internal.googleHealth.webhook.acceptDelivery, {
				rawBody: rawBody.value,
				signature
			});
			return new Response(null, { status: 204 });
		} catch {
			return new Response(null, { status: 503 });
		}
	})
});

export default http;
