CREATE TABLE "elims_member_stats" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"discord_id" text NOT NULL,
	"discord_username" text,
	"discord_nickname" text,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"torn_id" integer,
	"torn_name" text,
	"torn_level" integer,
	"torn_profile" jsonb,
	"ff_scouter_stats" jsonb,
	"bs_estimate" double precision,
	"bs_estimate_human" text,
	"fair_fight" double precision,
	"source" text,
	"last_fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "elims_member_stats_discord_id_unique" UNIQUE("discord_id")
);
--> statement-breakpoint
CREATE TABLE "elims_team_players" (
	"id" integer PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"name" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"attacks" integer DEFAULT 0 NOT NULL,
	"last_action" jsonb,
	"status" jsonb,
	"is_mock" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "elims_team_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"attacks" integer DEFAULT 0 NOT NULL,
	"members_count" integer DEFAULT 0 NOT NULL,
	"active_count" integer DEFAULT 0 NOT NULL,
	"hour_tct" integer NOT NULL,
	"is_mock" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "elims_teams" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"attacks" integer DEFAULT 0 NOT NULL,
	"members_count" integer DEFAULT 0 NOT NULL,
	"is_mock" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "elims_armory_deposits" ADD COLUMN IF NOT EXISTS "log_timestamp" text;--> statement-breakpoint
ALTER TABLE "elims_armory_deposits" ADD COLUMN IF NOT EXISTS "log_message" text;