import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadGoogleHealthConfig, type GoogleHealthEnv } from './config';

const unset: GoogleHealthEnv = {
	ORIGIN: 'https://homefit.example',
	GOOGLE_HEALTH_CLIENT_ID: '',
	GOOGLE_HEALTH_CLIENT_SECRET: '',
	GOOGLE_HEALTH_REDIRECT_URI: '',
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY: '',
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION: 'v1',
	GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS: '{}',
	GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION: ''
};

const configured: GoogleHealthEnv = {
	...unset,
	GOOGLE_HEALTH_CLIENT_ID: 'client-id',
	GOOGLE_HEALTH_CLIENT_SECRET: 'client-secret',
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64')
};

describe('Google Health configuration', () => {
	it('disables the integration when nothing is configured', () => {
		expect(loadGoogleHealthConfig(unset)).toBeNull();
	});

	it('fails loudly on a partial configuration', () => {
		expect(() =>
			loadGoogleHealthConfig({ ...unset, GOOGLE_HEALTH_CLIENT_ID: 'client-id' })
		).toThrow(/GOOGLE_HEALTH_CLIENT_SECRET, GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY/);
		expect(() =>
			loadGoogleHealthConfig({ ...configured, GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY: 'too-short' })
		).toThrow();
	});

	it('derives the callback from the app origin and treats the webhook as optional', () => {
		expect(loadGoogleHealthConfig(configured)).toMatchObject({
			redirectUri: 'https://homefit.example/api/google-health/oauth/callback',
			appOrigin: 'https://homefit.example',
			webhookAuthorization: null
		});
		expect(
			loadGoogleHealthConfig({
				...configured,
				GOOGLE_HEALTH_REDIRECT_URI: 'https://auth.homefit.example/callback',
				GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION: 'Bearer secret'
			})
		).toMatchObject({
			redirectUri: 'https://auth.homefit.example/callback',
			webhookAuthorization: 'Bearer secret'
		});
	});
});
