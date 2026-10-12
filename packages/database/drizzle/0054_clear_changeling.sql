CREATE TABLE "torn_calendar_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"start" integer NOT NULL,
	"end" integer NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"fixed_start_time" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_torn_calendar_activities_type" ON "torn_calendar_activities" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_torn_calendar_activities_start" ON "torn_calendar_activities" USING btree ("start");--> statement-breakpoint
CREATE INDEX "idx_torn_calendar_activities_end" ON "torn_calendar_activities" USING btree ("end");