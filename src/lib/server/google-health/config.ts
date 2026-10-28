import { createTokenKeyring, type TokenKeyring } from './crypto';

export const OAUTH_CALLBACK_PATH = '/api/google-health/oauth/callback';
export const WEBHOOK_PATH = '/api/google-health/webhook';

export interface GoogleHealthConfig {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly redirectUri: string;
	/** Public origin of the app, used to build post-OAuth redirects. */
	readonly appOrigin: string;
	readonly keyring: TokenKeyring;
	/** Exact `Authorization` header expected on webhook deliveries; `null` disables the webhook. */
	readonly webhookAuthorization: string | null;
}

export interface GoogleHealthEnv {
	ORIGIN: string;
	GOOGLE_HEALTH_CLIENT_ID: string;
	GOOGLE_HEALTH_CLIENT_SECRET: string;
	GOOGLE_HEALTH_REDIRECT_URI: string;
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY: string;
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION: string;
	GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS: string;
	GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION: string;
}

const REQUIRED = [
	'GOOGLE_HEALTH_CLIENT_ID',
	'GOOGLE_HEALTH_CLIENT_SECRET',
	'GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY'
] as const satisfies readonly (keyof GoogleHealthEnv)[];

/**
 * Builds the Google Health configuration. Returns `null` when the integration is not
 * configured, which disables every Google Health route, job and UI entry point. A partially
 * filled configuration or an invalid key is a deployment mistake and fails loudly.
 */
export function loadGoogleHealthConfig(env: GoogleHealthEnv): GoogleHealthConfig | null {
	const missing = REQUIRED.filter((name) => env[name] === '');
	if (missing.length === REQUIRED.length) return null;
	if (missing.length > 0) {
		throw new Error(
			`Google Health is partially configured. Set ${missing.join(', ')} or clear every GOOGLE_HEALTH_* variable.`
		);
	}
	if (!URL.canParse(env.ORIGIN))
		throw new Error('Google Health requires ORIGIN to be set to the public app URL.');
	const appOrigin = new URL(env.ORIGIN).origin;
	return Object.freeze({
		clientId: env.GOOGLE_HEALTH_CLIENT_ID,
		clientSecret: env.GOOGLE_HEALTH_CLIENT_SECRET,
		redirectUri: env.GOOGLE_HEALTH_REDIRECT_URI || `${appOrigin}${OAUTH_CALLBACK_PATH}`,
		appOrigin,
		keyring: createTokenKeyring(
			env.GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY,
			env.GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION,
			env.GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS
		),
		webhookAuthorization: env.GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION || null
	});
}
