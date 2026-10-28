ALTER TABLE "google_health_oauth_state" ADD COLUMN "expected_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "google_health_oauth_state" ADD COLUMN "consumed_at" timestamp with time zone;