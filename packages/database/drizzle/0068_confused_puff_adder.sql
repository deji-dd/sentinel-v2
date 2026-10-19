CREATE TABLE "subversive_chain_configs" (
	"faction_id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"channel_id" text,
	"warning_role_id" text,
	"minimum_chain_start" integer DEFAULT 10 NOT NULL,
	"chain_time_warning_seconds" integer DEFAULT 60 NOT NULL,
	"subsequent_warning_interval_seconds" integer DEFAULT 10 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
