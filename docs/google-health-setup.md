# Google Health setup

HomeFit uses one Google Cloud project-level subscriber and a separate OAuth connection for each signed-in user. Users grant read-only access. HomeFit performs the historical import in the background, then stays current through Google webhooks and daily reconciliation.

The Google Health API must already be enabled in the same project as the OAuth client.

## 1. Prepare the environment values

Copy `.env.example` into your preferred local or deployment secret store. Keep real values out of source control.

Frontend and deployment URLs:

- `PUBLIC_CONVEX_URL`: the Convex client URL used by the web app.
- `PUBLIC_CONVEX_SITE_URL`: the public Convex HTTP Actions origin, without a trailing slash.
- `HOMEFIT_APP_URL`: the public HomeFit web origin, without a path or trailing slash. `http://localhost:<port>` is accepted only for local development.

Google OAuth values:

- `GOOGLE_HEALTH_CLIENT_ID`
- `GOOGLE_HEALTH_CLIENT_SECRET`
- `GOOGLE_HEALTH_REDIRECT_URI`

Runtime security values:

- `GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY`: canonical base64 for exactly 32 random bytes. Generate it with `openssl rand -base64 32`.
- `GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION`: start with `v1`.
- `GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS`: start with `{}`. During a later key rotation, retain old version-to-key mappings until all stored tokens have been re-encrypted.
- `GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION`: an independent high-entropy value sent as the complete `Authorization` header. A suitable value is `Bearer ` followed by at least 32 random bytes encoded as hex or base64.

Subscriber setup values, which are not required by the running application:

- `GOOGLE_HEALTH_PROJECT_NUMBER`: the numeric Google Cloud project number, not the project ID.
- `GOOGLE_HEALTH_SUBSCRIBER_ID`: use `homefit-health`.

Set these eight values in the target Convex deployment through the Convex dashboard's Environment Variables page:

1. `GOOGLE_HEALTH_CLIENT_ID`
2. `GOOGLE_HEALTH_CLIENT_SECRET`
3. `GOOGLE_HEALTH_REDIRECT_URI`
4. `HOMEFIT_APP_URL`
5. `GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY`
6. `GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION`
7. `GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS`
8. `GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION`

Classify the Convex deployment as development or production before changing its environment. Never paste secret values into committed scripts or captured command output.

## 2. Configure the OAuth client

In Google Cloud Console, open the OAuth client of type **Web application** and add this exact authorized redirect URI:

```text
${PUBLIC_CONVEX_SITE_URL}/google-health/oauth/callback
```

Set `GOOGLE_HEALTH_REDIRECT_URI` to that exact same value. Scheme, host, path, and trailing slash must match exactly.

Configure the OAuth consent screen with the app name, support contact, privacy-policy details required for your publishing state, and these seven read-only scopes:

```text
https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
https://www.googleapis.com/auth/googlehealth.ecg.readonly
https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
https://www.googleapis.com/auth/googlehealth.irn.readonly
https://www.googleapis.com/auth/googlehealth.location.readonly
https://www.googleapis.com/auth/googlehealth.nutrition.readonly
https://www.googleapis.com/auth/googlehealth.sleep.readonly
```

The location scope is requested for API compatibility, but HomeFit does not import or store route/location records.

While the consent screen is in testing, add every person who will connect as a Google test user. An unverified external app is limited to test users and may be subject to Google's 100-user cap and shorter-lived testing refresh tokens. Complete Google's sensitive/restricted-scope verification and production security review before opening the integration to arbitrary users. See Google's [OAuth production readiness guide](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance) and the [Google Health API documentation](https://developers.google.com/health-and-fitness/guides/health-api).

## 3. Configure the project subscriber

The webhook endpoint is:

```text
${PUBLIC_CONVEX_SITE_URL}/google-health/webhook
```

Use a principal with Google Health API Editor/Admin access. In the Google Health API subscriber create/update method or API Explorer, use:

- Parent project: `projects/${GOOGLE_HEALTH_PROJECT_NUMBER}`
- Subscriber ID: `${GOOGLE_HEALTH_SUBSCRIBER_ID}`
- One `AUTOMATIC` subscriber configuration
- The numeric project number, never the human-readable project ID

Submit this body after substituting values only in the authenticated request. Do not save the rendered body in the repository because it contains the webhook authorization secret.

```json
{
	"endpointUri": "${PUBLIC_CONVEX_SITE_URL}/google-health/webhook",
	"subscriberConfigs": [
		{
			"dataTypes": [
				"active-zone-minutes",
				"activity-level",
				"altitude",
				"blood-glucose",
				"body-fat",
				"calories-in-heart-rate-zone",
				"daily-heart-rate-variability",
				"daily-heart-rate-zones",
				"daily-oxygen-saturation",
				"daily-respiratory-rate",
				"daily-resting-heart-rate",
				"daily-sleep-temperature-derivations",
				"distance",
				"exercise",
				"floors",
				"heart-rate",
				"heart-rate-variability",
				"height",
				"hydration-log",
				"nutrition-log",
				"respiratory-rate-sleep-summary",
				"run-vo2-max",
				"sedentary-period",
				"sleep",
				"steps",
				"time-in-heart-rate-zone",
				"weight"
			],
			"subscriptionCreatePolicy": "AUTOMATIC"
		}
	],
	"endpointAuthorization": {
		"secret": "${GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION}"
	}
}
```

The other readable registry types do not currently support Google webhook subscriptions. HomeFit still imports them initially and refreshes them during scheduled reconciliation.

Google performs a two-step endpoint check when the subscriber is created or updated:

1. The authorized `{"type":"verification"}` request must return HTTP `201`.
2. Google's unauthenticated challenge must return HTTP `401`.

HomeFit rejects unauthorized requests before reading their body. Authenticated notifications receive HTTP `204` after durable acceptance, then their Google signature is verified asynchronously before any user data is changed.

## 4. Verify a test-user connection

1. Sign in to HomeFit with a Clerk user whose email is also a Google OAuth test user.
2. Open `/dashboard/import` and select **Connect Google Health**.
3. Confirm the Google screen requests only the seven read-only scopes listed above.
4. After the callback, confirm the card moves from **Importing** to **Connected**. Progress is measured by completed metric types because Google does not expose a reliable total-record count.
5. Open `/dashboard/health`. Confirm populated metrics appear in the overview, their category, and **All metrics**.
6. Select **Sync now** twice and confirm no duplicate records appear.
7. Disconnect and confirm the imported data remains visible. Reconnect and confirm the import remains idempotent.
8. Test permanent deletion only with a disposable user. It requires the exact phrase `DELETE GOOGLE DATA` and removes only Google-imported data, not Sleep Cycle or Hevy CSV imports.

Automatic updates require a publicly reachable HTTPS Convex site URL and the successfully verified subscriber. Localhost can receive the OAuth return through the deployed Convex callback, but Google cannot deliver webhooks directly to a localhost endpoint.

## 5. Rotation and incident notes

- Rotate the webhook authorization value in Google and Convex as one coordinated change. Deliveries using mismatched values will receive `401`.
- To rotate the token encryption key, create a new version such as `v2`, move the old version and key into `GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS`, then set the new active key and version. Successful reads transparently re-encrypt old token envelopes.
- Disconnect immediately clears the locally usable token even if Google's external revocation call fails.
- If a connection shows **Action required**, the user must review access. **Delayed** imports retry automatically.
