CREATE TABLE "daily_goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"sort_order" integer NOT NULL,
	"archived_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_goal_unit_check" CHECK ("daily_goal"."unit" in ('minutes', 'reps', 'seconds'))
);
--> statement-breakpoint
CREATE TABLE "daily_goal_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goal_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"day" date NOT NULL,
	"amount" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "daily_goal_entry_amount_range" CHECK ("daily_goal_entry"."amount" between 1 and 10000)
);
--> statement-breakpoint
CREATE TABLE "daily_goal_schedule" (
	"user_id" text NOT NULL,
	"effective_from" date NOT NULL,
	"weekdays" smallint NOT NULL,
	CONSTRAINT "daily_goal_schedule_user_id_effective_from_pk" PRIMARY KEY("user_id","effective_from"),
	CONSTRAINT "daily_goal_schedule_weekdays" CHECK ("daily_goal_schedule"."weekdays" between 1 and 127)
);
--> statement-breakpoint
CREATE TABLE "daily_goal_target" (
	"goal_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"target" integer NOT NULL,
	CONSTRAINT "daily_goal_target_goal_id_effective_from_pk" PRIMARY KEY("goal_id","effective_from"),
	CONSTRAINT "daily_goal_target_range" CHECK ("daily_goal_target"."target" between 1 and 10000)
);
--> statement-breakpoint
ALTER TABLE "daily_goal" ADD CONSTRAINT "daily_goal_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_goal_entry" ADD CONSTRAINT "daily_goal_entry_goal_id_daily_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."daily_goal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_goal_entry" ADD CONSTRAINT "daily_goal_entry_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_goal_schedule" ADD CONSTRAINT "daily_goal_schedule_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_goal_target" ADD CONSTRAINT "daily_goal_target_goal_id_daily_goal_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."daily_goal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_goal_user_order_idx" ON "daily_goal" USING btree ("user_id","sort_order");--> statement-breakpoint
CREATE INDEX "daily_goal_entry_user_day_idx" ON "daily_goal_entry" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "daily_goal_entry_goal_day_created_idx" ON "daily_goal_entry" USING btree ("goal_id","day","created_at");