import { defineApp } from 'convex/server';
import { v } from 'convex/values';

const app = defineApp({
	env: {
		GOOGLE_HEALTH_CLIENT_ID: v.string(),
		GOOGLE_HEALTH_CLIENT_SECRET: v.string(),
		GOOGLE_HEALTH_REDIRECT_URI: v.string(),
		HOMEFIT_APP_URL: v.string(),
		GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY: v.string(),
		GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION: v.string(),
		GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS: v.optional(v.string()),
		GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION: v.string()
	}
});

export default app;
