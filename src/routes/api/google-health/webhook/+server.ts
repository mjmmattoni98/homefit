import { googleHealthConfig } from '#lib/server/config.js';
import { db } from '#lib/server/db/index.js';
import {
	MAX_WEBHOOK_SIGNATURE_LENGTH,
	acceptDelivery,
	readBoundedRawBody,
	webhookAuthorizationMatches
} from '#lib/server/google-health/webhook.js';
import { requestWebhookProcessing } from '#lib/server/jobs.js';
import type { RequestHandler } from './$types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Receives Google Health notifications. Requests are authenticated with the configured
 * `Authorization` header before the body is read, durably recorded, and acknowledged; their
 * signature is verified asynchronously before any data changes.
 */
export const POST: RequestHandler = async ({ request }) => {
	const expected = googleHealthConfig?.webhookAuthorization ?? null;
	if (expected === null) return new Response(null, { status: 404 });
	if (!webhookAuthorizationMatches(request.headers.get('authorization'), expected)) {
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
	// Subscriber verification: Google expects 201 for the authorized challenge.
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
		const { deliveryId } = await acceptDelivery(db, rawBody.value, signature);
		// Processing is idempotent, so a retried delivery safely re-enqueues its job.
		await requestWebhookProcessing(deliveryId);
		return new Response(null, { status: 204 });
	} catch {
		return new Response(null, { status: 503 });
	}
};
