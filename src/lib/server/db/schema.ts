import { sql } from 'drizzle-orm';
import {
	boolean,
	date,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type {
	ConnectionStatus,
	CursorStatus,
	DeliveryStatus,
	HealthCategory,
	SyncMode,
	SyncRunStatus,
	SyncTrigger
} from '../google-health/types';
import { user } from './auth.schema';

export * from './auth.schema';

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const ownerId = () =>
	text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' });

// ---------------------------------------------------------------------------
// CSV imports
// ---------------------------------------------------------------------------

export const sleepRecord = pgTable(
	'sleep_record',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: ownerId(),
		wentToBed: instant('went_to_bed').notNull(),
		wokeUp: instant('woke_up').notNull(),
		sleepQuality: doublePrecision('sleep_quality').notNull(),
		timeInBedSeconds: doublePrecision('time_in_bed_seconds').notNull(),
		timeAsleepSeconds: doublePrecision('time_asleep_seconds').notNull(),
		asleepAfterSeconds: doublePrecision('asleep_after_seconds').notNull(),
		regularity: doublePrecision('regularity'),
		didSnore: boolean('did_snore').notNull(),
		snoreTimeSeconds: doublePrecision('snore_time_seconds').notNull(),
		steps: doublePrecision('steps'),
		weatherTempC: doublePrecision('weather_temp_c'),
		weatherType: text('weather_type'),
		city: text('city'),
		movementsPerHour: doublePrecision('movements_per_hour'),
		notes: text('notes')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		mood: text('mood'),
		createdAt: instant('created_at').notNull().defaultNow()
	},
	// A Sleep Cycle export can be imported repeatedly; the wake-up time identifies a night.
	(table) => [uniqueIndex('sleep_record_user_woke_up_idx').on(table.userId, table.wokeUp)]
);

export const workout = pgTable(
	'workout',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: ownerId(),
		title: text('title').notNull(),
		startTime: instant('start_time').notNull(),
		endTime: instant('end_time').notNull(),
		description: text('description'),
		createdAt: instant('created_at').notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('workout_user_start_title_idx').on(table.userId, table.startTime, table.title)
	]
);

export const workoutSet = pgTable(
	'workout_set',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		workoutId: uuid('workout_id')
			.notNull()
			.references(() => workout.id, { onDelete: 'cascade' }),
		userId: ownerId(),
		// Denormalized from the parent workout so exercise history can be ordered by session date.
		startTime: instant('start_time').notNull(),
		exerciseTitle: text('exercise_title').notNull(),
		setIndex: integer('set_index').notNull(),
		setType: text('set_type').notNull(),
		weightKg: doublePrecision('weight_kg'),
		reps: doublePrecision('reps'),
		distanceKm: doublePrecision('distance_km'),
		durationSeconds: doublePrecision('duration_seconds'),
		rpe: doublePrecision('rpe'),
		supersetId: text('superset_id'),
		exerciseNotes: text('exercise_notes')
	},
	(table) => [
		index('workout_set_workout_idx').on(table.workoutId),
		index('workout_set_user_exercise_start_idx').on(
			table.userId,
			table.exerciseTitle,
			table.startTime
		)
	]
);

// ---------------------------------------------------------------------------
// Google Health (optional integration)
// ---------------------------------------------------------------------------

export const googleHealthOAuthState = pgTable(
	'google_health_oauth_state',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: ownerId(),
		stateDigest: text('state_digest').notNull().unique(),
		returnPath: text('return_path').notNull(),
		// The user's connection and its generation when authorization began, or null when none
		// existed. The callback is rejected if the connection lifecycle changed in the meantime; the
		// id matters because generations restart when a deleted connection is replaced.
		expectedConnectionId: uuid('expected_connection_id'),
		expectedGeneration: integer('expected_generation'),
		// Set when a callback claims the state. The row is kept until that callback saves the
		// connection, so deleting the connection meanwhile (which removes the user's states)
		// cancels it.
		consumedAt: instant('consumed_at'),
		expiresAt: instant('expires_at').notNull(),
		createdAt: instant('created_at').notNull().defaultNow()
	},
	(table) => [index('google_health_oauth_state_expires_idx').on(table.expiresAt)]
);

export const googleHealthConnection = pgTable(
	'google_health_connection',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: ownerId().unique(),
		healthUserId: text('health_user_id'),
		status: text('status').$type<ConnectionStatus>().notNull(),
		encryptedRefreshToken: text('encrypted_refresh_token'),
		tokenNonce: text('token_nonce'),
		tokenTag: text('token_tag'),
		tokenKeyVersion: text('token_key_version'),
		grantedScopes: text('granted_scopes')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		// Incremented by every reconnect, disconnect and deletion so stale work can detect it.
		generation: integer('generation').notNull().default(1),
		// Incremented for every reconciliation pass; imported points remember the pass that saw them.
		reconciliationEpoch: integer('reconciliation_epoch').notNull().default(0),
		backfillTotalTypes: integer('backfill_total_types').notNull().default(0),
		backfillCompletedTypes: integer('backfill_completed_types').notNull().default(0),
		lastAttemptAt: instant('last_attempt_at'),
		lastSuccessfulSyncAt: instant('last_successful_sync_at'),
		lastErrorCode: text('last_error_code'),
		lastErrorMessage: text('last_error_message'),
		nextRetryAt: instant('next_retry_at'),
		disconnectedAt: instant('disconnected_at'),
		createdAt: instant('created_at').notNull().defaultNow(),
		updatedAt: instant('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		index('google_health_connection_health_user_idx').on(table.healthUserId),
		index('google_health_connection_status_idx').on(table.status)
	]
);

const connectionId = () =>
	uuid('connection_id')
		.notNull()
		.references(() => googleHealthConnection.id, { onDelete: 'cascade' });

export const googleHealthSyncCursor = pgTable(
	'google_health_sync_cursor',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		connectionId: connectionId(),
		dataType: text('data_type').notNull(),
		mode: text('mode').$type<SyncMode>().notNull(),
		status: text('status').$type<CursorStatus>().notNull(),
		generation: integer('generation').notNull(),
		trigger: text('trigger').$type<SyncTrigger>().notNull(),
		pageToken: text('page_token'),
		windowStart: text('window_start'),
		windowEnd: text('window_end'),
		// Work requested while the cursor was mid-unit; promoted when the current unit finishes.
		pendingWindowStart: text('pending_window_start'),
		pendingWindowEnd: text('pending_window_end'),
		pendingUnbounded: boolean('pending_unbounded').notNull().default(false),
		pendingTrigger: text('pending_trigger').$type<SyncTrigger>(),
		// Reconciliation pass of the unit currently in progress (set while paging).
		activeEpoch: integer('active_epoch'),
		hadMalformed: boolean('had_malformed').notNull().default(false),
		attempt: integer('attempt').notNull().default(0),
		nextAttemptAt: instant('next_attempt_at'),
		// Ownership token of the worker currently processing the cursor.
		claimId: uuid('claim_id'),
		claimExpiresAt: instant('claim_expires_at'),
		updatedAt: instant('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		uniqueIndex('google_health_sync_cursor_unique_idx').on(
			table.connectionId,
			table.dataType,
			table.mode
		),
		index('google_health_sync_cursor_status_idx').on(table.status, table.nextAttemptAt)
	]
);

export const googleHealthSyncRun = pgTable(
	'google_health_sync_run',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		connectionId: connectionId(),
		dataType: text('data_type').notNull(),
		mode: text('mode').$type<SyncMode>().notNull(),
		trigger: text('trigger').$type<SyncTrigger>().notNull(),
		rangeStart: text('range_start'),
		rangeEnd: text('range_end'),
		status: text('status').$type<SyncRunStatus>().notNull(),
		pages: integer('pages').notNull().default(0),
		fetched: integer('fetched').notNull().default(0),
		inserted: integer('inserted').notNull().default(0),
		updated: integer('updated').notNull().default(0),
		deleted: integer('deleted').notNull().default(0),
		skipped: integer('skipped').notNull().default(0),
		errorCode: text('error_code'),
		errorMessage: text('error_message'),
		startedAt: instant('started_at').notNull().defaultNow(),
		finishedAt: instant('finished_at')
	},
	(table) => [
		index('google_health_sync_run_connection_idx').on(table.connectionId, table.startedAt),
		index('google_health_sync_run_status_idx').on(table.status, table.startedAt)
	]
);

export const googleHealthWebhookDelivery = pgTable(
	'google_health_webhook_delivery',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		deliveryDigest: text('delivery_digest').notNull().unique(),
		status: text('status').$type<DeliveryStatus>().notNull(),
		// Raw request is kept only until its signature is verified and the batch is applied.
		rawBody: text('raw_body'),
		signature: text('signature'),
		attempt: integer('attempt').notNull().default(0),
		lastErrorCode: text('last_error_code'),
		acceptedAt: instant('accepted_at').notNull().defaultNow(),
		updatedAt: instant('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [index('google_health_webhook_delivery_status_idx').on(table.status, table.updatedAt)]
);

export const googleHealthRecordTombstone = pgTable(
	'google_health_record_tombstone',
	{
		connectionId: connectionId(),
		generation: integer('generation').notNull(),
		recordKey: text('record_key').notNull(),
		dataType: text('data_type').notNull(),
		// A reconciliation pass at or below this epoch may not re-import the deleted record.
		blockedThroughEpoch: integer('blocked_through_epoch').notNull(),
		updatedAt: instant('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date())
	},
	(table) => [
		primaryKey({ columns: [table.connectionId, table.generation, table.recordKey] }),
		index('google_health_record_tombstone_updated_idx').on(table.updatedAt)
	]
);

export const healthDataPoint = pgTable(
	'health_data_point',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		connectionId: connectionId(),
		userId: ownerId(),
		provider: text('provider').$type<'google_health'>().notNull(),
		// Deterministic idempotency key derived from the Google record identity.
		recordKey: text('record_key').notNull(),
		googleDataPointName: text('google_data_point_name'),
		dataType: text('data_type').notNull(),
		category: text('category').$type<HealthCategory>().notNull(),
		recordTimestamp: instant('record_timestamp').notNull(),
		startTime: instant('start_time'),
		endTime: instant('end_time'),
		localDate: date('local_date', { mode: 'string' }).notNull(),
		// Nanosecond-precision sortable keys used to scope reconciliation cleanup windows.
		physicalCoverageKey: text('physical_coverage_key'),
		civilCoverageTime: text('civil_coverage_time'),
		primaryValue: doublePrecision('primary_value'),
		primaryUnit: text('primary_unit'),
		sourcePlatform: text('source_platform'),
		sourceApplication: text('source_application'),
		sourceDevice: text('source_device'),
		recordingMethod: text('recording_method'),
		sourceFamily: text('source_family'),
		googleCreateTime: instant('google_create_time'),
		googleUpdateTime: instant('google_update_time'),
		payloadDigest: text('payload_digest').notNull(),
		payload: jsonb('payload').notNull(),
		seenEpoch: integer('seen_epoch').notNull().default(0),
		lastSeenSyncId: text('last_seen_sync_id').notNull()
	},
	(table) => [
		uniqueIndex('health_data_point_user_record_key_idx').on(table.userId, table.recordKey),
		index('health_data_point_user_type_timestamp_idx').on(
			table.userId,
			table.dataType,
			table.recordTimestamp
		),
		index('health_data_point_user_type_date_idx').on(table.userId, table.dataType, table.localDate),
		index('health_data_point_connection_type_physical_idx').on(
			table.connectionId,
			table.dataType,
			table.physicalCoverageKey
		),
		index('health_data_point_connection_type_civil_idx').on(
			table.connectionId,
			table.dataType,
			table.civilCoverageTime
		)
	]
);

export const healthDailySummary = pgTable(
	'health_daily_summary',
	{
		userId: ownerId(),
		dataType: text('data_type').notNull(),
		localDate: date('local_date', { mode: 'string' }).notNull(),
		connectionId: connectionId(),
		category: text('category').$type<HealthCategory>().notNull(),
		count: integer('count').notNull(),
		latestValue: doublePrecision('latest_value'),
		latestTimestamp: instant('latest_timestamp'),
		sum: doublePrecision('sum'),
		average: doublePrecision('average'),
		min: doublePrecision('min'),
		max: doublePrecision('max'),
		durationSeconds: doublePrecision('duration_seconds'),
		computedAt: instant('computed_at').notNull().defaultNow()
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.dataType, table.localDate] }),
		index('health_daily_summary_connection_idx').on(table.connectionId)
	]
);
