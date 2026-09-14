CREATE TABLE "subversive_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
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
CREATE INDEX "idx_subversive_keys_guild_id" ON "subversive_api_keys" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "idx_subversive_keys_torn_id" ON "subversive_api_keys" USING btree ("torn_id");--> statement-breakpoint
CREATE INDEX "idx_subversive_keys_is_valid" ON "subversive_api_keys" USING btree ("is_valid");