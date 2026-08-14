import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	GoogleHealthError,
	buildAuthorizationUrl,
	exchangeAuthorizationCode,
	fetchHealthPage,
	getHealthIdentity,
	refreshAccessToken,
	revokeGoogleToken
} from './apiClient';
import { GOOGLE_HEALTH_READ_SCOPES } from './registry';

const CLIENT_ID = 'google-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'google-client-secret';
const REDIRECT_URI = 'https://example.convex.site/google-health/oauth/callback';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('Google Health API client', () => {
	it('builds the exact offline authorization request for all seven read-only scopes', () => {
		const authorizationUrl = buildAuthorizationUrl({
			clientId: CLIENT_ID,
			redirectUri: REDIRECT_URI,
			state: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'
		});
		const url = new URL(authorizationUrl);

		expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			response_type: 'code',
			scope: GOOGLE_HEALTH_READ_SCOPES.join(' '),
			access_type: 'offline',
			include_granted_scopes: 'true',
			prompt: 'consent',
			state: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'
		});
		expect(GOOGLE_HEALTH_READ_SCOPES).toHaveLength(7);
		expect(GOOGLE_HEALTH_READ_SCOPES.every((scope) => scope.endsWith('.readonly'))).toBe(true);
	});

	it('exchanges an authorization code with the exact form contract and validates granted scopes', async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				access_token: 'access-token',
				refresh_token: 'refresh-token',
				expires_in: 3599,
				scope: `${GOOGLE_HEALTH_READ_SCOPES[0]} https://www.googleapis.com/auth/unrelated.readonly ${GOOGLE_HEALTH_READ_SCOPES[6]}`,
				token_type: 'Bearer'
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			exchangeAuthorizationCode({
				code: 'authorization-code',
				clientId: CLIENT_ID,
				clientSecret: CLIENT_SECRET,
				redirectUri: REDIRECT_URI
			})
		).resolves.toEqual({
			accessToken: 'access-token',
			refreshToken: 'refresh-token',
			expiresIn: 3599,
			grantedScopes: [GOOGLE_HEALTH_READ_SCOPES[0], GOOGLE_HEALTH_READ_SCOPES[6]],
			tokenType: 'Bearer'
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [input, init] = fetchMock.mock.calls[0];
		expect(input).toBe('https://oauth2.googleapis.com/token');
		expect(init).toMatchObject({
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' }
		});
		expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
			code: 'authorization-code',
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			redirect_uri: REDIRECT_URI,
			grant_type: 'authorization_code'
		});
	});

	it('refreshes access with the exact form contract and never returns a persisted refresh token', async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				access_token: 'new-access-token',
				expires_in: 3600,
				scope: GOOGLE_HEALTH_READ_SCOPES.join(' '),
				token_type: 'Bearer'
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			refreshAccessToken({
				refreshToken: 'stored-refresh-token',
				clientId: CLIENT_ID,
				clientSecret: CLIENT_SECRET
			})
		).resolves.toEqual({
			accessToken: 'new-access-token',
			expiresIn: 3600,
			grantedScopes: [...GOOGLE_HEALTH_READ_SCOPES],
			tokenType: 'Bearer'
		});

		const [input, init] = fetchMock.mock.calls[0];
		expect(input).toBe('https://oauth2.googleapis.com/token');
		expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
			refresh_token: 'stored-refresh-token',
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			grant_type: 'refresh_token'
		});
	});

	it('gets the stable Health identity through the bearer-authenticated v4 endpoint', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ healthUserId: 'health-user-123' }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(getHealthIdentity('ephemeral-access-token')).resolves.toEqual({
			healthUserId: 'health-user-123'
		});
		expect(fetchMock).toHaveBeenCalledWith('https://health.googleapis.com/v4/users/me/identity', {
			method: 'GET',
			headers: { authorization: 'Bearer ephemeral-access-token' }
		});
	});

	it('provides a bounded relative Health-page seam and rejects malformed success JSON', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ dataPoints: [], nextPageToken: 'next' }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			fetchHealthPage({
				accessToken: 'ephemeral-access-token',
				path: '/users/me/dataTypes/steps/dataPoints:reconcile',
				method: 'GET',
				query: { pageSize: 1000, pageToken: 'page-token', omitted: undefined }
			})
		).resolves.toEqual({ dataPoints: [], nextPageToken: 'next' });
		expect(fetchMock).toHaveBeenCalledWith(
			'https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints:reconcile?pageSize=1000&pageToken=page-token',
			{
				method: 'GET',
				headers: { authorization: 'Bearer ephemeral-access-token' }
			}
		);

		vi.mocked(fetchMock).mockResolvedValueOnce(jsonResponse([]));
		await expect(
			fetchHealthPage({
				accessToken: 'ephemeral-access-token',
				path: '/users/me/dataTypes/steps/dataPoints'
			})
		).rejects.toMatchObject({
			code: 'invalid_response',
			status: 200,
			retryable: false,
			message: 'Google Health request failed'
		});
	});

	it('revokes a refresh token without placing it in a body or returned value', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(revokeGoogleToken('refresh token/with symbols')).resolves.toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			'https://oauth2.googleapis.com/revoke?token=refresh%20token%2Fwith%20symbols',
			{
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' }
			}
		);
	});

	it('redacts remote and network failures while classifying retryability', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse(
					{
						error: 'invalid_grant',
						error_description:
							'authorization-code refresh-token google-client-secret must never escape'
					},
					400
				)
			)
			.mockResolvedValueOnce(jsonResponse({ error: 'rate_limit' }, 429))
			.mockResolvedValueOnce(jsonResponse({ error: 'backend_error' }, 503))
			.mockRejectedValueOnce(
				new Error('socket failed while sending refresh-token and authorization-code')
			);
		vi.stubGlobal('fetch', fetchMock);

		for (const expected of [
			{ code: 'invalid_grant', status: 400, retryable: false },
			{ code: 'rate_limit', status: 429, retryable: true },
			{ code: 'backend_error', status: 503, retryable: true },
			{ code: 'network_error', status: null, retryable: true }
		]) {
			const caught = await exchangeAuthorizationCode({
				code: 'authorization-code',
				clientId: CLIENT_ID,
				clientSecret: CLIENT_SECRET,
				redirectUri: REDIRECT_URI
			}).catch((error: unknown) => error);

			expect(caught).toBeInstanceOf(GoogleHealthError);
			if (!(caught instanceof GoogleHealthError)) throw new Error('Expected GoogleHealthError');
			expect(caught).toMatchObject({
				...expected,
				message: 'Google Health request failed'
			});
			expect(String(caught)).not.toMatch(
				/authorization-code|refresh-token|google-client-secret|error_description/
			);
			expect(Object.keys(caught).sort()).toEqual(['code', 'retryable', 'status']);
		}
	});

	it('rejects success responses that omit required token or identity fields', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({ access_token: 'token', expires_in: 3600, token_type: 'Bearer' })
			)
			.mockResolvedValueOnce(jsonResponse({ healthUserId: '' }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			exchangeAuthorizationCode({
				code: 'authorization-code',
				clientId: CLIENT_ID,
				clientSecret: CLIENT_SECRET,
				redirectUri: REDIRECT_URI
			})
		).rejects.toMatchObject({ code: 'invalid_response', message: 'Google Health request failed' });
		await expect(getHealthIdentity('ephemeral-access-token')).rejects.toMatchObject({
			code: 'invalid_response',
			message: 'Google Health request failed'
		});
	});
});
