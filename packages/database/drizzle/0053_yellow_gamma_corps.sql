CREATE TABLE "subversive_calendar_events" (
	"id" text PRIMARY KEY NOT NULL,
	"faction_id" integer DEFAULT 2013 NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"color" text,
	"is_all_day" boolean DEFAULT false NOT NULL,
	"created_by_id" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_subversive_calendar_events_faction" ON "subversive_calendar_events" USING btree ("faction_id");--> statement-breakpoint
CREATE INDEX "idx_subversive_calendar_events_start" ON "subversive_calendar_events" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "idx_subversive_calendar_events_end" ON "subversive_calendar_events" USING btree ("end_time");