# Google Health setup

The Google Health integration is optional. When `GOOGLE_HEALTH_CLIENT_ID`, `GOOGLE_HEALTH_CLIENT_SECRET` and `GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY` are empty, HomeFit disables it completely: the import card, the OAuth and webhook endpoints and the background jobs are all turned off. Setting only some of them is treated as a mistake and stops the app from starting.

When enabled, each HomeFit user connects their own Google account and grants read-only access. HomeFit imports the full history in the background, then keeps it current through a daily reconciliation at 03:15 UTC, the **Sync now** button and, if you configure them, Google webhooks. Refresh tokens are encrypted with AES-GCM before they are stored in PostgreSQL.

The Google Health API must be enabled in the same Google Cloud project as the OAuth client.

## 1. Configure HomeFit

Add these values to `.env` (see [`.env.example`](../.env.example)) and restart HomeFit (`docker compose up -d`):

| Variable                                     | Value                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ORIGIN`                                     | Public URL of HomeFit. Google redirects back to it.                                        |
| `GOOGLE_HEALTH_CLIENT_ID`                    | OAuth client ID.                                                                           |
| `GOOGLE_HEALTH_CLIENT_SECRET`                | OAuth client secret.                                                                       |
| `GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY`         | `openssl rand -base64 32` (canonical base64 of exactly 32 bytes).                          |
| `GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION` | `v1` to start with.                                                                        |
| `GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS`          | `{}` to start with. Holds retired keys during a rotation.                                  |
| `GOOGLE_HEALTH_REDIRECT_URI`                 | Optional. Defaults to `${ORIGIN}/api/google-health/oauth/callback`.                        |
| `GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION`        | Optional. Enables webhooks (section 3), e.g. `Bearer ` followed by `openssl rand -hex 32`. |

`GOOGLE_HEALTH_PROJECT_NUMBER` and `GOOGLE_HEALTH_SUBSCRIBER_ID` are only used while creating the webhook subscriber and are not read by the app.

Keep the encryption key safe: without it, stored tokens cannot be decrypted and every user has to reconnect.

## 2. Configure the OAuth client

In Google Cloud Console, open an OAuth client of type **Web application** and add this authorized redirect URI:

```text
${ORIGIN}/api/google-health/oauth/callback
```

It must match `GOOGLE_HEALTH_REDIRECT_URI` (or its default) exactly, including scheme, port and path. Google accepts `http://localhost:<port>` for local development; every other host needs HTTPS.

Configure the OAuth consent screen with the app name, support contact, any privacy-policy details required for your publishing state, and these seven read-only scopes:

```text
https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
https://www.googleapis.com/auth/googlehealth.ecg.readonly
https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
https://www.googleapis.com/auth/googlehealth.irn.readonly
https://www.googleapis.com/auth/googlehealth.location.readonly
https://www.googleapis.com/auth/googlehealth.nutrition.readonly
https://www.googleapis.com/auth/googlehealth.sleep.readonly
```

The location scope is requested for API compatibility; HomeFit does not import or store route or location records.

While the consent screen is in testing, add every person who will connect as a Google test user. An unverified external app is limited to test users, may be subject to Google's 100-user cap, and receives shorter-lived refresh tokens. Complete Google's sensitive and restricted scope verification before opening the integration to arbitrary users. See Google's [OAuth production readiness guide](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance) and the [Google Health API documentation](https://developers.google.com/health-and-fitness/guides/health-api).

## 3. Configure webhooks (optional)

Without webhooks, data still arrives through the daily reconciliation and **Sync now**. Webhooks make updates near real time, but Google can only deliver them to a publicly reachable HTTPS `ORIGIN`.

The webhook endpoint is:

```text
${ORIGIN}/api/google-health/webhook
```

Set `GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION` and restart HomeFit before creating the subscriber, because Google verifies the endpoint while you create it. Then, with a principal that has Google Health API Editor or Admin access, call the subscriber create/update method (or use the API Explorer) with:

- Parent project: `projects/${GOOGLE_HEALTH_PROJECT_NUMBER}` — the numeric project number, not the project ID
- Subscriber ID: `${GOOGLE_HEALTH_SUBSCRIBER_ID}`
- One `AUTOMATIC` subscriber configuration

Substitute the values only in the authenticated request, and never commit the rendered body: it contains the webhook secret.

```json
{
	"endpointUri": "${ORIGIN}/api/google-health/webhook",
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

The other readable data types do not support webhook subscriptions yet; HomeFit imports them initially and refreshes them during reconciliation.

Google checks the endpoint in two steps: the authorized `{"type":"verification"}` request must return HTTP `201`, and an unauthenticated challenge must return `401`. HomeFit rejects unauthorized requests before reading their body. Authenticated notifications are stored and acknowledged with `204`, then a background job verifies Google's signature against its public keyset before any data changes. Deliveries that cannot be verified yet (for example while the keyset is unreachable) are retried with backoff for up to seven days.

## 4. Verify a connection

1. Sign in to HomeFit with an account whose Google identity is a test user of your OAuth app.
2. Open **Import data** and select **Connect Google Health**.
3. Confirm Google requests only the seven read-only scopes above.
4. After the redirect back, the card moves from **Importing** to **Connected**. Progress is counted in metric types because Google does not expose a total record count. You can leave the page; the import continues in the background.
5. Open **Health**. Populated metrics appear in the overview, in their category and under **All metrics**.
6. Select **Sync now** twice and confirm no records are duplicated.
7. Disconnect and confirm imported data is still visible. Reconnect and confirm the import stays idempotent.
8. Test **Delete imported data** with a disposable account only. It requires typing `DELETE GOOGLE DATA` and removes only Google-imported data, never Sleep Cycle or Hevy imports. Deleting a HomeFit account removes everything and revokes the Google grant.

## 5. Operations

- Jobs run on [pg-boss](https://github.com/timgit/pg-boss) in the `pgboss` schema of the same database. A dispatcher runs every minute and resumes any due or interrupted work, so restarts never lose an import.
- Set `BACKGROUND_JOBS=false` on extra web replicas to keep one worker; every instance can still enqueue work.
- Sync history is kept for 30 days (90 days for failures). Webhook bodies are erased once processed, and their digests are kept for eight days to deduplicate retries.
- **Rotating the webhook secret:** update it in Google and in `.env` together; deliveries with a mismatched value receive `401`.
- **Rotating the token encryption key:** choose a new version such as `v2`, move the old version and key into `GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS` (e.g. `{"v1":"<old key>"}`), set the new key and version, and restart. Tokens are re-encrypted with the new key the next time they are used; keep the old key until every connection has synced.
- Disconnecting clears the stored token immediately, even if Google's revocation call fails.
- **Action required** means the user must review access (for example after revoking it in their Google account). **Delayed** imports retry automatically with exponential backoff.
