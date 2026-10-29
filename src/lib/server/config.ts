import { building } from '$app/env';
import {
	GOOGLE_HEALTH_CLIENT_ID,
	GOOGLE_HEALTH_CLIENT_SECRET,
	GOOGLE_HEALTH_REDIRECT_URI,
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY,
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION,
	GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS,
	GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION,
	HOMEFIT_INSTANCE,
	ORIGIN,
	POSTGRES_DB
} from '$app/env/private';
import { assertInstanceBoundary } from './instance';
import { loadGoogleHealthConfig } from './google-health/config';

if (!building && process.env.VITEST === undefined) {
	assertInstanceBoundary({
		instance: HOMEFIT_INSTANCE,
		database: POSTGRES_DB,
		googleHealthClientId: GOOGLE_HEALTH_CLIENT_ID,
		googleHealthClientSecret: GOOGLE_HEALTH_CLIENT_SECRET,
		googleHealthEncryptionKey: GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY
	});
}

/** Google Health settings, or `null` when the optional integration is not configured. */
export const googleHealthConfig =
	building || process.env.VITEST !== undefined
		? null
		: loadGoogleHealthConfig({
				ORIGIN,
				GOOGLE_HEALTH_CLIENT_ID,
				GOOGLE_HEALTH_CLIENT_SECRET,
				GOOGLE_HEALTH_REDIRECT_URI,
				GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY,
				GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION,
				GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS,
				GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION
			});
