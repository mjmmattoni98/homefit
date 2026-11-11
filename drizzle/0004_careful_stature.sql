CREATE TABLE "csv_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"time_zone" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signup_gate" (
	"id" integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "csv_settings" ADD CONSTRAINT "csv_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;