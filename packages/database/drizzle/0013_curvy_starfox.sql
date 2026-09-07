ALTER TABLE "elims_team_snapshots" ADD COLUMN "lives" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "elims_team_snapshots" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "elims_team_snapshots" ADD COLUMN "eliminated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "elims_teams" ADD COLUMN "lives" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "elims_teams" ADD COLUMN "wins" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "elims_teams" ADD COLUMN "losses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "elims_teams" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "elims_teams" ADD COLUMN "eliminated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "elims_teams" ADD COLUMN "eliminated_timestamp" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "elims_teams" ADD COLUMN "leaders" jsonb;