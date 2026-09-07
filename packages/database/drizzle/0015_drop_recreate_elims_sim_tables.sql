DROP TABLE IF EXISTS "elims_team_snapshots" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "elims_team_players" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "elims_teams" CASCADE;--> statement-breakpoint
DELETE FROM "system_states" WHERE "id" = 'elims:simulation_state';--> statement-breakpoint
CREATE TABLE "elims_teams" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"attacks" integer DEFAULT 0 NOT NULL,
	"members_count" integer DEFAULT 0 NOT NULL,
	"lives" integer DEFAULT 50 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"eliminated" boolean DEFAULT false NOT NULL,
	"eliminated_timestamp" timestamp with time zone,
	"leaders" jsonb,
	"is_mock" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
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
);--> statement-breakpoint
CREATE TABLE "elims_team_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"attacks" integer DEFAULT 0 NOT NULL,
	"members_count" integer DEFAULT 0 NOT NULL,
	"active_count" integer DEFAULT 0 NOT NULL,
	"lives" integer DEFAULT 50 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"eliminated" boolean DEFAULT false NOT NULL,
	"hour_tct" integer NOT NULL,
	"is_mock" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
