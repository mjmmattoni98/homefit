import { googleHealthConfig } from '#lib/server/config.js';
import { db } from '#lib/server/db/index.js';
import { IMPORT_RETURN_PATH, completeConnection } from '#lib/server/google-health/connection.js';
import { requestSync } from '#lib/server/jobs.js';
import type { RequestHandler } from './$types';

function backToImport(status: 'connected' | 'error'): Response {
	return new Response(null, {
		status: 302,
		headers: {
			location: `${IMPORT_RETURN_PATH}?googleHealth=${status}`,
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer'
		}
	});
}

function isSafeCode(code: string): boolean {
	return (
		code.length > 0 &&
		code.length <= 16_384 &&
		![...code].some((character) => {
			const characterCode = character.charCodeAt(0);
			return characterCode <= 31 || characterCode === 127;
		})
	);
}

export const GET: RequestHandler = async ({ url, locals }) => {
	if (googleHealthConfig === null) return new Response('Not found', { status: 404 });
	const codes = url.searchParams.getAll('code');
	const states = url.searchParams.getAll('state');
	if (
		locals.user === undefined ||
		codes.length !== 1 ||
		states.length !== 1 ||
		!isSafeCode(codes[0]) ||
		!/^[A-Za-z0-9_-]{43}$/.test(states[0])
	) {
		return backToImport('error');
	}
	try {
		const { connectionId } = await completeConnection(db, googleHealthConfig, {
			code: codes[0],
			state: states[0],
			userId: locals.user.id
		});
		// The connection is saved; if enqueueing fails, the per-minute dispatcher starts the import.
		await requestSync(connectionId).catch((error: unknown) => {
			console.error('[google-health] could not enqueue the initial import', error);
		});
		return backToImport('connected');
	} catch {
		return backToImport('error');
	}
};
