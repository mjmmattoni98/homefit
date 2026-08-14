import { GOOGLE_HEALTH_READ_SCOPES } from './registry';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const HEALTH_BASE_URL = 'https://health.googleapis.com/v4';
const REDACTED_ERROR_MESSAGE = 'Google Health request failed';
const SAFE_REMOTE_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,79}$/;
const MAX_CREDENTIAL_LENGTH = 16_384;
const REQUEST_TIMEOUT_MS = 15_000;
const ERROR_RESPONSE_LIMIT_BYTES = 16 * 1024;
const JSON_RESPONSE_LIMIT_BYTES = 64 * 1024;
const HEALTH_PAGE_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_URL_BYTES = 32 * 1024;
const MAX_HEALTH_URL_BYTES = 8 * 1024;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_QUERY_ENTRIES = 32;
const MAX_QUERY_VALUE_LENGTH = 4096;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_REFRESH_TOKEN_LIFETIME_SECONDS = 10 * 365 * 24 * 60 * 60;

type JsonObject = Record<string, unknown>;

export interface GoogleTokenResult {
	accessToken: string;
	expiresIn: number;
	grantedScopes: string[];
	tokenType: 'Bearer';
	refreshToken?: string;
	refreshTokenExpiresIn?: number;
}

export type GoogleAuthorizationTokenResult = GoogleTokenResult;

export class GoogleHealthError extends Error {
	readonly code: string;
	readonly status: number | null;
	readonly retryable: boolean;

	constructor(code: string, status: number | null, retryable: boolean) {
		super(REDACTED_ERROR_MESSAGE);
		Object.defineProperty(this, 'name', { value: 'GoogleHealthError', configurable: true });
		this.code = sanitizeErrorCode(code, status);
		this.status = status;
		this.retryable = retryable;
	}
}

function sanitizeErrorCode(code: string, status: number | null): string {
	if (SAFE_REMOTE_ERROR_CODE.test(code)) return code;
	return status === null ? 'network_error' : `http_${status}`;
}

function invalidResponse(status: number): GoogleHealthError {
	return new GoogleHealthError('invalid_response', status, false);
}

function invalidRequest(): GoogleHealthError {
	return new GoogleHealthError('invalid_request', null, false);
}

function responseTooLarge(status: number): GoogleHealthError {
	return new GoogleHealthError('response_too_large', status, false);
}

function requestTimeout(): GoogleHealthError {
	return new GoogleHealthError('request_timeout', null, true);
}

function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredBoundedString(
	value: unknown,
	maximumLength = MAX_CREDENTIAL_LENGTH
): string | null {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > maximumLength ||
		value.trim() !== value
	) {
		return null;
	}
	return value;
}

function assertCredential(value: string): void {
	if (requiredBoundedString(value) === null) throw invalidRequest();
}

function assertRedirectUri(value: string): void {
	if (requiredBoundedString(value, 2048) === null) throw invalidRequest();
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalidRequest();
	}
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		url.hash !== '' ||
		url.search !== ''
	) {
		throw invalidRequest();
	}
}

function parseGrantedScopes(value: unknown, status: number): string[] {
	const rawScopes = requiredBoundedString(value, 16_384);
	if (rawScopes === null) throw invalidResponse(status);
	const approved = new Set(GOOGLE_HEALTH_READ_SCOPES);
	const seen = new Set<string>();
	const grantedScopes: string[] = [];
	for (const scope of rawScopes.trim().split(/\s+/)) {
		if (approved.has(scope) && !seen.has(scope)) {
			seen.add(scope);
			grantedScopes.push(scope);
		}
	}
	return grantedScopes;
}

function validateStoredGrantedScopes(scopes: readonly string[]): string[] {
	if (
		!Array.isArray(scopes) ||
		scopes.length === 0 ||
		scopes.length > GOOGLE_HEALTH_READ_SCOPES.length
	) {
		throw new GoogleHealthError('invalid_granted_scopes', null, false);
	}
	const approved = new Set(GOOGLE_HEALTH_READ_SCOPES);
	const seen = new Set<string>();
	const validated: string[] = [];
	for (const scope of scopes) {
		if (!approved.has(scope) || seen.has(scope)) {
			throw new GoogleHealthError('invalid_granted_scopes', null, false);
		}
		seen.add(scope);
		validated.push(scope);
	}
	return validated;
}

type RequestDeadline = {
	controller: AbortController;
	timedOut: () => boolean;
	expired: Promise<never>;
	finish: () => void;
};

function createRequestDeadline(): RequestDeadline {
	const controller = new AbortController();
	let didTimeOut = false;
	let rejectExpired: (reason: unknown) => void = () => undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		rejectExpired = reject;
	});
	const timeout = setTimeout(() => {
		didTimeOut = true;
		controller.abort();
		rejectExpired(requestTimeout());
	}, REQUEST_TIMEOUT_MS);
	return {
		controller,
		timedOut: () => didTimeOut,
		expired,
		finish: () => clearTimeout(timeout)
	};
}

function encodedByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function assertRequestBounds(input: string, init: RequestInit): void {
	if (encodedByteLength(input) > MAX_REQUEST_URL_BYTES) throw invalidRequest();
	if (init.body !== undefined) {
		if (typeof init.body !== 'string' || encodedByteLength(init.body) > MAX_REQUEST_BODY_BYTES) {
			throw invalidRequest();
		}
	}
}

function contentLength(response: Response): number | null {
	const header = response.headers.get('content-length');
	if (header === null) return null;
	if (!/^(0|[1-9][0-9]*)$/.test(header)) throw invalidResponse(response.status);
	const length = Number(header);
	if (!Number.isSafeInteger(length)) throw invalidResponse(response.status);
	return length;
}

async function boundedResponseBytes(
	response: Response,
	limit: number,
	deadline: RequestDeadline
): Promise<Uint8Array> {
	const declaredLength = contentLength(response);
	if (declaredLength !== null && declaredLength > limit) throw responseTooLarge(response.status);
	if (response.body === null) throw invalidResponse(response.status);

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let complete = false;
	try {
		while (true) {
			const result = await Promise.race([reader.read(), deadline.expired]);
			if (result.done) {
				complete = true;
				break;
			}
			total += result.value.byteLength;
			if (total > limit) throw responseTooLarge(response.status);
			chunks.push(result.value);
		}
	} finally {
		if (complete) {
			reader.releaseLock();
		} else {
			void reader.cancel().catch(() => undefined);
		}
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function boundedJsonObject(
	response: Response,
	limit: number,
	deadline: RequestDeadline
): Promise<JsonObject> {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(
			await boundedResponseBytes(response, limit, deadline)
		);
	} catch (error) {
		if (error instanceof GoogleHealthError) throw error;
		if (deadline.timedOut()) throw requestTimeout();
		throw invalidResponse(response.status);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw invalidResponse(response.status);
	}
	if (!isJsonObject(value)) throw invalidResponse(response.status);
	return value;
}

async function responseError(
	response: Response,
	deadline: RequestDeadline
): Promise<GoogleHealthError> {
	let code = `http_${response.status}`;
	try {
		const value = await boundedJsonObject(response, ERROR_RESPONSE_LIMIT_BYTES, deadline);
		if (typeof value.error === 'string') code = value.error;
	} catch (error) {
		if (
			error instanceof GoogleHealthError &&
			(error.code === 'response_too_large' || error.code === 'request_timeout')
		) {
			throw error;
		}
		// Malformed error bodies are ignored; status remains the safe source of truth.
	}
	return new GoogleHealthError(
		code,
		response.status,
		response.status === 429 || response.status >= 500
	);
}

async function executeRequest<Result>(
	input: string,
	init: RequestInit,
	consume: (response: Response, deadline: RequestDeadline) => Promise<Result>
): Promise<Result> {
	assertRequestBounds(input, init);
	const deadline = createRequestDeadline();
	try {
		const response = await Promise.race([
			fetch(input, { ...init, signal: deadline.controller.signal }),
			deadline.expired
		]);
		if (!response.ok) throw await responseError(response, deadline);
		return await consume(response, deadline);
	} catch (error) {
		if (error instanceof GoogleHealthError) throw error;
		if (deadline.timedOut()) throw requestTimeout();
		throw new GoogleHealthError('network_error', null, true);
	} finally {
		deadline.finish();
	}
}

async function requestJsonObject(
	input: string,
	init: RequestInit,
	responseLimit = JSON_RESPONSE_LIMIT_BYTES
): Promise<{ value: JsonObject; status: number }> {
	return await executeRequest(input, init, async (response, deadline) => ({
		value: await boundedJsonObject(response, responseLimit, deadline),
		status: response.status
	}));
}

async function requestWithoutResponseBody(input: string, init: RequestInit): Promise<void> {
	await executeRequest(input, init, async () => undefined);
}

function boundedLifetime(value: unknown, maximum: number, status: number): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > maximum) {
		throw invalidResponse(status);
	}
	return value;
}

function parseTokenResponse(
	value: JsonObject,
	status: number,
	scopeFallback?: readonly string[]
): GoogleAuthorizationTokenResult {
	const accessToken = requiredBoundedString(value.access_token);
	if (accessToken === null || value.token_type !== 'Bearer') {
		throw invalidResponse(status);
	}

	const expiresIn = boundedLifetime(value.expires_in, MAX_ACCESS_TOKEN_LIFETIME_SECONDS, status);
	let grantedScopes: string[];
	if (value.scope === undefined) {
		if (scopeFallback === undefined) throw invalidResponse(status);
		grantedScopes = validateStoredGrantedScopes(scopeFallback);
	} else {
		grantedScopes = parseGrantedScopes(value.scope, status);
	}
	const refreshToken =
		value.refresh_token === undefined ? null : requiredBoundedString(value.refresh_token);
	if (value.refresh_token !== undefined && refreshToken === null) {
		throw invalidResponse(status);
	}
	const refreshTokenExpiresIn =
		value.refresh_token_expires_in === undefined
			? null
			: boundedLifetime(value.refresh_token_expires_in, MAX_REFRESH_TOKEN_LIFETIME_SECONDS, status);

	return {
		accessToken,
		expiresIn,
		grantedScopes,
		tokenType: 'Bearer',
		...(refreshToken === null ? {} : { refreshToken }),
		...(refreshTokenExpiresIn === null ? {} : { refreshTokenExpiresIn })
	};
}

export function buildAuthorizationUrl(args: {
	clientId: string;
	redirectUri: string;
	state: string;
}): string {
	assertCredential(args.clientId);
	assertRedirectUri(args.redirectUri);
	if (!/^[A-Za-z0-9_-]{43}$/.test(args.state)) throw invalidRequest();

	const url = new URL(AUTH_URL);
	url.searchParams.set('client_id', args.clientId);
	url.searchParams.set('redirect_uri', args.redirectUri);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('scope', GOOGLE_HEALTH_READ_SCOPES.join(' '));
	url.searchParams.set('access_type', 'offline');
	url.searchParams.set('include_granted_scopes', 'true');
	url.searchParams.set('prompt', 'consent');
	url.searchParams.set('state', args.state);
	return url.toString();
}

export async function exchangeAuthorizationCode(args: {
	code: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}): Promise<GoogleAuthorizationTokenResult> {
	assertCredential(args.code);
	assertCredential(args.clientId);
	assertCredential(args.clientSecret);
	assertRedirectUri(args.redirectUri);
	const body = new URLSearchParams({
		code: args.code,
		client_id: args.clientId,
		client_secret: args.clientSecret,
		redirect_uri: args.redirectUri,
		grant_type: 'authorization_code'
	});
	const response = await requestJsonObject(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	return parseTokenResponse(response.value, response.status);
}

export async function refreshAccessToken(args: {
	refreshToken: string;
	clientId: string;
	clientSecret: string;
	grantedScopes: readonly string[];
}): Promise<GoogleTokenResult> {
	assertCredential(args.refreshToken);
	assertCredential(args.clientId);
	assertCredential(args.clientSecret);
	const grantedScopes = validateStoredGrantedScopes(args.grantedScopes);
	const body = new URLSearchParams({
		refresh_token: args.refreshToken,
		client_id: args.clientId,
		client_secret: args.clientSecret,
		grant_type: 'refresh_token'
	});
	const response = await requestJsonObject(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	return parseTokenResponse(response.value, response.status, grantedScopes);
}

export async function getHealthIdentity(accessToken: string): Promise<{ healthUserId: string }> {
	assertCredential(accessToken);
	const response = await requestJsonObject(`${HEALTH_BASE_URL}/users/me/identity`, {
		method: 'GET',
		headers: { authorization: `Bearer ${accessToken}` }
	});
	const healthUserId = response.value.healthUserId;
	if (typeof healthUserId !== 'string' || !/^[A-Za-z0-9-]{1,63}$/.test(healthUserId)) {
		throw invalidResponse(response.status);
	}
	return { healthUserId };
}

export async function revokeGoogleToken(refreshToken: string): Promise<null> {
	assertCredential(refreshToken);
	await requestWithoutResponseBody(`${REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' }
	});
	return null;
}

export interface FetchHealthPageArgs {
	accessToken: string;
	path: string;
	method?: 'GET' | 'POST';
	query?: Readonly<Record<string, string | number | undefined>>;
	body?: unknown;
}

function healthPageUrl(path: string, query?: FetchHealthPageArgs['query']): string {
	if (
		path.length > 2048 ||
		!/^\/users\/me\/[A-Za-z0-9._~:/-]+$/.test(path) ||
		path.includes('..')
	) {
		throw invalidRequest();
	}
	const url = new URL(`${HEALTH_BASE_URL}${path}`);
	const entries = Object.entries(query ?? {});
	if (entries.length > MAX_QUERY_ENTRIES) throw invalidRequest();
	for (const [key, value] of entries) {
		if (key.length > 64 || !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw invalidRequest();
		if (value === undefined) continue;
		if (typeof value === 'number' && !Number.isFinite(value)) throw invalidRequest();
		const stringValue = String(value);
		if (encodedByteLength(stringValue) > MAX_QUERY_VALUE_LENGTH) throw invalidRequest();
		url.searchParams.set(key, stringValue);
	}
	const result = url.toString();
	if (encodedByteLength(result) > MAX_HEALTH_URL_BYTES) throw invalidRequest();
	return result;
}

export async function fetchHealthPage(args: FetchHealthPageArgs): Promise<JsonObject> {
	assertCredential(args.accessToken);
	const method = args.method ?? 'GET';
	if (method === 'GET' && args.body !== undefined) throw invalidRequest();
	const headers: Record<string, string> = { authorization: `Bearer ${args.accessToken}` };
	let body: string | undefined;
	if (args.body !== undefined) {
		try {
			body = JSON.stringify(args.body);
		} catch {
			throw invalidRequest();
		}
		if (body === undefined) throw invalidRequest();
		if (encodedByteLength(body) > MAX_REQUEST_BODY_BYTES) throw invalidRequest();
		headers['content-type'] = 'application/json';
	}
	const response = await requestJsonObject(
		healthPageUrl(args.path, args.query),
		{
			method,
			headers,
			...(body === undefined ? {} : { body })
		},
		HEALTH_PAGE_RESPONSE_LIMIT_BYTES
	);
	return response.value;
}
