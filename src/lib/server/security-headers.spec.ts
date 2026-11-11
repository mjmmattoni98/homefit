import { expect, it } from 'vitest';
import { secureResponse } from './security-headers';

it('adds HSTS only for an HTTPS origin and also secures immutable redirects', () => {
	const http = secureResponse(new Response('ok'), 'http://localhost:3000');
	expect(http.headers.get('strict-transport-security')).toBeNull();
	expect(
		secureResponse(new Response('ok'), undefined).headers.get('strict-transport-security')
	).toBeNull();
	const https = secureResponse(
		Response.redirect('https://example.com/dashboard'),
		'https://example.com'
	);
	expect(https.status).toBe(302);
	expect(https.headers.get('location')).toBe('https://example.com/dashboard');
	expect(https.headers.get('strict-transport-security')).toBe('max-age=31536000');
	expect(https.headers.get('x-frame-options')).toBe('DENY');
	expect(https.headers.get('x-content-type-options')).toBe('nosniff');
});

it('keeps a stricter referrer policy chosen by the route', () => {
	const defaulted = secureResponse(new Response('ok'), 'http://localhost:3000');
	expect(defaulted.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
	const strict = secureResponse(
		new Response(null, { status: 302, headers: { 'referrer-policy': 'no-referrer' } }),
		'http://localhost:3000'
	);
	expect(strict.headers.get('referrer-policy')).toBe('no-referrer');
});
