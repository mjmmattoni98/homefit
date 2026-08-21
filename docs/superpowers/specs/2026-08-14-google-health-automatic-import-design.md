# Google Health Automatic Import Design

**Date:** 2026-08-14

**Status:** Approved for implementation planning

## Summary

HomeFit will let every Clerk-authenticated user connect their own Google account and grant read-only Google Health access. The app will import all history that the Google Health API makes available across every supported and granted metric, then keep the data current through Google subscriptions/webhooks plus daily reconciliation.

Convex remains the sole backend. It owns OAuth state, encrypted refresh tokens, synchronization, webhook handling, scheduled recovery, health records, and chart summaries. The browser receives neither the Google client secret nor Google refresh tokens.

The user interface follows the approved category-dashboard concept: a concise health overview, category pages, an all-metrics catalog, and a detail page for every imported metric.

## Goals

- Provide a per-user “Connect Google Health” OAuth flow.
- Request all Google Health read-only scopes supported by HomeFit.
- Import all history Google makes available for every supported and granted data type.
- Display every imported metric immediately.
- Keep records current automatically with near-real-time notifications and daily reconciliation.
- Preserve Google-specific fields without requiring one database table per metric.
- Handle updates, provider deletions, duplicate notifications, partial consent, and interrupted backfills safely.
- Keep health records and credentials isolated by the authenticated Clerk identity.
- Retain imported records when a user disconnects Google Health.
- Provide a separate, explicit action for deleting all Google-imported data.

## Non-goals

- Writing, correcting, or deleting health data in Google Health.
- Replacing Clerk authentication or adding another application backend.
- Merging exercise sessions from Google Health into Hevy’s set-level strength-training model.
- Giving medical advice or interpreting health measurements clinically.
- Building user-configurable dashboard layouts in the first release.

## Existing Application Context

HomeFit is a Svelte 5/SvelteKit application using Clerk and Convex. It currently imports Hevy workout CSV files and Sleep Cycle CSV files into per-user Convex tables. Those import paths remain available.

Google exercise sessions will appear in the new Activity health views. Hevy remains the source of set-level exercise history because the Google exercise model does not provide the same set details. Google sleep records will appear in the new Sleep health views; the existing Sleep Cycle import remains source-labeled and available. Source-aware views must not blindly sum overlapping observations from different providers.

## User Decisions

- Each HomeFit user connects their own Google account.
- The first connection imports all history Google exposes.
- HomeFit imports and displays all available metrics, not only sleep and workouts.
- The selected dashboard is the category-dashboard approach.
- Disconnecting stops synchronization but retains imported data.
- Deleting imported Google data is a separate destructive action.
- The selected storage architecture is a hybrid normalized envelope plus original payload and daily summaries.

## System Architecture

### Browser and Svelte UI

The browser uses the existing Clerk session and Convex authentication integration. It can:

- request a Google authorization URL from an authenticated Convex action;
- display connection, permission, backfill, and sync status;
- query category summaries, metric definitions, trends, and records;
- request an immediate sync;
- disconnect Google Health; and
- explicitly delete imported Google data after confirmation.

The browser never handles the Google client secret, refresh token, encryption key, or webhook credentials.

### Convex Backend

Convex provides:

- an authenticated action that begins OAuth;
- a public HTTP callback for Google OAuth;
- a public Google webhook endpoint that verifies the configured authorization
  header and Google's payload signature;
- internal actions that call the Google token and Health APIs;
- internal mutations that store connection state and imported records;
- scheduled, bounded backfill and incremental-sync jobs;
- a daily reconciliation cron;
- user-facing queries and mutations protected by Clerk identity; and
- chart-ready summary queries.

Public Convex functions are limited to operations required by the client. Ingestion, token handling, record writes, subscriptions, cursors, and maintenance functions are internal.

### Google Cloud and Google Health

The Google Cloud project supplies the OAuth client, OAuth consent configuration, Health API access, subscriber/subscription resources, webhook delivery, and required IAM permissions. Production access for arbitrary users requires the Google consent screen and sensitive/restricted health scopes to have the appropriate publication or verification status. Test-mode access remains limited to configured test users and may have shorter refresh-token lifetimes.

## OAuth Flow

1. An authenticated user selects **Connect Google Health**.
2. A Convex action derives the user from `ctx.auth.getUserIdentity()` and creates a cryptographically random, single-use OAuth state record. The stored value is a digest, not a reusable bearer value. The record includes an expiry and a validated post-callback return path.
3. The action returns a Google authorization URL requesting:
   - the configured read-only Google Health scopes for activity and fitness,
     ECG, health metrics and measurements, irregular-rhythm notifications,
     exercise location, nutrition, and sleep;
   - offline access; and
   - explicit consent when necessary to obtain or expand a refresh token.
4. Google redirects to the Convex HTTP callback with a code and state.
5. The callback hashes and atomically consumes the state. Unknown, expired, already-consumed, or mismatched state is rejected.
6. The callback exchanges the authorization code server-side using the Google client secret.
7. The refresh token is encrypted before storage. Access tokens are short-lived and are not persisted unless required during the active action.
8. The app calls `users/me/identity`, stores the stable Google `healthUserId`
   used by webhook notifications, moves the connection to `backfilling`, and
   schedules the first bounded import job. The project-level subscriber creates
   supported user subscriptions automatically from granted consent.
9. The callback redirects the browser to the HomeFit import page, where reactive Convex queries show progress.

Partial consent is valid when at least one granted metric scope can authorize the
identity lookup. HomeFit imports granted categories, reports missing
permissions, and offers **Review access** to repeat consent for omitted scopes.
`location.readonly` alone is not importable because Google does not authorize
`users/me/identity` with that scope and the current metric registry assigns no
data type to it.

## Credential Storage

Google credentials use explicit deployment environment variables rather than the current generic local names:

- `GOOGLE_HEALTH_CLIENT_ID`
- `GOOGLE_HEALTH_CLIENT_SECRET`
- `GOOGLE_HEALTH_REDIRECT_URI`
- `HOMEFIT_APP_URL`
- `GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION`
- `GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY`
- `GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION`
- `GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS` (optional JSON map of old version to key)
- any webhook audience or verification values required by the Google subscription configuration

`GOOGLE_HEALTH_PROJECT_NUMBER` and `GOOGLE_HEALTH_SUBSCRIBER_ID` are setup-only values used by the documented subscriber-management commands; application runtime code does not require them in the Convex deployment environment.

Refresh tokens are encrypted with AES-GCM in a Convex action before being passed to a persistence mutation. The stored envelope contains ciphertext, nonce, authentication tag, and key version. Decryption only occurs in an action immediately before a token refresh. Tokens and secrets are redacted from logs and user-visible errors.

Key rotation is supported by the versioned envelope: new writes use the current
version, old envelopes can be decrypted from the optional previous-key map, and
successful old-key reads schedule re-encryption with the current key.
The replacement mutation compares the connection generation and complete
previous envelope so a stale worker cannot overwrite credentials from a newer
reconnect.

## Data Model

All new tables use indexed, bounded access paths. No user-owned table is queried with an unbounded collection or full-table filter.

### `googleHealthOAuthStates`

Short-lived OAuth handshake records:

- `userId`
- `stateDigest`
- `expiresAt`
- `returnPath`
- optional `consumedAt`

Indexes support lookup by `stateDigest` and expiry-based cleanup. State consumption is atomic to prevent replay.

### `googleHealthConnections`

One logical connection per HomeFit user:

- `userId`
- `status`: `connecting`, `backfilling`, `active`, `delayed`, `action_required`, `disconnected`, or `deleting`
- encrypted refresh-token envelope fields
- granted scope metadata
- stable Google `healthUserId` returned by `users/me/identity`
- backfill totals and completed counts
- `lastAttemptAt`
- `lastSuccessfulSyncAt`
- optional redacted `lastErrorCode` and `lastErrorMessage`
- optional `nextRetryAt`
- optional `disconnectedAt`

The user index enforces one active logical connection through application-level transactional checks.

### `googleHealthSyncCursors`

Independent resumable state per connection and data type:

- `connectionId`
- `userId`
- `dataType`
- sync mode: `backfill` or `incremental`
- page token when present
- lower-bound watermark or last observed update time
- retry count and next-attempt time
- generation or lease information used to suppress duplicate concurrent workers

### `healthDataPoints`

One document per Google data point:

- `userId`
- provider discriminator: `google_health`
- deterministic `recordKey`, used as the idempotency key
- optional Google data-point name for identifiable types
- `dataType`
- display category
- normalized event, interval, or sample timestamps
- normalized local date derived from Google civil time/UTC offset
- optional primary scalar value and unit
- source platform, application, device, recording method, and data-source family when present
- Google create/update time when present
- canonical payload digest
- serialized original metric payload in `payloadJson`

The serialized payload preserves nested and future metric-specific fields. The importer validates that it is JSON-compatible and below a conservative document-size limit before storage.

Most reconciled Google data points do not have a data-point name. For an
identifiable type, `recordKey` is derived from that name. For every other type,
the metric registry defines stable identity fields such as the data type,
reconciled source family, sample time, interval bounds, daily date, and semantic
subtype. Measurement values are not identity fields. A completed reconciliation
window replaces the set of local keys in that window, which handles corrections
and deletions even when Google supplies no stable name.

Indexes support:

- user + data type + event time;
- user + category + event time; and
- user + record key for idempotent upserts.

### `healthDailySummaries`

Chart-ready aggregates per user, data type, and Google-derived local date:

- observation count;
- latest value and timestamp;
- applicable sum, average, minimum, and maximum;
- applicable interval duration; and
- source-aware aggregation metadata.

The per-type metric registry decides which aggregation fields are meaningful. A transactional check prevents duplicate summary rows for the same user, type, and local date.

### `googleHealthSyncRuns`

Bounded operational history records:

- connection and user IDs;
- trigger: callback, webhook, manual, retry, or reconciliation;
- data type and time range;
- start/end timestamps;
- pages and records fetched, inserted, updated, deleted, and skipped;
- final status; and
- redacted error code/message.

A maintenance job removes successful runs after 30 days and failed runs after 90 days.

## Metric Registry and Presentation

A code-owned metric registry maps every supported Google Health data type to:

- localized title and description;
- category;
- scope;
- endpoint and time-filter fields;
- response normalizer;
- primary-value formatter and unit;
- daily aggregation strategy; and
- visualization type.

The initial categories are Activity, Vitals, Sleep, Body, Nutrition, and Other.
Only categories containing imported data appear in navigation. The **All
metrics** page lists every imported metric with its latest value, source, and
update time. Types that currently expose only write operations, including the
current reproductive-health types, are not requested by this read-only app.

Known types receive tailored trend, interval, stage, session, or record views.
The registry supports `list`, `reconcile`, `rollUp`, and `dailyRollUp` read modes
because not every readable type exposes the same operation. Rollup requests are
split into Google's documented 14-day or 90-day maximum ranges. An unrecognized
incoming type or payload variant is preserved and displayed with a safe generic
record view under Other. A newly introduced Google data type may require adding
its scope/endpoint to the registry before HomeFit can request it, but it does not
require a database-schema migration.

Where Google supplies a reconcile endpoint or main/reconciled record, HomeFit uses it to avoid double-counting multiple devices. Otherwise, the type-specific aggregation strategy remains source-aware. Users can see the contributing device or application on detail pages.

## Import and Synchronization

### Initial Backfill

After OAuth, the coordinator creates a cursor for every configured data type covered by the granted scopes. Each worker:

1. refreshes an access token if needed;
2. requests one bounded Google Health page;
3. validates and normalizes each response;
4. upserts records by user and deterministic record key;
5. records affected local dates;
6. rebuilds only the affected daily summaries;
7. persists the next cursor; and
8. schedules the next bounded page.

The importer requests the full range supported by each endpoint and follows pagination until no continuation token remains. Long imports continue after the user navigates away. Progress is derived from completed and total data types plus known page activity; the UI does not claim a precise record percentage when Google does not expose a total.

### Webhook Sync

The webhook endpoint first enforces the configured `Authorization` value and
then verifies `GOOGLE-HEALTH-API-SIGNATURE` against the raw request body and
Google's rotating public keyset. It implements Google's two-step subscriber
verification handshake: an authorized verification request returns `201` and the
unauthorized challenge fails. A valid data notification is mapped to a HomeFit
connection by `healthUserId`; the endpoint schedules an incremental worker and
returns `204 No Content` promptly.

The Google Cloud project has one subscriber configured with `AUTOMATIC` policies
for every webhook-capable readable type. Google creates and removes the
per-user subscriptions as consent changes; HomeFit does not persist or manage
those automatic subscription resources individually. Types without webhook
support are covered by reconciliation.

Notifications are delivery hints rather than the sole source of truth.
Duplicate notifications are safe, including notifications received while the
same metric cursor is already running. `UPSERT` notifications reconcile the
affected type and time range. `DELETE` notifications remove an identifiable
record when a `recordId` is supplied or reconcile the affected window otherwise,
then rebuild affected summaries.

### Daily Reconciliation

A daily cron scans active connections through a bounded, indexed page and schedules reconciliation work. Reconciliation revisits a safe overlap window for each data type so delayed updates, missed notifications, and corrections are recovered. Watermarks advance only after a page commits successfully.

The user may also select **Sync now**. Manual sync uses the same coordinator, leases, cursors, and idempotent write path.

## User Interface

### Import Page Connection Card

The existing import page gains a Google Health card with these states:

- **Not connected:** explains read-only, all-metric import and starts OAuth.
- **Importing:** shows completed/total metric types and confirms that navigation is safe.
- **Active:** shows metric-type count, last successful sync, Sync now, and Manage actions.
- **Delayed:** retains existing data and reports automatic retry without requiring action.
- **Action needed:** explains expired/revoked access and offers reconnect.
- **Disconnected:** confirms that retained data remains available and offers reconnect or deletion.

### Category Dashboard

The approved Option A layout contains:

- a health overview with representative latest values and recent trends;
- navigation for non-empty categories;
- source-aware cards and charts;
- visible but unobtrusive sync/backfill status; and
- an All metrics catalog.

Default overview cards favor available daily-use measures such as steps, sleep, resting heart rate, and weight. There is no dashboard-customization feature in this release.

### Metric Detail

Every imported metric has a detail route with:

- localized name and category;
- latest value and applicable summary statistics;
- a date-range selector;
- the registry-selected visualization;
- recent records; and
- source device/application metadata.

Unknown types use the generic record view and remain fully visible.

All new UI copy is added to the existing English and Spanish Paraglide message catalogs.

## Disconnect and Deletion

### Disconnect

Disconnect is non-destructive:

1. stop and invalidate scheduled work through connection status/generation checks;
2. best-effort revoke Google access, which also stops Google's automatic
   per-user subscriptions;
3. remove the stored refresh-token envelope; and
4. retain imported data points and summaries with source labels.

A failed external revocation does not preserve a usable local token. The connection becomes `disconnected` and can be reconnected later.

### Delete Imported Google Data

Deletion is a separate destructive action requiring typed confirmation. It:

1. performs the disconnect sequence;
2. marks the connection `deleting` so no new work can start;
3. deletes summary dependencies, compact point contributions, summary rebuild
   state, OAuth states, data points, summaries, cursors, and sync runs in
   bounded indexed batches; and
4. deletes the connection after all owned Google records are gone.

Hevy and Sleep Cycle CSV data are outside this deletion scope.

## Error Handling and Observability

- Google rate limits and transient server/network errors retry with capped exponential backoff and jitter.
- `invalid_grant`, revoked consent, or an unusable refresh token sets `action_required`; it never deletes imported data.
- Bounded page jobs prevent function timeouts and allow exact cursor resumption.
- Per-connection/type generation or lease checks suppress concurrent duplicate workers.
- Malformed individual records are skipped with a redacted run error; valid records in the same page may still import.
- A page cursor advances only after its data and affected summaries commit.
- User-facing messages are concise and never expose payloads, tokens, secrets, stack traces, or Google account identifiers.
- Sync-run records provide counts, triggers, timings, and redacted failure categories.

## Security Requirements

- Use `identity.tokenIdentifier` as the canonical Clerk ownership key.
- Never accept a client-provided user ID for authorization.
- Use read-only Google Health scopes only.
- Store secrets only in Convex deployment environment variables and ignored local environment files.
- Encrypt refresh tokens at rest and never expose them through public Convex returns.
- Validate OAuth return paths against an application-owned allowlist.
- Hash, expire, and atomically consume OAuth state.
- Verify webhook authenticity and intended audience before scheduling work.
- Validate external JSON and enforce conservative record-size limits.
- Apply ownership checks to every public health query and mutation.
- Redact secrets and sensitive payload contents from logs and errors.

## Testing and Acceptance Criteria

### Unit Tests

- Normalize representative samples from every configured Google data type.
- Preserve unknown fields and render unknown payload variants generically.
- Derive local dates from Google civil time and UTC offsets, including daylight-saving boundaries.
- Apply sum, latest, average, range, duration, and source-aware strategies correctly.
- Handle malformed and conservatively oversized payloads safely.

### Convex Tests

- Two mocked Clerk users cannot read, mutate, disconnect, sync, or delete each other’s data.
- OAuth state expires, is single-use, and cannot be replayed.
- Public functions never return encrypted-token fields.
- Re-importing the same named or unnamed reconciled page is idempotent.
- A newer Google update replaces the older version and rebuilds affected summaries.
- A provider deletion removes only the matching Google record.
- Disconnect retains data and removes usable credentials.
- Explicit deletion removes only the requesting user’s Google-imported records.
- Bounded pagination and reconciliation resume from committed cursors.

### Google API Contract Tests

Mocked token and Health API responses cover:

- authorization-code exchange and token refresh;
- multi-page history;
- partial scopes;
- duplicate webhooks;
- webhook create/update/delete notifications;
- rate limits, transient failures, invalid grants, and retry behavior; and
- reconciled/source-aware endpoints where supported.

### Svelte Tests

- Render every connection-card state.
- Show backfill progress without blocking navigation.
- Render category, all-metrics, known metric detail, and unknown metric fallback views.
- Confirm disconnect and require typed confirmation for deletion.
- Verify English and Spanish messages.

Every written Svelte component must pass the project’s Svelte autofixer before completion.

### End-to-End Verification

- Complete OAuth with a configured Google test account.
- Import available history and observe progressive dashboard population.
- Deliver a verified webhook and observe an incremental update.
- Confirm daily/manual reconciliation is idempotent.
- Disconnect and confirm retained data remains visible.
- Reconnect and confirm synchronization resumes without duplicates.
- Delete Google data and confirm Hevy/Sleep Cycle data remains.
- Pass type checking, linting, unit/component tests, production build, and a clean Convex validation push.

## Completion Criteria

The feature is complete when a Clerk-authenticated test user can connect Google Health, import all supported and granted historical metrics, view every imported metric through the approved category interface, receive automatic updates, recover from missed notifications, disconnect without data loss, and explicitly delete only their Google-imported data. No Google secret or usable refresh token may appear in client bundles, public Convex results, logs, or committed files.
