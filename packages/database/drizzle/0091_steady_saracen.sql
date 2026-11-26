CREATE TABLE "alliance_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text,
	"torn_id" integer NOT NULL,
	"torn_name" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"invalid_count" integer DEFAULT 0 NOT NULL,
	"last_invalid_at" timestamp with time zone,
	"donated_by_discord_id" text,
	"donated_by_discord_tag" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guild_configs" ADD COLUMN "key_donation_channel_id" text;--> statement-breakpoint
ALTER TABLE "guild_configs" ADD COLUMN "key_donation_embed_message_id" text;--> statement-breakpoint
CREATE INDEX "idx_alliance_keys_guild_id" ON "alliance_api_keys" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "idx_alliance_keys_torn_id" ON "alliance_api_keys" USING btree ("torn_id");--> statement-breakpoint
CREATE INDEX "idx_alliance_keys_valid" ON "alliance_api_keys" USING btree ("is_valid");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_alliance_keys_hash" ON "alliance_api_keys" USING btree ("api_key_hash");--> statement-breakpoint
-- Backfill the keys that previously powered territory activity. They come from
-- the global system pool, so guild_id stays NULL (visible to every guild).
INSERT INTO "alliance_api_keys" (
	"id", "guild_id", "torn_id", "torn_name", "api_key_encrypted", "api_key_hash",
	"is_valid", "invalid_count", "last_invalid_at", "last_used_at", "created_at", "updated_at"
)
SELECT
	'system:' || k."api_key_hash",
	NULL,
	k."user_id",
	COALESCE(u."username", 'Player ' || k."user_id"),
	k."api_key_encrypted",
	k."api_key_hash",
	k."is_valid",
	k."invalid_count",
	k."last_invalid_at",
	k."last_used_at",
	k."created_at",
	now()
FROM "api_keys" k
LEFT JOIN "users" u ON u."torn_id" = k."user_id"
WHERE k."key_type" = 'system' AND k."is_valid" = true
ON CONFLICT DO NOTHING;