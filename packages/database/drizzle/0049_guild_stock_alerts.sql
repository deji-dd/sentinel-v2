CREATE TABLE "guild_stock_alert_configs" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"channel_id" text,
	"change_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"high_low_ranges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cooldown_minutes" integer DEFAULT 30 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "guild_stock_alert_states" (
	"guild_id" text NOT NULL,
	"stock_id" integer NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_stock_alert_states_guild_id_stock_id_pk" PRIMARY KEY("guild_id","stock_id")
);--> statement-breakpoint
CREATE TABLE "user_stock_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"discord_user_id" text NOT NULL,
	"stock_id" integer NOT NULL,
	"condition" text NOT NULL,
	"range_key" text,
	"threshold" double precision,
	"condition_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "user_stock_alerts_user_condition_idx" ON "user_stock_alerts" USING btree ("discord_user_id","condition_key");--> statement-breakpoint
CREATE INDEX "idx_user_stock_alerts_stock" ON "user_stock_alerts" USING btree ("stock_id");--> statement-breakpoint
CREATE INDEX "idx_user_stock_alerts_user" ON "user_stock_alerts" USING btree ("discord_user_id");--> statement-breakpoint
-- Carry the primary family faction's settings over to its guild, so a server
-- that had alerts configured does not silently lose them. Only one row per guild
-- can survive, and the guild is resolved from the Subversive guild pointer that
-- the rest of the tooling already uses; when it is unset the feature simply
-- starts from its factory defaults (disabled).
INSERT INTO "guild_stock_alert_configs" (
	"guild_id",
	"enabled",
	"channel_id",
	"change_rules",
	"high_low_ranges",
	"cooldown_minutes",
	"updated_by"
)
SELECT
	"system_states"."data"->>'guildId',
	"subversive_stock_alert_configs"."enabled",
	"subversive_stock_alert_configs"."channel_id",
	"subversive_stock_alert_configs"."change_rules",
	"subversive_stock_alert_configs"."high_low_windows",
	"subversive_stock_alert_configs"."cooldown_minutes",
	"subversive_stock_alert_configs"."updated_by"
FROM "subversive_stock_alert_configs"
CROSS JOIN "system_states"
WHERE "system_states"."id" = 'subversive:guild_config'
	AND "system_states"."data"->>'guildId' IS NOT NULL
	AND "subversive_stock_alert_configs"."faction_id" = 2013
ON CONFLICT ("guild_id") DO NOTHING;--> statement-breakpoint
DROP TABLE "subversive_stock_alert_states" CASCADE;--> statement-breakpoint
DROP TABLE "subversive_stock_alert_configs" CASCADE;
