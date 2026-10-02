CREATE TABLE IF NOT EXISTS "guild_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"torn_id" integer NOT NULL,
	"torn_name" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"invalid_count" integer DEFAULT 0 NOT NULL,
	"last_invalid_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"donated_by_discord_id" text,
	"donated_by_discord_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_guild_api_keys_guild_id" ON "guild_api_keys" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_guild_api_keys_hash" ON "guild_api_keys" USING btree ("api_key_hash");