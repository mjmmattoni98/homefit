CREATE TABLE "google_health_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"health_user_id" text,
	"status" text NOT NULL,
	"encrypted_refresh_token" text,
	"token_nonce" text,
	"token_tag" text,
	"token_key_version" text,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"reconciliation_epoch" integer DEFAULT 0 NOT NULL,
	"backfill_total_types" integer DEFAULT 0 NOT NULL,
	"backfill_completed_types" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_successful_sync_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"next_retry_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_health_connection_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "google_health_oauth_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"state_digest" text NOT NULL,
	"return_path" text NOT NULL,
	"expected_generation" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_health_oauth_state_state_digest_unique" UNIQUE("state_digest")
);
--> statement-breakpoint
CREATE TABLE "google_health_record_tombstone" (
	"connection_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"record_key" text NOT NULL,
	"data_type" text NOT NULL,
	"blocked_through_epoch" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_health_record_tombstone_connection_id_generation_record_key_pk" PRIMARY KEY("connection_id","generation","record_key")
);
--> statement-breakpoint
CREATE TABLE "google_health_sync_cursor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"data_type" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"generation" integer NOT NULL,
	"trigger" text NOT NULL,
	"page_token" text,
	"window_start" text,
	"window_end" text,
	"pending_window_start" text,
	"pending_window_end" text,
	"pending_unbounded" boolean DEFAULT false NOT NULL,
	"pending_trigger" text,
	"active_epoch" integer,
	"had_malformed" boolean DEFAULT false NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"claim_id" uuid,
	"claim_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_health_sync_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"data_type" text NOT NULL,
	"mode" text NOT NULL,
	"trigger" text NOT NULL,
	"range_start" text,
	"range_end" text,
	"status" text NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"fetched" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"deleted" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "google_health_webhook_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_digest" text NOT NULL,
	"status" text NOT NULL,
	"raw_body" text,
	"signature" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_health_webhook_delivery_delivery_digest_unique" UNIQUE("delivery_digest")
);
--> statement-breakpoint
CREATE TABLE "health_daily_summary" (
	"user_id" text NOT NULL,
	"data_type" text NOT NULL,
	"local_date" date NOT NULL,
	"connection_id" uuid NOT NULL,
	"category" text NOT NULL,
	"count" integer NOT NULL,
	"latest_value" double precision,
	"latest_timestamp" timestamp with time zone,
	"sum" double precision,
	"average" double precision,
	"min" double precision,
	"max" double precision,
	"duration_seconds" double precision,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "health_daily_summary_user_id_data_type_local_date_pk" PRIMARY KEY("user_id","data_type","local_date")
);
--> statement-breakpoint
CREATE TABLE "health_data_point" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"record_key" text NOT NULL,
	"google_data_point_name" text,
	"data_type" text NOT NULL,
	"category" text NOT NULL,
	"record_timestamp" timestamp with time zone NOT NULL,
	"start_time" timestamp with time zone,
	"end_time" timestamp with time zone,
	"local_date" date NOT NULL,
	"physical_coverage_key" text,
	"civil_coverage_time" text,
	"primary_value" double precision,
	"primary_unit" text,
	"source_platform" text,
	"source_application" text,
	"source_device" text,
	"recording_method" text,
	"source_family" text,
	"google_create_time" timestamp with time zone,
	"google_update_time" timestamp with time zone,
	"payload_digest" text NOT NULL,
	"payload" jsonb NOT NULL,
	"seen_epoch" integer DEFAULT 0 NOT NULL,
	"last_seen_sync_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sleep_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"went_to_bed" timestamp with time zone NOT NULL,
	"woke_up" timestamp with time zone NOT NULL,
	"sleep_quality" double precision NOT NULL,
	"time_in_bed_seconds" double precision NOT NULL,
	"time_asleep_seconds" double precision NOT NULL,
	"asleep_after_seconds" double precision NOT NULL,
	"regularity" double precision,
	"did_snore" boolean NOT NULL,
	"snore_time_seconds" double precision NOT NULL,
	"steps" double precision,
	"weather_temp_c" double precision,
	"weather_type" text,
	"city" text,
	"movements_per_hour" double precision,
	"notes" text[] DEFAULT '{}'::text[] NOT NULL,
	"mood" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workout_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workout_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"exercise_title" text NOT NULL,
	"set_index" integer NOT NULL,
	"set_type" text NOT NULL,
	"weight_kg" double precision,
	"reps" double precision,
	"distance_km" double precision,
	"duration_seconds" double precision,
	"rpe" double precision,
	"superset_id" text,
	"exercise_notes" text
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_health_connection" ADD CONSTRAINT "google_health_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_health_oauth_state" ADD CONSTRAINT "google_health_oauth_state_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_health_record_tombstone" ADD CONSTRAINT "google_health_record_tombstone_connection_id_google_health_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_health_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_health_sync_cursor" ADD CONSTRAINT "google_health_sync_cursor_connection_id_google_health_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_health_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_health_sync_run" ADD CONSTRAINT "google_health_sync_run_connection_id_google_health_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_health_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_daily_summary" ADD CONSTRAINT "health_daily_summary_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_daily_summary" ADD CONSTRAINT "health_daily_summary_connection_id_google_health_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_health_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_data_point" ADD CONSTRAINT "health_data_point_connection_id_google_health_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_health_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_data_point" ADD CONSTRAINT "health_data_point_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sleep_record" ADD CONSTRAINT "sleep_record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout" ADD CONSTRAINT "workout_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_set" ADD CONSTRAINT "workout_set_workout_id_workout_id_fk" FOREIGN KEY ("workout_id") REFERENCES "public"."workout"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout_set" ADD CONSTRAINT "workout_set_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "google_health_connection_health_user_idx" ON "google_health_connection" USING btree ("health_user_id");--> statement-breakpoint
CREATE INDEX "google_health_connection_status_idx" ON "google_health_connection" USING btree ("status");--> statement-breakpoint
CREATE INDEX "google_health_oauth_state_expires_idx" ON "google_health_oauth_state" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "google_health_record_tombstone_updated_idx" ON "google_health_record_tombstone" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "google_health_sync_cursor_unique_idx" ON "google_health_sync_cursor" USING btree ("connection_id","data_type","mode");--> statement-breakpoint
CREATE INDEX "google_health_sync_cursor_status_idx" ON "google_health_sync_cursor" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "google_health_sync_run_connection_idx" ON "google_health_sync_run" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE INDEX "google_health_sync_run_status_idx" ON "google_health_sync_run" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "google_health_webhook_delivery_status_idx" ON "google_health_webhook_delivery" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "health_daily_summary_connection_idx" ON "health_daily_summary" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "health_data_point_user_record_key_idx" ON "health_data_point" USING btree ("user_id","record_key");--> statement-breakpoint
CREATE INDEX "health_data_point_user_type_timestamp_idx" ON "health_data_point" USING btree ("user_id","data_type","record_timestamp");--> statement-breakpoint
CREATE INDEX "health_data_point_user_type_date_idx" ON "health_data_point" USING btree ("user_id","data_type","local_date");--> statement-breakpoint
CREATE INDEX "health_data_point_connection_type_physical_idx" ON "health_data_point" USING btree ("connection_id","data_type","physical_coverage_key");--> statement-breakpoint
CREATE INDEX "health_data_point_connection_type_civil_idx" ON "health_data_point" USING btree ("connection_id","data_type","civil_coverage_time");--> statement-breakpoint
CREATE UNIQUE INDEX "sleep_record_user_woke_up_idx" ON "sleep_record" USING btree ("user_id","woke_up");--> statement-breakpoint
CREATE UNIQUE INDEX "workout_user_start_title_idx" ON "workout" USING btree ("user_id","start_time","title");--> statement-breakpoint
CREATE INDEX "workout_set_workout_idx" ON "workout_set" USING btree ("workout_id");--> statement-breakpoint
CREATE INDEX "workout_set_user_exercise_start_idx" ON "workout_set" USING btree ("user_id","exercise_title","start_time");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");