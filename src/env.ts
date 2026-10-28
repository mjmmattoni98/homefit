import { defineEnvVars } from '@sveltejs/kit/env';
import { building } from '$app/env';
import * as v from 'valibot';

const optionalString = v.optional(v.pipe(v.string(), v.trim()), '');
const booleanFlag = (fallback: boolean) =>
	v.pipe(
		v.optional(v.string(), fallback ? 'true' : 'false'),
		v.transform((value) => ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()))
	);
const withDefault = (fallback: string) =>
	v.pipe(
		v.optional(v.string(), ''),
		v.transform((value) => {
			const trimmed = value.trim();
			return trimmed === '' ? fallback : trimmed;
		})
	);
// Required at runtime, but not while `vite build` analyses the app or Vitest runs unit tests.
const lenient = building || process.env.VITEST !== undefined;

export const variables = defineEnvVars({
	POSTGRES_USER: {
		description:
			'PostgreSQL role. Defaults to `homefit`. The app builds its connection string from this, `POSTGRES_PASSWORD`, and `POSTGRES_DB`.',
		schema: withDefault('homefit')
	},
	POSTGRES_PASSWORD: {
		description:
			'PostgreSQL password. Use letters and digits only, e.g. `openssl rand -hex 24`, so Docker Compose can pass it through.',
		schema: lenient ? optionalString : v.pipe(v.string(), v.trim(), v.nonEmpty())
	},
	POSTGRES_DB: {
		description: 'PostgreSQL database name. Defaults to `homefit`.',
		schema: withDefault('homefit')
	},
	POSTGRES_HOST: {
		description:
			'PostgreSQL hostname. Defaults to `localhost`. Docker Compose sets this to `db` for the app container.',
		schema: v.pipe(
			withDefault('localhost'),
			v.check((value) => /^[A-Za-z0-9._-]+$/.test(value), 'POSTGRES_HOST must be a hostname')
		)
	},
	POSTGRES_PORT: {
		description:
			'PostgreSQL port. Defaults to `5432`. Docker Compose publishes the database on this port and connects the app container to port 5432.',
		schema: v.pipe(
			withDefault('5432'),
			v.check((value) => {
				const port = Number(value);
				return /^\d+$/.test(value) && Number.isInteger(port) && port >= 1 && port <= 65535;
			}, 'POSTGRES_PORT must be an integer from 1 to 65535')
		)
	},
	ORIGIN: {
		description:
			'Public origin of the app without a trailing slash, e.g. `https://homefit.example.com` or `http://localhost:3000`.',
		schema: lenient
			? optionalString
			: v.pipe(
					v.string(),
					v.trim(),
					v.url(),
					v.transform((value) => new URL(value).origin)
				)
	},
	BETTER_AUTH_SECRET: {
		description:
			'Secret used to sign sessions. Use at least 32 random characters, e.g. `openssl rand -base64 32`.',
		schema: lenient ? optionalString : v.pipe(v.string(), v.minLength(32))
	},
	DISABLE_SIGNUP: {
		description:
			'Set to `true` to stop new accounts from being created (existing users can still sign in).',
		schema: booleanFlag(false)
	},
	RUN_MIGRATIONS: {
		description: 'Apply pending database migrations when the server starts. Defaults to `true`.',
		schema: booleanFlag(true)
	},
	BACKGROUND_JOBS: {
		description:
			'Run the background job worker (Google Health sync and maintenance) in this process. Defaults to `true`.',
		schema: booleanFlag(true)
	},
	GOOGLE_HEALTH_CLIENT_ID: {
		description:
			'Google OAuth client ID. Leave empty to disable the optional Google Health integration.',
		schema: optionalString
	},
	GOOGLE_HEALTH_CLIENT_SECRET: {
		description: 'Google OAuth client secret.',
		schema: optionalString
	},
	GOOGLE_HEALTH_REDIRECT_URI: {
		description: 'OAuth redirect URI. Defaults to `${ORIGIN}/api/google-health/oauth/callback`.',
		schema: optionalString
	},
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY: {
		description:
			'Base64 encoding of 32 random bytes used to encrypt refresh tokens (`openssl rand -base64 32`).',
		schema: optionalString
	},
	GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION: {
		description: 'Version label of the active token encryption key.',
		schema: v.optional(v.pipe(v.string(), v.trim()), 'v1')
	},
	GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS: {
		description: 'JSON object mapping retired key versions to keys, used during key rotation.',
		schema: v.optional(v.pipe(v.string(), v.trim()), '{}')
	},
	GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION: {
		description:
			'Exact `Authorization` header Google sends to the webhook. Leave empty to rely on scheduled sync only.',
		schema: optionalString
	}
});
