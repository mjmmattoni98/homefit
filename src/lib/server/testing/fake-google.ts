import { vi } from 'vitest';

export interface FakePage {
	points: unknown[];
	nextPageToken?: string;
}

export interface DataRequest {
	dataType: string;
	readMode: 'list' | 'reconcile' | 'dailyRollUp';
	pageToken?: string;
	filter?: string;
	body?: unknown;
	authorization?: string;
}

type DataHandler = (request: DataRequest) => FakePage;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const HEALTH_PREFIX = 'https://health.googleapis.com/v4/users/me/';
const KEYSET_URL = 'https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json';

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

/**
 * An in-memory stand-in for Google's OAuth, Health and keyset endpoints, installed as the
 * global `fetch`. Tests describe data per metric and inspect the requests that were made.
 */
export class FakeGoogle {
	healthUserId = 'health-user-1';
	grantedScopes: string[] = [];
	refreshToken = 'refresh-token-1';
	keyset: unknown = null;
	/** Response returned by the token endpoint for refresh grants, when set. */
	refreshFailure: { status: number; error: string } | null = null;
	readonly revokedTokens: string[] = [];
	readonly dataRequests: DataRequest[] = [];
	private handlers = new Map<string, DataHandler>();
	private accessTokens = 0;

	/** Serves the given pages in order, chaining them with page tokens. */
	setPages(dataType: string, pages: unknown[][]): void {
		this.handlers.set(dataType, ({ pageToken }) => {
			const index = pageToken === undefined ? 0 : Number(pageToken.slice(1));
			return {
				points: pages[index] ?? [],
				...(index + 1 < pages.length ? { nextPageToken: `p${index + 1}` } : {})
			};
		});
	}

	setHandler(dataType: string, handler: DataHandler): void {
		this.handlers.set(dataType, handler);
	}

	requestsFor(dataType: string): DataRequest[] {
		return this.dataRequests.filter((request) => request.dataType === dataType);
	}

	install(): void {
		vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) =>
			Promise.resolve(this.handle(String(input instanceof Request ? input.url : input), init))
		);
	}

	private handle(url: string, init: RequestInit = {}): Response {
		if (url === TOKEN_URL) {
			const body = new URLSearchParams(String(init.body));
			this.accessTokens += 1;
			const base = {
				access_token: `access-token-${this.accessTokens}`,
				token_type: 'Bearer',
				expires_in: 3600,
				scope: this.grantedScopes.join(' ')
			};
			if (body.get('grant_type') === 'authorization_code') {
				return json({ ...base, refresh_token: this.refreshToken });
			}
			if (this.refreshFailure !== null) {
				return json({ error: this.refreshFailure.error }, this.refreshFailure.status);
			}
			return json(base);
		}
		if (url.startsWith(REVOKE_URL)) {
			this.revokedTokens.push(new URL(url).searchParams.get('token') ?? '');
			return new Response('', { status: 200 });
		}
		if (url === KEYSET_URL) {
			return this.keyset === null ? new Response('', { status: 503 }) : json(this.keyset);
		}
		if (url === `${HEALTH_PREFIX}identity`) return json({ healthUserId: this.healthUserId });
		const match = /^dataTypes\/([a-z0-9-]+)\/dataPoints(:reconcile|:dailyRollUp)?$/.exec(
			new URL(url).pathname.replace('/v4/users/me/', '')
		);
		if (match !== null) {
			const parsed = new URL(url);
			const readMode =
				match[2] === ':reconcile'
					? 'reconcile'
					: match[2] === ':dailyRollUp'
						? 'dailyRollUp'
						: 'list';
			const body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
			const request: DataRequest = {
				dataType: match[1],
				readMode,
				pageToken:
					readMode === 'dailyRollUp'
						? ((body as { pageToken?: string }).pageToken ?? undefined)
						: (parsed.searchParams.get('pageToken') ?? undefined),
				filter: parsed.searchParams.get('filter') ?? undefined,
				body,
				authorization: new Headers(init.headers).get('authorization') ?? undefined
			};
			this.dataRequests.push(request);
			let page: FakePage;
			try {
				page = this.handlers.get(match[1])?.(request) ?? { points: [] };
			} catch (response) {
				if (response instanceof Response) return response;
				throw response;
			}
			const field = readMode === 'dailyRollUp' ? 'rollupDataPoints' : 'dataPoints';
			return json({
				[field]: page.points,
				...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {})
			});
		}
		return new Response('', { status: 404 });
	}
}
