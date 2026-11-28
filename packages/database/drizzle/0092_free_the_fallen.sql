CREATE TABLE "yaba_battle_estimates" (
	"torn_id" integer NOT NULL,
	"provider" text DEFAULT 'ffscouter' NOT NULL,
	"score" integer,
	"fair_fight" integer,
	"source" text,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yaba_collection_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"key_count" integer DEFAULT 0 NOT NULL,
	"counters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "yaba_faction_daily" (
	"faction_id" integer NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"members_count" integer NOT NULL,
	"respect" integer,
	"days_old" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yaba_factions" (
	"faction_id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tag" text,
	"type" text DEFAULT 'combat' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'verification' NOT NULL,
	"leader_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yaba_members" (
	"torn_id" integer PRIMARY KEY NOT NULL,
	"faction_id" integer NOT NULL,
	"name" text NOT NULL,
	"level" integer,
	"days_in_faction" integer,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yaba_presets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"faction_type" text DEFAULT 'combat' NOT NULL,
	"metrics" jsonb NOT NULL,
	"weights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hash" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "yaba_presets_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "yaba_rankings" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"faction_type" text NOT NULL,
	"window" text NOT NULL,
	"preset_hash" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"rows" jsonb NOT NULL,
	"unranked_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "yaba_stat_anchors" (
	"id" text PRIMARY KEY NOT NULL,
	"torn_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"source" text DEFAULT 'popular' NOT NULL,
	"partial" boolean DEFAULT false NOT NULL,
	"xanax" integer,
	"activity_seconds" integer,
	"ranked_war_hits" integer,
	"revives" integer,
	"faction_respect" integer,
	"attacks_won" integer,
	"attacks_lost" integer,
	"hits_success" integer,
	"hits_critical" integer,
	"damage_total" integer,
	"revive_skill" integer,
	"ranked_war_wins" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guild_configs" ADD COLUMN "yaba_faction_chart_channel_id" text;--> statement-breakpoint
ALTER TABLE "guild_configs" ADD COLUMN "yaba_faction_chart_message_id" text;--> statement-breakpoint
ALTER TABLE "guild_configs" ADD COLUMN "yaba_player_chart_channel_id" text;--> statement-breakpoint
ALTER TABLE "guild_configs" ADD COLUMN "yaba_player_chart_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_yaba_battle_estimates_member_provider" ON "yaba_battle_estimates" USING btree ("torn_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_yaba_faction_daily_faction_day" ON "yaba_faction_daily" USING btree ("faction_id","day");--> statement-breakpoint
CREATE INDEX "idx_yaba_factions_enabled" ON "yaba_factions" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "idx_yaba_factions_type" ON "yaba_factions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_yaba_members_faction_id" ON "yaba_members" USING btree ("faction_id");--> statement-breakpoint
CREATE INDEX "idx_yaba_members_last_seen" ON "yaba_members" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_yaba_rankings_version" ON "yaba_rankings" USING btree ("scope","faction_type","window","preset_hash","generated_at");--> statement-breakpoint
CREATE INDEX "idx_yaba_rankings_lookup" ON "yaba_rankings" USING btree ("scope","faction_type","window");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_yaba_stat_anchors_member_at" ON "yaba_stat_anchors" USING btree ("torn_id","at");--> statement-breakpoint
CREATE INDEX "idx_yaba_stat_anchors_at" ON "yaba_stat_anchors" USING btree ("at");
-- Seed the two sheet-default presets. Drizzle generates DDL only; this backfill
-- ships in the same transaction so a fresh database has rankings on first boot.
INSERT INTO "yaba_presets" ("id", "name", "faction_type", "metrics", "weights", "hash", "is_default", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), 'Sheet default - combat', 'combat', '["xanax","activity","hits","battle"]'::jsonb, '{}'::jsonb, '775f3002', true, now(), now()),
  (gen_random_uuid(), 'Sheet default - revive', 'revive', '["xanax","activity","revives","battle"]'::jsonb, '{}'::jsonb, '6e294ce6', true, now(), now())
ON CONFLICT ("hash") DO NOTHING;
