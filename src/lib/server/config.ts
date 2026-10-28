import { building } from '$app/env';
import {
	GOOGLE_HEALTH_CLIENT_ID,
	GOOGLE_HEALTH_CLIENT_SECRET,
	GOOGLE_HEALTH_REDIRECT_URI,
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY,
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION,
	GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS,
	GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION,
	ORIGIN
} from '$app/env/private';
import { loadGoogleHealthConfig } from './google-health/config';

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
