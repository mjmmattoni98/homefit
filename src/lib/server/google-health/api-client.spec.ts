import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	GoogleHealthError,
	buildAuthorizationUrl,
	exchangeAuthorizationCode,
	fetchGoogleHealthDataPage,
	fetchHealthPage,
	getHealthIdentity,
	refreshAccessToken,
	revokeGoogleToken
} from './api-client';
import { GOOGLE_HEALTH_READ_SCOPES } from './registry';

const CLIENT_ID = 'google-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'google-client-secret';
const REDIRECT_URI = 'https://homefit.example/api/google-health/oauth/callback';

afterEach(() => {
	vi.useRealTimers();
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
	it('uses the current list, reconcile, and daily-rollup page contracts', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ dataPoints: [{ id: 1 }], nextPageToken: 'next' }))
			.mockResolvedValueOnce(jsonResponse({ dataPoints: [{ id: 2 }] }))
			.mockResolvedValueOnce(jsonResponse({ rollupDataPoints: [{ id: 3 }] }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			fetchGoogleHealthDataPage({
				accessToken: 'access-token',
				dataType: 'heart-rate',
				readMode: 'reconcile',
				pageSize: 1000,
				pageToken: 'current',
				filter: {
					axis: 'physical',
					field: 'heart_rate.sample_time.physical_time',
					comparison: 'closedOpen',
					start: '2026-08-14T10:00:00Z',
					end: '2026-08-14T11:00:00Z'
				}
			})
		).resolves.toEqual({ points: [{ id: 1 }], nextPageToken: 'next' });
		await expect(
			fetchGoogleHealthDataPage({
				accessToken: 'access-token',
				dataType: 'food',
				readMode: 'list',
				pageSize: 1000
			})
		).resolves.toEqual({ points: [{ id: 2 }] });
		await expect(
			fetchGoogleHealthDataPage({
				accessToken: 'access-token',
				dataType: 'total-calories',
				readMode: 'dailyRollUp',
				pageSize: 1000,
				pageToken: 'rollup-current',
				range: { start: '2000-01-01', end: '2000-01-15' }
			})
		).resolves.toEqual({ points: [{ id: 3 }] });

		const reconcileUrl = new URL(String(fetchMock.mock.calls[0][0]));
		expect(reconcileUrl.pathname).toBe('/v4/users/me/dataTypes/heart-rate/dataPoints:reconcile');
		expect(Object.fromEntries(reconcileUrl.searchParams)).toEqual({
			pageSize: '1000',
			pageToken: 'current',
			filter:
				'heart_rate.sample_time.physical_time >= "2026-08-14T10:00:00Z" AND heart_rate.sample_time.physical_time < "2026-08-14T11:00:00Z"'
		});
		expect(new URL(String(fetchMock.mock.calls[1][0])).pathname).toBe(
			'/v4/users/me/dataTypes/food/dataPoints'
		);
		expect(new URL(String(fetchMock.mock.calls[2][0])).pathname).toBe(
			'/v4/users/me/dataTypes/total-calories/dataPoints:dailyRollUp'
		);
		expect(fetchMock.mock.calls[2][1]).toMatchObject({
			method: 'POST',
			body: JSON.stringify({
				range: {
					start: { date: { year: 2000, month: 1, day: 1 } },
					end: { date: { year: 2000, month: 1, day: 15 } }
				},
				windowSizeDays: 1,
				pageSize: 1000,
				pageToken: 'rollup-current'
			})
		});
	});

	it('keeps page tokens separate from filter syntax and rejects injected time literals', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ dataPoints: [] }));
		vi.stubGlobal('fetch', fetchMock);
		const pageToken = 'opaque&filter=steps.count>0';

		await fetchGoogleHealthDataPage({
			accessToken: 'access-token',
			dataType: 'steps',
			readMode: 'reconcile',
			pageSize: 1000,
			pageToken,
			filter: {
				axis: 'physical',
				field: 'steps.interval.start_time',
				comparison: 'closedOpen',
				start: '2026-08-14T10:00:00Z',
				end: '2026-08-14T11:00:00Z'
			}
		});
		const url = new URL(String(fetchMock.mock.calls[0][0]));
		expect(url.searchParams.get('pageToken')).toBe(pageToken);
		expect(url.searchParams.getAll('filter')).toEqual([
			'steps.interval.start_time >= "2026-08-14T10:00:00Z" AND steps.interval.start_time < "2026-08-14T11:00:00Z"'
		]);

		await expect(
			fetchGoogleHealthDataPage({
				accessToken: 'access-token',
				dataType: 'steps',
				readMode: 'reconcile',
				pageSize: 1000,
				filter: {
					axis: 'physical',
					field: 'steps.interval.start_time',
					comparison: 'closedOpen',
					start: '2026-08-14T10:00:00Z" OR true',
					end: '2026-08-14T11:00:00Z'
				}
			})
		).rejects.toMatchObject({ code: 'invalid_request', message: 'Google Health request failed' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('emits ECG as a registry-owned one-sided physical lower bound and rejects field injection', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ dataPoints: [] }));
		vi.stubGlobal('fetch', fetchMock);
		await fetchGoogleHealthDataPage({
			accessToken: 'access-token',
			dataType: 'electrocardiogram',
			readMode: 'list',
			pageSize: 25,
			filter: {
				axis: 'physical',
				field: 'electrocardiogram.interval.start_time',
				comparison: 'lowerBoundOnly',
				start: '2026-08-14T10:00:00Z'
			}
		});
		expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('filter')).toBe(
			'electrocardiogram.interval.start_time >= "2026-08-14T10:00:00Z"'
		);
		await expect(
			fetchGoogleHealthDataPage({
				accessToken: 'access-token',
				dataType: 'electrocardiogram',
				readMode: 'list',
				pageSize: 25,
				filter: {
					axis: 'physical',
					field: 'electrocardiogram.interval.start_time OR true',
					comparison: 'lowerBoundOnly',
					start: '2026-08-14T10:00:00Z'
				}
			})
		).rejects.toMatchObject({ code: 'invalid_request' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('accepts plain-HTTP redirects only for loopback development hosts', () => {
		const state = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
		for (const redirectUri of [
			'http://localhost:5173/api/google-health/oauth/callback',
			'http://127.0.0.1:3000/api/google-health/oauth/callback'
		]) {
			expect(
				new URL(
					buildAuthorizationUrl({ clientId: CLIENT_ID, redirectUri, state })
				).searchParams.get('redirect_uri')
			).toBe(redirectUri);
		}
		expect(() =>
			buildAuthorizationUrl({
				clientId: CLIENT_ID,
				redirectUri: 'http://homefit.example/api/google-health/oauth/callback',
				state
			})
		).toThrow(expect.objectContaining({ code: 'invalid_request' }));
	});

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
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
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

	it('refreshes with stored scope fallback and preserves a rotated refresh-token contract', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			jsonResponse({
				access_token: 'new-access-token',
				expires_in: 3600,
				refresh_token: 'rotated-refresh-token',
				refresh_token_expires_in: 15_552_000,
				token_type: 'Bearer'
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			refreshAccessToken({
				refreshToken: 'stored-refresh-token',
				clientId: CLIENT_ID,
				clientSecret: CLIENT_SECRET,
				grantedScopes: [GOOGLE_HEALTH_READ_SCOPES[0], GOOGLE_HEALTH_READ_SCOPES[6]]
			})
		).resolves.toEqual({
			accessToken: 'new-access-token',
			expiresIn: 3600,
			grantedScopes: [GOOGLE_HEALTH_READ_SCOPES[0], GOOGLE_HEALTH_READ_SCOPES[6]],
			refreshToken: 'rotated-refresh-token',
			refreshTokenExpiresIn: 15_552_000,
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

	it('uses a returned refresh scope instead of the validated stored fallback', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({
					access_token: 'new-access-token',
					expires_in: 3600,
					scope: GOOGLE_HEALTH_READ_SCOPES[6],
					token_type: 'Bearer'
				})
			)
		);

		await expect(
			refreshAccessToken({
				refreshToken: 'stored-refresh-token',
				clientId: CLIENT_ID,
				clientSecret: CLIENT_SECRET,
				grantedScopes: [GOOGLE_HEALTH_READ_SCOPES[0]]
			})
		).resolves.toMatchObject({ grantedScopes: [GOOGLE_HEALTH_READ_SCOPES[6]] });
	});

	it('gets the stable Health identity through the bearer-authenticated v4 endpoint', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ healthUserId: 'health-user-123' }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(getHealthIdentity('ephemeral-access-token')).resolves.toEqual({
			healthUserId: 'health-user-123'
		});
		expect(fetchMock).toHaveBeenCalledWith('https://health.googleapis.com/v4/users/me/identity', {
			method: 'GET',
			headers: { authorization: 'Bearer ephemeral-access-token' },
			signal: expect.any(AbortSignal)
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
				headers: { authorization: 'Bearer ephemeral-access-token' },
				signal: expect.any(AbortSignal)
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

	it('enforces bounded Health URLs, query values, and request bodies before fetch', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			fetchHealthPage({
				accessToken: 'ephemeral-access-token',
				path: '/users/me/dataTypes/steps/dataPoints',
				query: { pageToken: 'x'.repeat(9000) }
			})
		).rejects.toMatchObject({ code: 'invalid_request', message: 'Google Health request failed' });
		await expect(
			fetchHealthPage({
				accessToken: 'ephemeral-access-token',
				path: '/users/me/dataTypes/steps/dataPoints:dailyRollUp',
				method: 'POST',
				body: { payload: 'x'.repeat(70 * 1024) }
			})
		).rejects.toMatchObject({ code: 'invalid_request', message: 'Google Health request failed' });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('revokes a refresh token without placing it in a body or returned value', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(revokeGoogleToken('refresh token/with symbols')).resolves.toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			'https://oauth2.googleapis.com/revoke?token=refresh%20token%2Fwith%20symbols',
			{
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				signal: expect.any(AbortSignal)
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

	it('applies one abort deadline to stalled fetches and stalled success or error bodies', async () => {
		vi.useFakeTimers();
		const never = new ReadableStream<Uint8Array>({ start() {} });
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockImplementationOnce(async (_input, init) => {
				return await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(new Error('secret abort cause')));
				});
			})
			.mockResolvedValueOnce(
				new Response(never, { status: 200, headers: { 'content-type': 'application/json' } })
			)
			.mockResolvedValueOnce(
				new Response(new ReadableStream<Uint8Array>({ start() {} }), {
					status: 503,
					headers: { 'content-type': 'application/json' }
				})
			);
		vi.stubGlobal('fetch', fetchMock);

		for (let index = 0; index < 3; index += 1) {
			const pending = exchangeAuthorizationCode({
				code: 'authorization-code',
				clientId: CLIENT_ID,
				clientSecret: CLIENT_SECRET,
				redirectUri: REDIRECT_URI
			});
			const assertion = expect(pending).rejects.toMatchObject({
				code: 'request_timeout',
				status: null,
				retryable: true,
				message: 'Google Health request failed'
			});
			await vi.advanceTimersByTimeAsync(60_000);
			await assertion;
		}
		expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
	});

	it('classifies an interrupted success body as a redacted retryable network failure', async () => {
		let reads = 0;
		const interruptedBody = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (reads === 0) {
					reads += 1;
					controller.enqueue(new TextEncoder().encode('{"access_token":"sensitive'));
					return;
				}
				controller.error(new Error('stream exposed a refresh-token secret'));
			}
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(interruptedBody, {
						status: 200,
						headers: { 'content-type': 'application/json' }
					})
			)
		);

		const caught = await exchangeAuthorizationCode({
			code: 'authorization-code',
			clientId: CLIENT_ID,
			clientSecret: CLIENT_SECRET,
			redirectUri: REDIRECT_URI
		}).catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(GoogleHealthError);
		expect(caught).toMatchObject({
			code: 'network_error',
			status: null,
			retryable: true,
			message: 'Google Health request failed'
		});
		expect(String(caught)).not.toMatch(/sensitive|refresh-token|stream exposed/);
	});

	it('rejects oversized success and error bodies without reading or exposing them', async () => {
		const oversizedErrorStream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(17 * 1024));
				controller.close();
			}
		});
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response('{}', {
					status: 200,
					headers: { 'content-length': String(65 * 1024), 'content-type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(oversizedErrorStream, {
					status: 400,
					headers: { 'content-type': 'application/json' }
				})
			);
		vi.stubGlobal('fetch', fetchMock);

		for (const operation of [
			() => getHealthIdentity('ephemeral-access-token'),
			() =>
				exchangeAuthorizationCode({
					code: 'authorization-code',
					clientId: CLIENT_ID,
					clientSecret: CLIENT_SECRET,
					redirectUri: REDIRECT_URI
				})
		]) {
			await expect(operation()).rejects.toMatchObject({
				code: 'response_too_large',
				retryable: false,
				message: 'Google Health request failed'
			});
		}
	});

	it('preserves retryability when a 429 or 5xx error body exceeds the redacted cap', async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response('{}', {
					status: 429,
					headers: { 'content-length': String(17 * 1024) }
				})
			)
			.mockResolvedValueOnce(
				new Response('{}', {
					status: 503,
					headers: { 'content-length': String(17 * 1024) }
				})
			);
		vi.stubGlobal('fetch', fetchMock);

		for (const status of [429, 503]) {
			await expect(
				exchangeAuthorizationCode({
					code: 'authorization-code',
					clientId: CLIENT_ID,
					clientSecret: CLIENT_SECRET,
					redirectUri: REDIRECT_URI
				})
			).rejects.toMatchObject({
				code: 'response_too_large',
				status,
				retryable: true,
				message: 'Google Health request failed'
			});
		}
	});

	it('rejects success responses with missing token fields, invalid rotation bounds, or invalid identity', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({ access_token: 'token', expires_in: 3600, token_type: 'Bearer' })
			)
			.mockResolvedValueOnce(
				jsonResponse({
					access_token: 'token',
					expires_in: 3600,
					scope: GOOGLE_HEALTH_READ_SCOPES[0],
					token_type: 'Bearer',
					refresh_token: 'rotated-refresh-token',
					refresh_token_expires_in: 0
				})
			)
			.mockResolvedValueOnce(jsonResponse({ healthUserId: 'invalid_identity' }))
			.mockResolvedValueOnce(jsonResponse({ healthUserId: 'a'.repeat(64) }));
		vi.stubGlobal('fetch', fetchMock);

		await expect(
			exchangeAuthorizationCode({
				code: 'authorization-code',
				clientId: CLIENT_ID,
				clientSecret: CLIENT_SECRET,
				redirectUri: REDIRECT_URI
			})
		).rejects.toMatchObject({ code: 'invalid_response', message: 'Google Health request failed' });
		await expect(
			refreshAccessToken({
				refreshToken: 'stored-refresh-token',
				clientId: CLIENT_ID,
				clientSecret: CLIENT_SECRET,
				grantedScopes: [GOOGLE_HEALTH_READ_SCOPES[0]]
			})
		).rejects.toMatchObject({ code: 'invalid_response', message: 'Google Health request failed' });
		await expect(getHealthIdentity('ephemeral-access-token')).rejects.toMatchObject({
			code: 'invalid_response',
			message: 'Google Health request failed'
		});
		await expect(getHealthIdentity('ephemeral-access-token')).rejects.toMatchObject({
			code: 'invalid_response',
			message: 'Google Health request failed'
		});
	});
});
