CREATE TABLE "guild_monitored_factions" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"faction_id" integer NOT NULL,
	"faction_name" text,
	"faction_tag" text,
	"revives_enabled" boolean DEFAULT true NOT NULL,
	"revives_channel_id" text,
	"revives_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_revives_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guild_configs" ADD COLUMN "module_monitoring" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "guild_monitored_factions_guild_faction_idx" ON "guild_monitored_factions" USING btree ("guild_id","faction_id");