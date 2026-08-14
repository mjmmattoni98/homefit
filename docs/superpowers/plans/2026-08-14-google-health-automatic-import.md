# Google Health Automatic Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every Clerk-authenticated HomeFit user connect Google Health, import all 40 currently readable health data types, browse every imported metric, and stay synchronized through verified webhooks plus reconciliation.

**Architecture:** Convex is the sole backend and owns OAuth, AES-GCM-encrypted refresh tokens, the Google Health v4 client, bounded import jobs, webhook verification, reconciliation, generic health records, and daily summaries. Svelte exposes connection controls and the approved category dashboard; every metric uses the same normalized envelope while preserving its canonical Google payload.

**Tech Stack:** Svelte 5.56, SvelteKit 2.63, TypeScript 6, Convex 1.42, Clerk, convex-svelte, Paraglide, shadcn-svelte, LayerChart, Vitest, convex-test, Google Health REST API v4, Node `crypto`.

**Spec:** `docs/superpowers/specs/2026-08-14-google-health-automatic-import-design.md`

## Global Constraints

- Read `src/convex/_generated/ai/guidelines.md` before every Convex task.
- Every registered Convex function uses object form with `args` and `returns` validators; client-only entry points are public and all ingestion/persistence helpers are internal.
- Every growing read path uses a named index and `.take(...)` or `.paginate(...)`; never use `.filter()` or unbounded `.collect()`.
- Derive ownership from `identity.tokenIdentifier`; never accept a user ID from the client.
- Request only these read-only scopes: `activity_and_fitness`, `ecg`, `health_metrics_and_measurements`, `irn`, `location`, `nutrition`, and `sleep`.
- Import all 40 readable types listed in Task 2; exclude write-only menstrual-period, moods, ovulation-test, and symptoms.
- Treat automatic Google subscriptions as project-level configuration; do not create or persist per-user subscription records.
- A Google webhook must pass the configured `Authorization` value and Tink-prefixed ECDSA signature verification before work is scheduled.
- Keep refresh tokens, OAuth client secrets, encryption keys, webhook secrets, raw payloads, and Google account identifiers out of browser responses and logs.
- Disconnect retains data; only the separately confirmed delete flow removes Google-imported records.
- Add all user-facing text to both `messages/en.json` and `messages/es.json`.
- Use existing shadcn-svelte components and semantic theme tokens. Run the Svelte autofixer on every written Svelte component when the Svelte MCP is available, then run `bun run check` regardless.
- Do not deploy or change Convex deployment environment variables until the Convex deployment guard has classified the target and obtained any consent it requires.

---

## File Structure

### Convex backend

- `src/convex/schema.ts` — add Google connection, cursor, point, summary, OAuth-state, and run-history tables.
- `src/convex/convex.config.ts` — type the required Google Health environment variables.
- `src/convex/helpers.ts` — allow authenticated actions to reuse `requireUserId`.
- `src/convex/googleHealth/validators.ts` — shared Convex validators and inferred domain types.
- `src/convex/googleHealth/registry.ts` — authoritative 40-type metric registry, scopes, operations, categories, identity strategy, and aggregation strategy.
- `src/convex/googleHealth/normalize.ts` — canonical JSON, stable record keys, timestamp extraction, and normalized envelopes.
- `src/convex/googleHealth/crypto.ts` — OAuth-state hashing and AES-256-GCM token envelopes.
- `src/convex/googleHealth/apiClient.ts` — OAuth/token, identity, list/reconcile/dailyRollUp, revoke, and typed Google error handling.
- `src/convex/googleHealth/model.ts` — internal connection/state/cursor/run persistence and public status query.
- `src/convex/googleHealth/records.ts` — idempotent point writes, reconciliation-window replacement, summary rebuilding, and health queries.
- `src/convex/googleHealth/oauth.ts` — authenticated begin action and internal callback action.
- `src/convex/googleHealth/sync.ts` — bounded backfill/incremental Node actions and retry classification.
- `src/convex/googleHealth/webhookSignature.ts` — Google Tink prefix/public-keyset parsing and ECDSA verification.
- `src/convex/googleHealth/webhook.ts` — authorization, handshake, payload validation, health-user mapping, and scheduling.
- `src/convex/googleHealth/account.ts` — manual sync, disconnect, revoke, and bounded destructive deletion.
- `src/convex/googleHealth/maintenance.ts` — daily reconciliation and run/OAuth-state retention batches.
- `src/convex/http.ts` — OAuth callback and webhook routes.
- `src/convex/crons.ts` — internal daily reconciliation and cleanup jobs.

### Svelte application

- `src/lib/google-health/labels.ts` — localized category/metric/status lookup functions.
- `src/lib/components/google-health/GoogleHealthImportCard.svelte` — connection state and actions on the Import page.
- `src/lib/components/google-health/HealthMetricCard.svelte` — reusable latest-value metric card.
- `src/lib/components/google-health/HealthTrendChart.svelte` — generic scalar/duration trend chart.
- `src/lib/components/google-health/HealthSyncBanner.svelte` — importing, delayed, and action-required feedback.
- `src/routes/dashboard/import/+page.svelte` — add the Google Health connection card.
- `src/routes/dashboard/+layout.svelte` — add Health and non-empty category navigation.
- `src/routes/dashboard/health/+page.svelte` — health overview.
- `src/routes/dashboard/health/[category]/+page.svelte` — category metric grid.
- `src/routes/dashboard/health/metrics/+page.svelte` — all-metrics catalog.
- `src/routes/dashboard/health/metrics/[dataType]/+page.svelte` — detail chart and paginated records.
- `messages/en.json`, `messages/es.json` — connection, navigation, category, status, action, and 40 metric labels.

### Tests and operations

- `src/convex/googleHealth/*.spec.ts` — pure and convex-test backend coverage.
- `src/lib/components/google-health/*.svelte.spec.ts` — component-state tests.
- `.env.example` — documented non-secret variable names.
- `docs/google-health-setup.md` — Google Cloud OAuth, Convex env, automatic subscriber, test-user, and verification checklist.

---

### Task 1: Test Foundation, Validators, and Indexed Schema

**Files:**
- Modify: `package.json`
- Modify: `bun.lock`
- Modify: `src/convex/schema.ts`
- Modify: `src/convex/helpers.ts`
- Create: `src/convex/googleHealth/validators.ts`
- Create: `src/convex/googleHealth/schema.spec.ts`

**Interfaces:**
- Produces: `requireUserId(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<string>`.
- Produces: `connectionStatusValidator`, `healthCategoryValidator`, `syncModeValidator`, `syncTriggerValidator`, and `normalizedHealthPointValidator`.
- Produces the six tables consumed by every later backend task.

- [ ] **Step 1: Install the in-memory Convex test harness**

Run:

```bash
bun add --dev convex-test
```

Expected: `convex-test` appears in `devDependencies`, and only `package.json` plus `bun.lock` change.

- [ ] **Step 2: Write the failing schema/auth test**

Create `src/convex/googleHealth/schema.spec.ts` with a test that imports `schema`, initializes `convexTest(schema, modules)`, verifies an unauthenticated call to a temporary public status query throws `Not authenticated`, and verifies two identities receive different `tokenIdentifier` values through `requireUserId`.

```ts
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/!(*.*.*)*.*s");

describe("Google Health ownership foundation", () => {
  it("rejects unauthenticated status reads", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.googleHealth.model.getConnectionStatus, {})).rejects.toThrow(
      "Not authenticated",
    );
  });
});
```

- [ ] **Step 3: Run the test and confirm the missing API fails**

Run:

```bash
bunx vitest --project convex --run src/convex/googleHealth/schema.spec.ts
```

Expected: FAIL because `api.googleHealth.model.getConnectionStatus` and the Google Health schema do not exist.

- [ ] **Step 4: Add validators and tables**

Define these literal unions in `validators.ts`:

```ts
export const connectionStatusValidator = v.union(
  v.literal("connecting"), v.literal("backfilling"), v.literal("active"),
  v.literal("delayed"), v.literal("action_required"),
  v.literal("disconnected"), v.literal("deleting"),
);
export const healthCategoryValidator = v.union(
  v.literal("activity"), v.literal("vitals"), v.literal("sleep"),
  v.literal("body"), v.literal("nutrition"), v.literal("other"),
);
export const syncModeValidator = v.union(v.literal("backfill"), v.literal("incremental"));
export const syncTriggerValidator = v.union(
  v.literal("oauth"), v.literal("webhook"), v.literal("manual"),
  v.literal("retry"), v.literal("reconciliation"),
);
```

Add these exact tables and indexes to `schema.ts`:

```ts
googleHealthOAuthStates: defineTable({
  userId: v.string(), stateDigest: v.string(), expiresAt: v.number(),
  returnPath: v.string(), consumedAt: v.optional(v.number()),
}).index("by_stateDigest", ["stateDigest"]).index("by_expiresAt", ["expiresAt"])
  .index("by_userId", ["userId"]),
googleHealthConnections: defineTable({
  userId: v.string(), healthUserId: v.optional(v.string()),
  status: connectionStatusValidator,
  encryptedRefreshToken: v.optional(v.string()), tokenNonce: v.optional(v.string()),
  tokenTag: v.optional(v.string()), tokenKeyVersion: v.optional(v.string()),
  grantedScopes: v.array(v.string()), generation: v.number(),
  backfillTotalTypes: v.number(), backfillCompletedTypes: v.number(),
  lastAttemptAt: v.optional(v.number()), lastSuccessfulSyncAt: v.optional(v.number()),
  lastErrorCode: v.optional(v.string()), lastErrorMessage: v.optional(v.string()),
  nextRetryAt: v.optional(v.number()), disconnectedAt: v.optional(v.number()),
}).index("by_userId", ["userId"]).index("by_healthUserId", ["healthUserId"])
  .index("by_status", ["status"]),
googleHealthSyncCursors: defineTable({
  connectionId: v.id("googleHealthConnections"), userId: v.string(), dataType: v.string(),
  mode: syncModeValidator, status: v.union(v.literal("queued"), v.literal("running"),
    v.literal("complete"), v.literal("retry")),
  pageToken: v.optional(v.string()), windowStart: v.optional(v.string()),
  windowEnd: v.optional(v.string()), watermark: v.optional(v.string()),
  syncId: v.string(), attempt: v.number(), generation: v.number(), updatedAt: v.number(),
}).index("by_connectionId_and_dataType_and_mode", ["connectionId", "dataType", "mode"])
  .index("by_userId", ["userId"]).index("by_status_and_updatedAt", ["status", "updatedAt"]),
healthDataPoints: defineTable({
  connectionId: v.id("googleHealthConnections"), userId: v.string(),
  provider: v.literal("google_health"), recordKey: v.string(),
  googleDataPointName: v.optional(v.string()), dataType: v.string(),
  category: healthCategoryValidator, recordTimestamp: v.number(),
  startTime: v.optional(v.number()), endTime: v.optional(v.number()), localDate: v.string(),
  primaryValue: v.optional(v.number()), primaryUnit: v.optional(v.string()),
  sourcePlatform: v.optional(v.string()), sourceApplication: v.optional(v.string()),
  sourceDevice: v.optional(v.string()), recordingMethod: v.optional(v.string()),
  googleCreateTime: v.optional(v.number()), googleUpdateTime: v.optional(v.number()),
  payloadDigest: v.string(), payloadJson: v.string(), lastSeenSyncId: v.string(),
}).index("by_userId_and_recordKey", ["userId", "recordKey"])
  .index("by_userId_and_dataType_and_recordTimestamp", ["userId", "dataType", "recordTimestamp"])
  .index("by_userId_and_dataType_and_localDate", ["userId", "dataType", "localDate"])
  .index("by_userId_and_category_and_recordTimestamp", ["userId", "category", "recordTimestamp"])
  .index("by_connectionId", ["connectionId"]),
healthDailySummaries: defineTable({
  connectionId: v.id("googleHealthConnections"), userId: v.string(),
  dataType: v.string(), category: healthCategoryValidator, localDate: v.string(),
  count: v.number(), latestValue: v.optional(v.number()), latestTimestamp: v.optional(v.number()),
  sum: v.optional(v.number()), average: v.optional(v.number()), min: v.optional(v.number()),
  max: v.optional(v.number()), durationSeconds: v.optional(v.number()), computedAt: v.number(),
}).index("by_userId_and_dataType_and_localDate", ["userId", "dataType", "localDate"])
  .index("by_userId_and_category_and_localDate", ["userId", "category", "localDate"])
  .index("by_connectionId", ["connectionId"]),
googleHealthSyncRuns: defineTable({
  connectionId: v.id("googleHealthConnections"), userId: v.string(),
  trigger: syncTriggerValidator, dataType: v.string(),
  rangeStart: v.optional(v.string()), rangeEnd: v.optional(v.string()),
  startedAt: v.number(), finishedAt: v.optional(v.number()), pages: v.number(),
  fetched: v.number(), inserted: v.number(), updated: v.number(),
  deleted: v.number(), skipped: v.number(),
  status: v.union(v.literal("running"), v.literal("succeeded"), v.literal("failed")),
  errorCode: v.optional(v.string()), errorMessage: v.optional(v.string()),
}).index("by_connectionId_and_startedAt", ["connectionId", "startedAt"])
  .index("by_userId_and_startedAt", ["userId", "startedAt"])
  .index("by_status_and_startedAt", ["status", "startedAt"]),
```

Extend `requireUserId` to accept `ActionCtx`. Add `getConnectionStatus` with `args: {}`, an explicit nullable return validator that excludes all token-envelope fields, and an indexed `by_userId` lookup.

- [ ] **Step 5: Run focused tests and type checking**

Run:

```bash
bunx vitest --project convex --run src/convex/googleHealth/schema.spec.ts
bunx tsc --noEmit -p src/convex/tsconfig.json
```

Expected: both commands pass.

- [ ] **Step 6: Commit the foundation**

```bash
git add package.json bun.lock src/convex/schema.ts src/convex/helpers.ts src/convex/googleHealth/validators.ts src/convex/googleHealth/schema.spec.ts
git commit -m "feat: add Google Health data model"
```

---

### Task 2: Complete Google Health Metric Registry

**Files:**
- Create: `src/convex/googleHealth/registry.ts`
- Create: `src/convex/googleHealth/registry.spec.ts`

**Interfaces:**
- Produces: `GOOGLE_HEALTH_READ_SCOPES: readonly string[]`.
- Produces: `METRIC_DEFINITIONS: readonly MetricDefinition[]`.
- Produces: `getMetricDefinition(dataType: string): MetricDefinition | null`.
- `MetricDefinition` contains `dataType`, `payloadField`, `recordKind`, `category`, `scope`, `readMode`, `webhook`, `aggregation`, `primaryUnit`, registry-owned identity selectors, an optional typed primary-value strategy, lifecycle-timestamp placement, and the optional maximum window.

- [ ] **Step 1: Write registry completeness tests**

Assert that the registry contains exactly 40 unique kebab-case identifiers, contains no write-only types, uses only seven approved read-only scopes, and marks the 27 official webhook-capable identifiers correctly.

```ts
const expected = [
  "active-energy-burned", "active-minutes", "active-zone-minutes", "activity-level",
  "altitude", "basal-energy-burned", "blood-glucose", "body-fat", "calories-in-heart-rate-zone",
  "core-body-temperature", "daily-heart-rate-variability", "daily-heart-rate-zones",
  "daily-oxygen-saturation", "daily-respiratory-rate", "daily-resting-heart-rate",
  "daily-sleep-temperature-derivations", "daily-vo2-max", "distance",
  "electrocardiogram", "exercise", "floors", "food", "food-measurement-unit",
  "heart-rate", "heart-rate-variability", "height", "hydration-log",
  "irregular-rhythm-notification", "nutrition-log", "oxygen-saturation",
  "respiratory-rate-sleep-summary", "run-vo2-max", "sedentary-period", "sleep",
  "steps", "swim-lengths-data", "time-in-heart-rate-zone", "total-calories",
  "vo2-max", "weight",
] as const;
expect(METRIC_DEFINITIONS.map((d) => d.dataType).sort()).toEqual([...expected].sort());
```

- [ ] **Step 2: Run the registry test and verify failure**

```bash
bunx vitest --project convex --run src/convex/googleHealth/registry.spec.ts
```

Expected: FAIL because `registry.ts` does not exist.

- [ ] **Step 3: Implement the registry**

Use this exact compact source table; `reconcile` is preferred where supported, `list` is used for non-reconcilable resources, and `dailyRollUp` is used for the two rollup-only metrics:

```ts
const definitions = [
  ["active-energy-burned","activeEnergyBurned","interval","activity","activity_and_fitness","reconcile",false,"sum","kcal"],
  ["active-minutes","activeMinutes","interval","activity","activity_and_fitness","reconcile",false,"sum","min"],
  ["active-zone-minutes","activeZoneMinutes","interval","activity","activity_and_fitness","reconcile",true,"sum","min"],
  ["activity-level","activityLevel","interval","activity","activity_and_fitness","reconcile",true,"duration",""],
  ["altitude","altitude","interval","activity","activity_and_fitness","reconcile",true,"sum","m"],
  ["basal-energy-burned","basalEnergyBurned","interval","activity","activity_and_fitness","reconcile",false,"sum","kcal"],
  ["blood-glucose","bloodGlucose","sample","vitals","health_metrics_and_measurements","reconcile",true,"average","mmol/L"],
  ["body-fat","bodyFat","sample","body","health_metrics_and_measurements","reconcile",true,"average","%"],
  ["calories-in-heart-rate-zone","caloriesInHeartRateZone","daily","activity","activity_and_fitness","dailyRollUp",true,"sum","kcal"],
  ["core-body-temperature","coreBodyTemperature","sample","vitals","health_metrics_and_measurements","reconcile",false,"average","°C"],
  ["daily-heart-rate-variability","dailyHeartRateVariability","daily","vitals","health_metrics_and_measurements","reconcile",true,"latest","ms"],
  ["daily-heart-rate-zones","dailyHeartRateZones","daily","vitals","health_metrics_and_measurements","reconcile",true,"latest",""],
  ["daily-oxygen-saturation","dailyOxygenSaturation","daily","vitals","health_metrics_and_measurements","reconcile",true,"average","%"],
  ["daily-respiratory-rate","dailyRespiratoryRate","daily","vitals","health_metrics_and_measurements","reconcile",true,"average","breaths/min"],
  ["daily-resting-heart-rate","dailyRestingHeartRate","daily","vitals","health_metrics_and_measurements","reconcile",true,"latest","bpm"],
  ["daily-sleep-temperature-derivations","dailySleepTemperatureDerivations","daily","vitals","health_metrics_and_measurements","reconcile",true,"latest","°C"],
  ["daily-vo2-max","dailyVo2Max","daily","activity","activity_and_fitness","reconcile",false,"latest","mL/kg/min"],
  ["distance","distance","interval","activity","activity_and_fitness","reconcile",true,"sum","m"],
  ["electrocardiogram","electrocardiogram","session","vitals","ecg","list",false,"latest",""],
  ["exercise","exercise","session","activity","activity_and_fitness","reconcile",true,"duration","min"],
  ["floors","floors","interval","activity","activity_and_fitness","reconcile",true,"sum","floors"],
  ["food","food","reference","nutrition","nutrition","list",false,"latest",""],
  ["food-measurement-unit","foodMeasurementUnit","reference","nutrition","nutrition","list",false,"latest",""],
  ["heart-rate","heartRate","sample","vitals","health_metrics_and_measurements","reconcile",true,"average","bpm"],
  ["heart-rate-variability","heartRateVariability","sample","vitals","health_metrics_and_measurements","reconcile",true,"average","ms"],
  ["height","height","sample","body","health_metrics_and_measurements","reconcile",true,"latest","m"],
  ["hydration-log","hydrationLog","session","nutrition","nutrition","reconcile",true,"sum","mL"],
  ["irregular-rhythm-notification","irregularRhythmNotification","session","vitals","irn","list",false,"latest",""],
  ["nutrition-log","nutritionLog","session","nutrition","nutrition","reconcile",true,"sum","kcal"],
  ["oxygen-saturation","oxygenSaturation","sample","vitals","health_metrics_and_measurements","reconcile",false,"average","%"],
  ["respiratory-rate-sleep-summary","respiratoryRateSleepSummary","sample","vitals","health_metrics_and_measurements","reconcile",true,"average","breaths/min"],
  ["run-vo2-max","runVo2Max","sample","activity","activity_and_fitness","reconcile",true,"latest","mL/kg/min"],
  ["sedentary-period","sedentaryPeriod","interval","activity","activity_and_fitness","reconcile",true,"duration",""],
  ["sleep","sleep","session","sleep","sleep","reconcile",true,"duration","min"],
  ["steps","steps","interval","activity","activity_and_fitness","reconcile",true,"sum","steps"],
  ["swim-lengths-data","swimLengthsData","interval","activity","activity_and_fitness","reconcile",false,"sum","strokes"],
  ["time-in-heart-rate-zone","timeInHeartRateZone","interval","activity","activity_and_fitness","reconcile",true,"duration",""],
  ["total-calories","totalCalories","daily","activity","activity_and_fitness","dailyRollUp",false,"sum","kcal"],
  ["vo2-max","vo2Max","sample","activity","activity_and_fitness","reconcile",false,"latest","mL/kg/min"],
  ["weight","weight","sample","body","health_metrics_and_measurements","reconcile",true,"latest","kg"],
] as const;
```

Build each scope by appending `${scopeSuffix}.readonly` to `https://www.googleapis.com/auth/googlehealth.`, add `https://www.googleapis.com/auth/googlehealth.location.readonly`, and expose deeply immutable definitions through a `Map` lookup. Store per-type stable identity paths (including prioritized alternatives where needed) and typed `direct`, `sum`, or protobuf-duration primary-value strategies. Every non-empty `primaryUnit` must have an explicit compatible strategy; ambiguous complex metrics omit `primaryValue`. Set the daily-rollup maximum window to 14 days for calories-in-heart-rate-zone and total-calories; default other future rollup definitions to 90 days.

- [ ] **Step 4: Run the registry test**

```bash
bunx vitest --project convex --run src/convex/googleHealth/registry.spec.ts
```

Expected: PASS with 40 unique definitions and seven read-only scopes.

- [ ] **Step 5: Commit the registry**

```bash
git add src/convex/googleHealth/registry.ts src/convex/googleHealth/registry.spec.ts
git commit -m "feat: define Google Health metric registry"
```

---

### Task 3: Canonical Normalization and Stable Identity

**Files:**
- Create: `src/convex/googleHealth/normalize.ts`
- Create: `src/convex/googleHealth/normalize.spec.ts`
- Modify: `src/convex/googleHealth/validators.ts`
- Modify: `src/convex/googleHealth/registry.ts`
- Modify: `src/convex/googleHealth/registry.spec.ts`

**Interfaces:**
- Consumes: `MetricDefinition` from Task 2.
- Produces: `normalizeGooglePoint(definition, raw, options?): NormalizedHealthPoint`, where `options.sourceFamily` carries the actual reconciliation family.
- Produces: `canonicalJson(value: unknown): string` and `sha256Base64Url(value: string): string`.
- `NormalizedHealthPoint.recordKey` is stable across measurement corrections.

- [ ] **Step 1: Write failing normalizer tests**

Cover current-v4 fixtures for a named sleep session, nutrition session, unnamed heart-rate sample, unnamed steps interval, daily record, daily-rollup record, named reference record, correction with a changed measurement value, invalid payload, and payloads above 750 KiB. Also cover nanosecond-distinct physical times, strict timezone/calendar rejection, unit conversions, aggregate strategies, lifecycle timestamps, source metadata, the implicit `all-sources` family, semantic identity alternatives, and reversed intervals/windows. The correction assertion is essential:

```ts
const first = normalizeGooglePoint(heartRate, {
  heartRate: { sampleTime: { physicalTime: "2026-08-14T10:00:00Z" }, beatsPerMinute: 61 },
});
const corrected = normalizeGooglePoint(heartRate, {
  heartRate: { sampleTime: { physicalTime: "2026-08-14T10:00:00Z" }, beatsPerMinute: 63 },
});
expect(corrected.recordKey).toBe(first.recordKey);
expect(corrected.payloadDigest).not.toBe(first.payloadDigest);
```

- [ ] **Step 2: Run tests and verify failure**

```bash
bunx vitest --project convex --run src/convex/googleHealth/normalize.spec.ts
```

Expected: FAIL because the normalizer is missing.

- [ ] **Step 3: Implement canonicalization and normalization**

Implement recursive plain-JSON validation with sorted object keys. Extract identity from:

```ts
type RecordIdentity =
  | { kind: "named"; name: string }
  | { kind: "sample"; time: string; subtype: string; sourceFamily?: string }
  | { kind: "interval"; start: string; end: string; subtype: string; sourceFamily?: string }
  | { kind: "daily"; date: string; windowStart?: string; windowEnd?: string; subtype: string; sourceFamily?: string }
  | { kind: "session"; start: string; end: string; subtype: string; sourceFamily?: string }
  | { kind: "reference"; nameOrCanonicalId: string; sourceFamily?: string };
```

For named points use `name` or `dataPointName`. Named reference resources require a resource name. Otherwise use registry-owned identity selectors with time/date or full daily-rollup window bounds; include stable semantic subtype fields such as exercise type, sleep type, zone, or prioritized nutrition food reference/display-name alternatives, but never include a mutable measured value. Do not promote a source-local ID to sole identity without concrete source identity. Include the actual reconciliation source family; normalize an omitted reconcile/rollup family to Google's documented `users/me/dataSourceFamilies/all-sources` default. Hash `dataType + "\n" + canonicalJson(identity)` with SHA-256 for `recordKey`, and hash full canonical payload separately for `payloadDigest`.

Parse physical time as strict RFC 3339, retain canonical nanosecond precision in identity while storing epoch milliseconds for queries, fall back to civil time, derive `localDate` from civil date before UTC time, and reject reversed or unusable time ranges except named reference records. Preserve list-record `DataSource` metadata and sleep/exercise payload lifecycle timestamps. Limit canonical UTF-8 `payloadJson` to 750 KiB and retain own JSON keys such as `__proto__`. Derive `primaryValue` only through the registry's explicit unit-compatible strategy, including required gram/millimeter/mg-dL conversions and all-or-nothing aggregate sums; complex records without an unambiguous scalar render as “Recorded.”

- [ ] **Step 4: Run normalizer tests**

```bash
bunx vitest --project convex --run src/convex/googleHealth/normalize.spec.ts
```

Expected: PASS, including stable keys for changed values.

- [ ] **Step 5: Commit the normalizer**

```bash
git add src/convex/googleHealth/normalize.ts src/convex/googleHealth/normalize.spec.ts src/convex/googleHealth/validators.ts src/convex/googleHealth/registry.ts src/convex/googleHealth/registry.spec.ts
git commit -m "feat: normalize Google Health records"
```

---

### Task 4: Environment Contract, Token Encryption, and Connection Model

**Files:**
- Create: `src/convex/convex.config.ts`
- Create: `src/convex/googleHealth/crypto.ts`
- Create: `src/convex/googleHealth/crypto.spec.ts`
- Create: `src/convex/googleHealth/model.ts`
- Create: `src/convex/googleHealth/model.spec.ts`

**Interfaces:**
- Produces: `EncryptedTokenEnvelope` and `encryptRefreshToken`/`decryptRefreshToken`.
- Produces internal functions `createOAuthState`, `consumeOAuthState`, `saveConnection`, `getConnectionForSync`, `initializeCursors`, and `setConnectionError`.
- Produces public `getConnectionStatus` without token fields.

- [ ] **Step 1: Write failing cryptography tests**

Use fixed active and previous 32-byte base64 test keys. Assert round-trip encryption, random nonces, failure under the wrong user AAD, failure after ciphertext modification, old-version decryption through the previous-key map, and re-encryption under the active version.

```ts
const encrypted = encryptRefreshToken("refresh-token", "user-a", TEST_KEY, "v1");
expect(decryptRefreshToken(encrypted, "user-a", TEST_KEY)).toBe("refresh-token");
expect(() => decryptRefreshToken(encrypted, "user-b", TEST_KEY)).toThrow();
```

- [ ] **Step 2: Write failing model tests**

With convex-test, verify OAuth state is found by digest, expires after 10 minutes, is consumed exactly once, connection upsert increments `generation`, cursor initialization creates one cursor for every scope-covered registry entry, reconnect requeues stale-generation cursors without duplicating them, and public status never contains ciphertext/nonce/tag. Cover fail-closed partial token envelopes, generation-guarded error writes, a same-key-version reconnect race, and a complete old-key read → re-encrypt → guarded persistence flow.

- [ ] **Step 3: Run focused tests and verify failure**

```bash
bunx vitest --project convex --run src/convex/googleHealth/crypto.spec.ts src/convex/googleHealth/model.spec.ts
```

Expected: FAIL because the implementation files are absent.

- [ ] **Step 4: Type the environment and implement AES-GCM**

Define these environment values in `convex.config.ts`: required `GOOGLE_HEALTH_CLIENT_ID`, `GOOGLE_HEALTH_CLIENT_SECRET`, `GOOGLE_HEALTH_REDIRECT_URI`, `HOMEFIT_APP_URL`, `GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY`, `GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION`, and `GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION`, plus optional `GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS` containing a JSON object whose keys are old versions and values are base64-encoded 32-byte keys.

Use AES-256-GCM with a fresh 12-byte nonce and AAD `${userId}:${keyVersion}`. Store base64url ciphertext, nonce, and 16-byte tag separately. Validate that every decoded key is exactly 32 bytes. Decrypt with the envelope's version from the active key or parsed previous-key map; after an old-key read, persist a newly encrypted envelope under the active version.

- [ ] **Step 5: Implement indexed connection/state/cursor mutations**

Every function has explicit validators. `consumeOAuthState` queries `by_stateDigest` and patches `consumedAt` in the same mutation; it throws for missing, expired, or consumed records. `saveConnection` indexes by user, preserves existing Google records on reconnect, updates the encrypted envelope and `healthUserId`, clears redacted errors, and increments `generation`. `getConnectionForSync` returns a complete token envelope or `null` and rejects partial storage. `initializeCursors` creates missing `backfill` cursors for granted scopes and requeues scope-covered cursors from a stale generation with cleared continuation/window state. Error writes require the expected active generation. Token-envelope replacement compares the expected generation and complete prior envelope before persisting a rotated envelope.

- [ ] **Step 6: Run tests and type checking**

```bash
bunx vitest --project convex --run src/convex/googleHealth/crypto.spec.ts src/convex/googleHealth/model.spec.ts
bunx tsc --noEmit -p src/convex/tsconfig.json
```

Expected: PASS.

- [ ] **Step 7: Commit environment and connection foundations**

```bash
git add src/convex/convex.config.ts src/convex/googleHealth/crypto.ts src/convex/googleHealth/crypto.spec.ts src/convex/googleHealth/model.ts src/convex/googleHealth/model.spec.ts
git commit -m "feat: secure Google Health connections"
```

---

### Task 5: OAuth and Google Health API Client

**Files:**
- Create: `src/convex/googleHealth/apiClient.ts`
- Create: `src/convex/googleHealth/apiClient.spec.ts`
- Create: `src/convex/googleHealth/oauth.ts`
- Create: `src/convex/googleHealth/oauth.spec.ts`
- Create: `src/convex/http.ts`

**Interfaces:**
- Produces: `buildAuthorizationUrl`, `exchangeAuthorizationCode`, `refreshAccessToken`, `getHealthIdentity`, `revokeGoogleToken`, and `fetchHealthPage`.
- Produces public action `api.googleHealth.oauth.beginConnection({ returnPath })` returning `{ authorizationUrl }`.
- Produces internal action `internal.googleHealth.oauth.completeOAuth({ code, state })`.
- Produces `GET /google-health/oauth/callback`.

- [ ] **Step 1: Write failing URL and response-contract tests**

Assert that the authorization URL uses `https://accounts.google.com/o/oauth2/v2/auth`, `response_type=code`, `access_type=offline`, `include_granted_scopes=true`, `prompt=consent`, the exact configured redirect URI, and all seven read-only scopes. Mock fetch to validate token exchange, refresh with stored-scope fallback when `scope` is omitted, optional replacement refresh-token metadata, `GET /v4/users/me/identity`, error redaction, abort deadlines, capped response bodies, and network failure classification.

- [ ] **Step 2: Run API client tests and verify failure**

```bash
bunx vitest --project convex --run src/convex/googleHealth/apiClient.spec.ts src/convex/googleHealth/oauth.spec.ts
```

Expected: FAIL because the API client and OAuth actions do not exist.

- [ ] **Step 3: Implement the Node API client**

Use these endpoints and form fields exactly:

```ts
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const HEALTH_BASE_URL = "https://health.googleapis.com/v4";
// code exchange: code, client_id, client_secret, redirect_uri, grant_type=authorization_code
// refresh: refresh_token, client_id, client_secret, grant_type=refresh_token
// identity: GET /users/me/identity -> { healthUserId }
// revoke: POST `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`
```

Represent Google failures as `GoogleHealthError` with safe `code`, `status`, `retryable`, and redacted `message`; never attach response bodies or tokens.

- [ ] **Step 4: Implement OAuth begin and callback actions**

`beginConnection` authenticates through `requireUserId`, allows only `/dashboard/import` as `returnPath`, generates 32 random state bytes, stores only the SHA-256 digest with a 10-minute expiry, and returns the URL.

`completeOAuth` consumes state, exchanges the code, requires a refresh token, parses granted scopes, rejects a location-only/no-identity-capable grant with a fixed safe error, calls `/users/me/identity`, encrypts the refresh token with user-bound AAD, saves the connection, and initializes scope-covered queued cursors. Task 6 wires the first cursor to the generated worker reference once that function exists; Task 5 must not hand-cast a reference to a missing function. If post-save cursor initialization fails, generation-guard the connection into a fixed `delayed` recovery state before returning an error.

- [ ] **Step 5: Register the callback HTTP route**

In `src/convex/http.ts`, register:

```ts
http.route({
  path: "/google-health/oauth/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return Response.redirect(`${env.HOMEFIT_APP_URL}/dashboard/import?googleHealth=error`, 302);
    await ctx.runAction(internal.googleHealth.oauth.completeOAuth, { code, state });
    return Response.redirect(`${env.HOMEFIT_APP_URL}/dashboard/import?googleHealth=connected`, 302);
  }),
});
```

Catch safe callback failures and redirect with a fixed error code, never the exception text. Connected and error redirects set `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

- [ ] **Step 6: Run OAuth tests and type checking**

```bash
bunx vitest --project convex --run src/convex/googleHealth/apiClient.spec.ts src/convex/googleHealth/oauth.spec.ts
bunx tsc --noEmit -p src/convex/tsconfig.json
```

Expected: PASS.

- [ ] **Step 7: Commit OAuth**

```bash
git add src/convex/googleHealth/apiClient.ts src/convex/googleHealth/apiClient.spec.ts src/convex/googleHealth/oauth.ts src/convex/googleHealth/oauth.spec.ts src/convex/http.ts
git commit -m "feat: add Google Health OAuth flow"
```

---

### Task 6: Bounded Import Engine, Idempotent Upserts, and Summaries

**Files:**
- Create: `src/convex/googleHealth/records.ts`
- Create: `src/convex/googleHealth/records.spec.ts`
- Create: `src/convex/googleHealth/sync.ts`
- Create: `src/convex/googleHealth/sync.spec.ts`
- Modify: `src/convex/googleHealth/apiClient.ts`
- Modify: `src/convex/googleHealth/oauth.ts`
- Modify: `src/convex/googleHealth/oauth.spec.ts`

**Interfaces:**
- Produces internal mutation `applyReconciledPage({ connectionId, dataType, points, syncId, nextPageToken })`.
- Produces internal action `runCursor({ cursorId, generation, trigger })`.
- Produces internal mutations `markCursorRunning`, `completeCursorPage`, `scheduleCursorRetry`, and `finishDataType`.

- [ ] **Step 1: Write failing idempotency and summary tests**

Use convex-test to seed a connection and apply the same named and unnamed pages twice. Assert no duplicate points, changed payload replaces the same `recordKey`, records absent from a fully covered reconciliation window are deleted, other users and out-of-window points remain, and affected daily summary count/sum/average/min/max/latest values are rebuilt.

- [ ] **Step 2: Write failing bounded-worker tests**

Mock one page with a continuation token and one final page. Assert OAuth completion schedules the real generated `internal.googleHealth.sync.runCursor` reference, and each `runCursor` invocation fetches only one page, commits it, and schedules exactly one continuation. Cover sleep/exercise `pageSize=25`, other list/reconcile types `pageSize=1000`, dailyRollUp starting at `2000-01-01`, 14-day windows for the two rollup-only types, and retryable 429/5xx errors.

- [ ] **Step 3: Run focused tests and verify failure**

```bash
bunx vitest --project convex --run src/convex/googleHealth/records.spec.ts src/convex/googleHealth/sync.spec.ts
```

Expected: FAIL because records and sync modules are missing.

- [ ] **Step 4: Implement Google page fetching**

For `reconcile`, call `GET /users/me/dataTypes/{dataType}/dataPoints:reconcile`; for `list`, call `GET /users/me/dataTypes/{dataType}/dataPoints`; both pass `pageToken` and capped `pageSize`. Backfill list/reconcile cursors omit a lower filter so Google returns all recorded history. Incremental requests construct a closed-open physical or civil filter from webhook intervals using the registry record kind.

For `dailyRollUp`, call `POST /users/me/dataTypes/{dataType}/dataPoints:dailyRollUp` with civil `range.start`, exclusive `range.end`, and `windowSizeDays: 1`. Walk 14-day windows from `2000-01-01` through the current civil date. Normalize `dataPoints`, `reconciledDataPoints`, and `dailyRollupDataPoints` into the same input shape.

- [ ] **Step 5: Implement transactional page application**

`applyReconciledPage` queries each key through `by_userId_and_recordKey`, inserts new records, patches changed digests, stamps every seen row with `lastSeenSyncId`, and records affected `(dataType, localDate)` pairs. After the final page for a fully covered window, schedule an indexed cleanup that pages through that user/type/time window and deletes rows whose `lastSeenSyncId` differs from the cursor `syncId`; this avoids storing an unbounded in-memory key set. Rebuild each affected summary with `.take(10001)`. If a day reaches 10,001 rows, store count/latest only and use the Google daily rollup for exact aggregate fields when that metric supports it.

- [ ] **Step 6: Implement the cursor worker**

Wire OAuth completion to the generated `internal.googleHealth.sync.runCursor` reference now that the action exists. The action loads the connection/cursor internally, rejects stale generation or inactive status, decrypts the token through `rotateRefreshTokenEnvelope`, and persists any old-key replacement through the generation-and-envelope-guarded `replaceTokenEnvelope` before refreshing the access token. If Google returns a replacement refresh token, encrypt and persist it through the same guarded envelope comparison. It then fetches one page/window, normalizes up to the page cap, applies the page, updates the run record, and schedules the next page with `ctx.scheduler.runAfter(0, internal.googleHealth.sync.runCursor, ...)`. Every connection error write carries the expected generation. On 429/5xx/network failure, compute `base = min(6 hours, 30 seconds * 2^attempt)` and schedule `floor(base * (0.8 + random() * 0.4))`; inject the random source in tests. On `invalid_grant`, set `action_required` and schedule no retry.

- [ ] **Step 7: Run import tests and type checking**

```bash
bunx vitest --project convex --run src/convex/googleHealth/records.spec.ts src/convex/googleHealth/sync.spec.ts
bunx tsc --noEmit -p src/convex/tsconfig.json
```

Expected: PASS with deterministic scheduled-function tests.

- [ ] **Step 8: Commit the import engine**

```bash
git add src/convex/googleHealth/apiClient.ts src/convex/googleHealth/records.ts src/convex/googleHealth/records.spec.ts src/convex/googleHealth/sync.ts src/convex/googleHealth/sync.spec.ts
git commit -m "feat: import Google Health history"
```

---

### Task 7: Verified Webhooks and Automatic Incremental Sync

**Files:**
- Create: `src/convex/googleHealth/webhookSignature.ts`
- Create: `src/convex/googleHealth/webhookSignature.spec.ts`
- Create: `src/convex/googleHealth/webhook.ts`
- Create: `src/convex/googleHealth/webhook.spec.ts`
- Modify: `src/convex/http.ts`

**Interfaces:**
- Produces: `verifyGoogleHealthSignature(rawBody, signatureHeader, keyset): boolean`.
- Produces internal action `verifyAndQueue({ rawBody, authorization, signature })` returning `{ kind: "verification" | "notification"; accepted: number }`.
- Produces `POST /google-health/webhook`.

- [ ] **Step 1: Write failing signature tests**

Generate an ECDSA P-256 keypair in the test, encode its public key as the Google Tink `EcdsaPublicKey` protobuf fields 3 (`x`) and 4 (`y`), wrap the DER signature with the 5-byte Tink prefix `0x01 + uint32be(keyId)`, and assert valid, changed-body, wrong-key-id, malformed-prefix, disabled-key, and missing-header cases.

- [ ] **Step 2: Write failing webhook contract tests**

Cover the authorized `{"type":"verification"}` handshake, unauthorized challenge returning 401, valid single notification, a batch up to 99, unknown `healthUserId`, unsupported data type, `UPSERT`, `DELETE`, and duplicate delivery. Assert no health payload is logged or returned.

- [ ] **Step 3: Run webhook tests and verify failure**

```bash
bunx vitest --project convex --run src/convex/googleHealth/webhookSignature.spec.ts src/convex/googleHealth/webhook.spec.ts
```

Expected: FAIL because webhook modules are absent.

- [ ] **Step 4: Implement Tink signature verification**

Fetch `https://www.gstatic.com/googlehealthapi/webhooks/webhooks_public_keyset.json`. Decode the first signature byte and four-byte key ID, select an enabled key with `type.googleapis.com/google.crypto.tink.EcdsaPublicKey`, parse length-delimited protobuf fields 3 and 4 from `keyData.value`, create a P-256 JWK (`kty: "EC"`, `crv: "P-256"`, base64url `x`/`y`), and verify the remaining DER signature against the exact UTF-8 raw body with SHA-256. Treat all parsing/fetch failures as unauthorized; do not accept an unverified fallback.

- [ ] **Step 5: Implement webhook validation and scheduling**

Compare equal-length byte buffers for the complete `Authorization` header and `env.GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION` using `timingSafeEqual`; reject unequal lengths before calling it. Parse verification only after authorization. Validate notification fields as unknown input: version string, healthUserId, supported registry dataType, operation `UPSERT|DELETE`, and one or more bounded physical/civil intervals. Query connection through `by_healthUserId`, coalesce identical intervals through cursor state, and schedule incremental workers with trigger `webhook`.

- [ ] **Step 6: Register the raw-body HTTP route**

Read `await request.text()` exactly once. Unauthorized requests, including Google's second verification challenge, return 401. Authorized verification returns 200. A verified notification schedules work and returns 204; malformed or invalid signatures return 401/400 without scheduling.

- [ ] **Step 7: Run webhook tests and type checking**

```bash
bunx vitest --project convex --run src/convex/googleHealth/webhookSignature.spec.ts src/convex/googleHealth/webhook.spec.ts
bunx tsc --noEmit -p src/convex/tsconfig.json
```

Expected: PASS.

- [ ] **Step 8: Commit webhooks**

```bash
git add src/convex/googleHealth/webhookSignature.ts src/convex/googleHealth/webhookSignature.spec.ts src/convex/googleHealth/webhook.ts src/convex/googleHealth/webhook.spec.ts src/convex/http.ts
git commit -m "feat: sync Google Health webhooks"
```

---

### Task 8: Reconciliation, Manual Sync, Disconnect, and Deletion

**Files:**
- Create: `src/convex/googleHealth/maintenance.ts`
- Create: `src/convex/googleHealth/account.ts`
- Create: `src/convex/googleHealth/account.spec.ts`
- Create: `src/convex/crons.ts`

**Interfaces:**
- Produces public `syncNow({})`, `disconnect({})`, and `deleteImportedData({ confirmation })`.
- Produces internal `scheduleDailyReconciliation({ cursor })`, `deleteGoogleDataBatch({ connectionId, generation })`, and `cleanupOperationalData({ cursor })`.

- [ ] **Step 1: Write failing account lifecycle tests**

Assert manual sync schedules one coalesced reconciliation per type; disconnect increments generation, removes the encrypted envelope, retains points/summaries, and blocks stale workers; deletion rejects any confirmation other than `DELETE GOOGLE DATA`, removes only the current user's Google rows in bounded scheduled batches, and leaves Hevy/Sleep Cycle rows untouched.

- [ ] **Step 2: Write failing maintenance tests**

Seed more active connections than one batch. Assert the daily coordinator processes 50 indexed connections and schedules a continuation; it creates a seven-day overlap reconciliation for each type. Assert successful runs older than 30 days, failed runs older than 90 days, and expired OAuth states are deleted in batches of 100.

- [ ] **Step 3: Run tests and verify failure**

```bash
bunx vitest --project convex --run src/convex/googleHealth/account.spec.ts
```

Expected: FAIL because account and maintenance functions are absent.

- [ ] **Step 4: Implement lifecycle actions**

`syncNow` requires an active/backfilling connection and coalesces existing queued work. `disconnect` decrypts the token in a Node action, best-effort POSTs to Google revoke, and always invokes an internal mutation that increments generation, clears token fields, clears retry fields, and sets `disconnected`. `deleteImportedData` validates the exact confirmation, disconnects, sets `deleting`, and schedules indexed batches in this order: points, summaries, cursors, sync runs, OAuth states, connection.

- [ ] **Step 5: Implement cron coordinators**

Create only internal cron targets:

```ts
const crons = cronJobs();
crons.daily("reconcile Google Health", { hourUTC: 3, minuteUTC: 15 },
  internal.googleHealth.maintenance.scheduleDailyReconciliation, {});
crons.daily("clean Google Health operational data", { hourUTC: 4, minuteUTC: 15 },
  internal.googleHealth.maintenance.cleanupOperationalData, {});
export default crons;
```

Both handlers use indexes, `.take(50|100)`, scheduler continuations, generation checks, and idempotent writes.

- [ ] **Step 6: Run lifecycle tests and type checking**

```bash
bunx vitest --project convex --run src/convex/googleHealth/account.spec.ts
bunx tsc --noEmit -p src/convex/tsconfig.json
```

Expected: PASS.

- [ ] **Step 7: Commit lifecycle automation**

```bash
git add src/convex/googleHealth/maintenance.ts src/convex/googleHealth/account.ts src/convex/googleHealth/account.spec.ts src/convex/crons.ts
git commit -m "feat: automate Google Health reconciliation"
```

---

### Task 9: Health Read APIs

**Files:**
- Modify: `src/convex/googleHealth/records.ts`
- Modify: `src/convex/googleHealth/records.spec.ts`

**Interfaces:**
- Produces public `getOverview({ days })`, `listCategories({})`, `listMetrics({ category })`, `getMetricTrend({ dataType, fromDate, toDate })`, and paginated `listMetricRecords({ dataType, paginationOpts })`.

- [ ] **Step 1: Write failing read-API tests**

Seed two identities, six categories, known/unknown metrics, numeric and complex records, and more than one pagination page. Assert ownership isolation, category counts, 30-day overview representative types, alphabetical metric catalog, bounded date-range trends, unknown type metadata under Other, and native Convex pagination cursors.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
bunx vitest --project convex --run src/convex/googleHealth/records.spec.ts
```

Expected: FAIL because public read functions are missing.

- [ ] **Step 3: Implement validated indexed queries**

Use `paginationOptsValidator` unchanged for record pagination and `paginationResultValidator` for its return validator. Cap `days` at 365 and date ranges at 366 days. Return metric registry metadata, summary rows, and source labels, never `payloadJson` in overview/catalog queries. Return parsed detail payload only from the owned paginated detail query after JSON validation.

- [ ] **Step 4: Run tests and type checking**

```bash
bunx vitest --project convex --run src/convex/googleHealth/records.spec.ts
bunx tsc --noEmit -p src/convex/tsconfig.json
```

Expected: PASS.

- [ ] **Step 5: Commit read APIs**

```bash
git add src/convex/googleHealth/records.ts src/convex/googleHealth/records.spec.ts
git commit -m "feat: query Google Health metrics"
```

---

### Task 10: Localization and Google Health Import Card

**Files:**
- Create: `src/lib/google-health/labels.ts`
- Create: `src/lib/components/google-health/GoogleHealthImportCard.svelte`
- Create: `src/lib/components/google-health/GoogleHealthImportCard.svelte.spec.ts`
- Modify: `src/routes/dashboard/import/+page.svelte`
- Modify: `messages/en.json`
- Modify: `messages/es.json`

**Interfaces:**
- Consumes: `api.googleHealth.model.getConnectionStatus`, `api.googleHealth.oauth.beginConnection`, and account actions.
- Produces: connection card states `not_connected`, `importing`, `active`, `delayed`, `action_required`, and `disconnected`.
- Produces: `metricLabel(dataType)` and `categoryLabel(category)` using Paraglide functions.

- [ ] **Step 1: Add exact bilingual copy and metric labels**

Add connection/action text for Connect Google Health / Conectar Google Health, Importing history / Importando historial, Sync now / Sincronizar ahora, Review access / Revisar acceso, Disconnect / Desconectar, Delete Google data / Eliminar datos de Google, last sync, progress, retained-data explanation, and typed confirmation.

Add a message key for each registry identifier using the official English title and these Spanish titles: Energía activa, Minutos activos, Minutos en zona activa, Nivel de actividad, Altitud, Glucosa en sangre, Grasa corporal, Calorías por zona de frecuencia cardíaca, Temperatura corporal central, Variabilidad diaria de la frecuencia cardíaca, Zonas diarias de frecuencia cardíaca, Saturación diaria de oxígeno, Frecuencia respiratoria diaria, Frecuencia cardíaca en reposo diaria, Variaciones diarias de temperatura durante el sueño, VO₂ máx. diario, Distancia, Electrocardiograma, Ejercicio, Pisos subidos, Alimento, Unidad de medida alimentaria, Frecuencia cardíaca, Variabilidad de la frecuencia cardíaca, Altura, Registro de hidratación, Notificación de ritmo irregular, Registro nutricional, Saturación de oxígeno, Resumen respiratorio del sueño, VO₂ máx. en carrera, Período sedentario, Sueño, Pasos, Largo de piscina, Tiempo en zona de frecuencia cardíaca, Calorías totales, VO₂ máx. and Peso.

- [ ] **Step 2: Write failing component-state tests**

Mock the Convex hooks and assert each state renders the correct badge/actions, importing progress uses type counts rather than a false record percentage, connect redirects to `authorizationUrl`, disconnect does not show destructive wording, and delete requires exact typed confirmation in an accessible `AlertDialog.Title` flow.

- [ ] **Step 3: Run component tests and verify failure**

```bash
bunx vitest --project client --run src/lib/components/google-health/GoogleHealthImportCard.svelte.spec.ts
```

Expected: FAIL because the component does not exist.

- [ ] **Step 4: Implement the import card with installed shadcn components**

Compose `Card`, `Badge`, `Progress`, `Alert`, `Button`, `Spinner`, and `AlertDialog`. Use reactive Convex status, action pending state, `toast` feedback, and semantic classes only. Place Google Health first in the import grid and update the page description to mention automatic connections and CSV files.

- [ ] **Step 5: Autofix and test Svelte**

Run the Svelte autofixer repeatedly until it reports no issues when the Svelte MCP is available. Then run:

```bash
bunx vitest --project client --run src/lib/components/google-health/GoogleHealthImportCard.svelte.spec.ts
bun run check
```

Expected: PASS with no Svelte diagnostics.

- [ ] **Step 6: Commit the connection UI**

```bash
git add messages/en.json messages/es.json src/lib/google-health/labels.ts src/lib/components/google-health/GoogleHealthImportCard.svelte src/lib/components/google-health/GoogleHealthImportCard.svelte.spec.ts src/routes/dashboard/import/+page.svelte
git commit -m "feat: add Google Health connection UI"
```

---

### Task 11: Approved Category Dashboard and Metric Detail Views

**Files:**
- Create: `src/lib/components/google-health/HealthMetricCard.svelte`
- Create: `src/lib/components/google-health/HealthMetricCard.svelte.spec.ts`
- Create: `src/lib/components/google-health/HealthTrendChart.svelte`
- Create: `src/lib/components/google-health/HealthSyncBanner.svelte`
- Modify: `src/routes/dashboard/+layout.svelte`
- Create: `src/routes/dashboard/health/+page.svelte`
- Create: `src/routes/dashboard/health/[category]/+page.svelte`
- Create: `src/routes/dashboard/health/metrics/+page.svelte`
- Create: `src/routes/dashboard/health/metrics/[dataType]/+page.svelte`

**Interfaces:**
- Consumes all Task 9 read APIs and Task 10 localization helpers.
- Produces the approved Health overview, non-empty category navigation, all-metrics catalog, and metric detail route.

- [ ] **Step 1: Write failing card and route-state tests**

Test numeric/unit formatting, “Recorded” for complex types, source labels, trend deltas, loading skeletons, empty state linking to Import, importing banner, delayed/action-required alerts, unknown types under Other, and invalid category/dataType returning an in-app empty/not-found state rather than throwing.

- [ ] **Step 2: Run tests and verify failure**

```bash
bunx vitest --project client --run src/lib/components/google-health/HealthMetricCard.svelte.spec.ts
```

Expected: FAIL because health components are absent.

- [ ] **Step 3: Implement health navigation and overview**

Add a `HeartPulse` Health item to the main sidebar. Under it, render sub-links only for categories returned by `listCategories`, plus All metrics. Use `Sidebar.MenuSub`, `Sidebar.MenuSubItem`, and `Sidebar.MenuSubButton`; preserve the existing Overview, Exercises, and Import items.

The overview uses `HealthSyncBanner`, four available representative metrics in priority order (`steps`, `sleep`, `daily-resting-heart-rate`, `weight`, then other available types), a 30-day generic trend, recent activity/exercise, and category cards. Use Card/Empty/Skeleton/Badge and existing chart conventions.

- [ ] **Step 4: Implement category and all-metrics pages**

Validate route parameters against the six category literals and registry identifiers. Category pages query `listMetrics({ category })`; All metrics queries with `category: null`. Render responsive `HealthMetricCard` grids sorted by localized label and link each card to the encoded detail route.

- [ ] **Step 5: Implement metric detail with paginated records**

Render title/category/source, latest value, applicable summary statistics, 7/30/90/365-day controls using `ToggleGroup`, a `HealthTrendChart` for scalar/duration series, and a `Table` of records loaded with Convex pagination. Parse and display complex payload fields as a safe definition list; never inject payload HTML.

- [ ] **Step 6: Autofix and verify all Svelte changes**

Run the Svelte autofixer on each changed/new Svelte file until clean when available. Then run:

```bash
bunx vitest --project client --run src/lib/components/google-health/HealthMetricCard.svelte.spec.ts
bun run check
bun run build
```

Expected: all commands pass.

- [ ] **Step 7: Commit the dashboard**

```bash
git add src/lib/components/google-health src/routes/dashboard/+layout.svelte src/routes/dashboard/health
git commit -m "feat: display Google Health metrics"
```

---

### Task 12: Environment Template and Google Cloud Subscriber Setup

**Files:**
- Create: `.env.example`
- Create: `docs/google-health-setup.md`
- Modify without printing values: `.env`

**Interfaces:**
- Documents the exact redirect URI and webhook endpoint required by Tasks 5 and 7.
- Configures one project-level subscriber with automatic policies for all webhook-capable registry types.

- [ ] **Step 1: Add the safe environment template**

Create `.env.example` with empty values only:

```dotenv
PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
PUBLIC_CONVEX_URL=
PUBLIC_CONVEX_SITE_URL=
GOOGLE_HEALTH_CLIENT_ID=
GOOGLE_HEALTH_CLIENT_SECRET=
GOOGLE_HEALTH_REDIRECT_URI=
HOMEFIT_APP_URL=
GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY=
GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY_VERSION=v1
GOOGLE_HEALTH_TOKEN_PREVIOUS_KEYS={}
GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION=
GOOGLE_HEALTH_PROJECT_NUMBER=
GOOGLE_HEALTH_SUBSCRIBER_ID=homefit-health
```

- [ ] **Step 2: Rename ignored local variables without exposing values**

Use a non-printing mechanical rewrite to rename `CLIENT_ID` to `GOOGLE_HEALTH_CLIENT_ID` and `CLIENT_SECRET` to `GOOGLE_HEALTH_CLIENT_SECRET` in `.env`. Do not copy `CREDENTIALS` into source control. Confirm names only with `sed -E 's/=.*/=REDACTED/' .env`.

- [ ] **Step 3: Write the deployment/setup guide**

Document these exact values and actions:

1. Authorized redirect URI: `${PUBLIC_CONVEX_SITE_URL}/google-health/oauth/callback`.
2. Webhook endpoint: `${PUBLIC_CONVEX_SITE_URL}/google-health/webhook`.
3. Add the seven read-only scopes and test-user emails in Google Cloud.
4. Generate a 32-byte encryption key and an independent high-entropy webhook `Authorization` value.
5. Set the eight runtime Convex values from Task 4 after deployment classification; the previous-key map starts as `{}`.
6. Create/update a subscriber using the **project number**, not project ID.
7. Use one `AUTOMATIC` subscriber config containing exactly: `active-zone-minutes`, `activity-level`, `altitude`, `blood-glucose`, `body-fat`, `calories-in-heart-rate-zone`, `daily-heart-rate-variability`, `daily-heart-rate-zones`, `daily-oxygen-saturation`, `daily-respiratory-rate`, `daily-resting-heart-rate`, `daily-sleep-temperature-derivations`, `distance`, `exercise`, `floors`, `heart-rate`, `heart-rate-variability`, `height`, `hydration-log`, `nutrition-log`, `respiratory-rate-sleep-summary`, `run-vo2-max`, `sedentary-period`, `sleep`, `steps`, `time-in-heart-rate-zone`, and `weight`.
8. Confirm the authorized verification request returns 200 and Google's unauthenticated challenge returns 401.
9. Explain the 100-user/unverified limit and production security-review requirement.

Include this subscriber request shape, substituting values only at execution time:

```json
{
  "endpointUri": "${PUBLIC_CONVEX_SITE_URL}/google-health/webhook",
  "subscriberConfigs": [{
    "dataTypes": [
      "active-zone-minutes", "activity-level", "altitude", "blood-glucose", "body-fat",
      "calories-in-heart-rate-zone", "daily-heart-rate-variability", "daily-heart-rate-zones",
      "daily-oxygen-saturation", "daily-respiratory-rate", "daily-resting-heart-rate",
      "daily-sleep-temperature-derivations", "distance", "exercise", "floors", "heart-rate",
      "heart-rate-variability", "height", "hydration-log", "nutrition-log",
      "respiratory-rate-sleep-summary", "run-vo2-max", "sedentary-period", "sleep", "steps",
      "time-in-heart-rate-zone", "weight"
    ],
    "subscriptionCreatePolicy": "AUTOMATIC"
  }],
  "endpointAuthorization": { "secret": "${GOOGLE_HEALTH_WEBHOOK_AUTHORIZATION}" }
}
```

- [ ] **Step 4: Validate documentation contains no secret values**

```bash
rg -n "CLIENT_SECRET=.+|ENCRYPTION_KEY=.+|AUTHORIZATION=.+" .env.example docs/google-health-setup.md
```

Expected: no matches containing non-empty secret assignments.

- [ ] **Step 5: Commit safe configuration docs**

```bash
git add .env.example docs/google-health-setup.md
git commit -m "docs: add Google Health setup guide"
```

---

### Task 13: Full Verification and Live Test-User Certification

**Files:**
- Modify only when failures require scoped fixes: files from Tasks 1–12

**Interfaces:**
- Certifies the complete feature against tests, type systems, build output, Convex validation, Google OAuth, and webhook delivery.

- [ ] **Step 1: Run all deterministic tests**

```bash
bun run test:unit -- --run
```

Expected: all server and browser projects pass.

- [ ] **Step 2: Run static validation**

```bash
bun run check
bun run lint
bun run build
bunx tsc --noEmit -p src/convex/tsconfig.json
```

Expected: every command exits 0. If Prettier reports only files changed by this feature, run `bunx prettier --write` on those exact files and repeat.

- [ ] **Step 3: Classify the Convex target and push validation once**

Invoke the Convex deployment guard. For an approved development target, run:

```bash
CONVEX_AGENT_MODE=anonymous bunx convex dev --once
```

If the existing configured target is used instead of an anonymous development target, follow the guard's exact consent requirements. Expected: schema, functions, HTTP routes, and crons validate cleanly.

- [ ] **Step 4: Set deployment secrets without logging them**

After target classification, set the required Convex environment variables from the ignored local environment or a secure prompt. Never place values on a command line that will be echoed into logs; verify names with `bunx convex env list` and redact values from any captured output.

- [ ] **Step 5: Configure the project subscriber**

Use a Google Cloud principal with Google Health API Editor/Admin on the documented project number. Create or patch `homefit-health` to the public Convex webhook URL with the exact automatic data-type list and authorization header. Confirm the two-step endpoint handshake succeeds.

- [ ] **Step 6: Exercise OAuth with a configured Google test user**

Connect from `/dashboard/import`, confirm Google shows only the seven read-only scopes, return through the Convex callback, and observe `backfilling`. Verify all scope-covered registry types reach complete/empty status and populated types appear in category and All metrics views.

- [ ] **Step 7: Certify automatic updates and retention**

Trigger or wait for a supported health update, verify the signed webhook schedules an incremental reconciliation and the UI updates without duplication. Run Sync now twice and confirm idempotency. Disconnect and confirm data remains. Reconnect and confirm no duplicates. Use a disposable test user for the typed deletion flow and confirm only Google-imported data is removed.

- [ ] **Step 8: Review secret exposure and final diff**

```bash
git status --short
git diff --check
git grep -nE "GOOGLE_HEALTH_CLIENT_SECRET=.+|GOOGLE_HEALTH_TOKEN_ENCRYPTION_KEY=.+|refresh_token"
```

Expected: no secret assignment or token value is committed; legitimate source references to the OAuth response field `refresh_token` are reviewed and contain no credential value.

- [ ] **Step 9: Commit certification fixes if needed**

If verification required code changes, commit only those scoped fixes:

```bash
git add src/convex/googleHealth src/convex/schema.ts src/convex/http.ts src/convex/crons.ts src/convex/convex.config.ts src/lib/components/google-health src/lib/google-health src/routes/dashboard/+layout.svelte src/routes/dashboard/import/+page.svelte src/routes/dashboard/health messages/en.json messages/es.json .env.example docs/google-health-setup.md package.json bun.lock
git diff --cached --check
git commit -m "fix: certify Google Health integration"
```

If no fixes were required, do not create an empty commit.
