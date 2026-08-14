import { GOOGLE_HEALTH_READ_SCOPES } from './registry';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const HEALTH_BASE_URL = 'https://health.googleapis.com/v4';
const REDACTED_ERROR_MESSAGE = 'Google Health request failed';
const SAFE_REMOTE_ERROR_CODE = /^[a-z][a-z0-9_.-]{0,79}$/;
const MAX_CREDENTIAL_LENGTH = 16_384;

type FetchImplementation = typeof fetch;
type JsonObject = Record<string, unknown>;

export interface GoogleTokenResult {
	accessToken: string;
	expiresIn: number;
	grantedScopes: string[];
	tokenType: 'Bearer';
}

export interface GoogleAuthorizationTokenResult extends GoogleTokenResult {
	refreshToken?: string;
}

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

async function responseError(response: Response): Promise<GoogleHealthError> {
	let code = `http_${response.status}`;
	try {
		const value: unknown = await response.json();
		if (isJsonObject(value) && typeof value.error === 'string') {
			code = value.error;
		}
	} catch {
		// The body is deliberately ignored. Status alone is sufficient and safe.
	}
	return new GoogleHealthError(
		code,
		response.status,
		response.status === 429 || response.status >= 500
	);
}

async function executeRequest(
	input: string,
	init: RequestInit,
	fetchImplementation: FetchImplementation = fetch
): Promise<Response> {
	let response: Response;
	try {
		response = await fetchImplementation(input, init);
	} catch {
		throw new GoogleHealthError('network_error', null, true);
	}
	if (!response.ok) throw await responseError(response);
	return response;
}

async function responseJsonObject(response: Response): Promise<JsonObject> {
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		throw invalidResponse(response.status);
	}
	if (!isJsonObject(value)) throw invalidResponse(response.status);
	return value;
}

function parseTokenResponse(
	value: JsonObject,
	status: number,
	allowRefreshToken: boolean
): GoogleAuthorizationTokenResult {
	const accessToken = requiredBoundedString(value.access_token);
	const expiresIn = value.expires_in;
	if (
		accessToken === null ||
		typeof expiresIn !== 'number' ||
		!Number.isInteger(expiresIn) ||
		expiresIn <= 0 ||
		value.token_type !== 'Bearer'
	) {
		throw invalidResponse(status);
	}

	const grantedScopes = parseGrantedScopes(value.scope, status);
	const refreshToken = allowRefreshToken ? requiredBoundedString(value.refresh_token) : null;
	if (allowRefreshToken && value.refresh_token !== undefined && refreshToken === null) {
		throw invalidResponse(status);
	}

	return {
		accessToken,
		expiresIn,
		grantedScopes,
		tokenType: 'Bearer',
		...(refreshToken === null ? {} : { refreshToken })
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
	const response = await executeRequest(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	return parseTokenResponse(await responseJsonObject(response), response.status, true);
}

export async function refreshAccessToken(args: {
	refreshToken: string;
	clientId: string;
	clientSecret: string;
}): Promise<GoogleTokenResult> {
	assertCredential(args.refreshToken);
	assertCredential(args.clientId);
	assertCredential(args.clientSecret);
	const body = new URLSearchParams({
		refresh_token: args.refreshToken,
		client_id: args.clientId,
		client_secret: args.clientSecret,
		grant_type: 'refresh_token'
	});
	const response = await executeRequest(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
	return parseTokenResponse(await responseJsonObject(response), response.status, false);
}

export async function getHealthIdentity(accessToken: string): Promise<{ healthUserId: string }> {
	assertCredential(accessToken);
	const response = await executeRequest(`${HEALTH_BASE_URL}/users/me/identity`, {
		method: 'GET',
		headers: { authorization: `Bearer ${accessToken}` }
	});
	const value = await responseJsonObject(response);
	const healthUserId = requiredBoundedString(value.healthUserId, 1024);
	if (healthUserId === null) throw invalidResponse(response.status);
	return { healthUserId };
}

export async function revokeGoogleToken(refreshToken: string): Promise<null> {
	assertCredential(refreshToken);
	await executeRequest(`${REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, {
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
	for (const [key, value] of Object.entries(query ?? {})) {
		if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw invalidRequest();
		if (value === undefined) continue;
		if (typeof value === 'number' && !Number.isFinite(value)) throw invalidRequest();
		url.searchParams.set(key, String(value));
	}
	return url.toString();
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
		headers['content-type'] = 'application/json';
	}
	const response = await executeRequest(healthPageUrl(args.path, args.query), {
		method,
		headers,
		...(body === undefined ? {} : { body })
	});
	return await responseJsonObject(response);
}
