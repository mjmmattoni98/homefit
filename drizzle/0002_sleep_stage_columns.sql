ALTER TABLE "health_data_point" ADD COLUMN "sleep_in_bed_seconds" double precision;--> statement-breakpoint
ALTER TABLE "health_data_point" ADD COLUMN "sleep_awake_seconds" double precision;--> statement-breakpoint
ALTER TABLE "health_data_point" ADD COLUMN "sleep_deep_seconds" double precision;--> statement-breakpoint
ALTER TABLE "health_data_point" ADD COLUMN "sleep_light_seconds" double precision;--> statement-breakpoint
ALTER TABLE "health_data_point" ADD COLUMN "sleep_rem_seconds" double precision;--> statement-breakpoint
ALTER TABLE "health_data_point" ADD COLUMN "sleep_durations_parsed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "health_data_point_unparsed_sleep_idx" ON "health_data_point" USING btree ("id") WHERE "health_data_point"."data_type" = 'sleep' and "health_data_point"."sleep_durations_parsed" = false;