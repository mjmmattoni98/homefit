/** Clone headers because redirects and some upstream responses have immutable headers. */
export function secureResponse(response: Response, origin: string | undefined): Response {
	const headers = new Headers(response.headers);
	headers.set('x-content-type-options', 'nosniff');
	// A route may ask for something stricter, as the OAuth callback does.
	if (!headers.has('referrer-policy')) {
		headers.set('referrer-policy', 'strict-origin-when-cross-origin');
	}
	headers.set('x-frame-options', 'DENY');
	// Browsers ignore HSTS over plain HTTP, and ORIGIN is unset while building.
	if (origin?.startsWith('https://')) headers.set('strict-transport-security', 'max-age=31536000');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
