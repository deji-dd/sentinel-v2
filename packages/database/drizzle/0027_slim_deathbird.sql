CREATE TABLE "merc_contract_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text,
	"discord_user_id" text NOT NULL,
	"discord_username" text,
	"faction_id" integer NOT NULL,
	"faction_name" text,
	"used" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guild_configs" ADD COLUMN "merc_manager_role_id" text;--> statement-breakpoint
ALTER TABLE "merc_channel_configs" ADD COLUMN "contract_creation_message_id" text;--> statement-breakpoint
ALTER TABLE "merc_channel_configs" ADD COLUMN "client_category" text;--> statement-breakpoint
ALTER TABLE "merc_channel_configs" ADD COLUMN "archive_category" text;--> statement-breakpoint
ALTER TABLE "merc_contracts" ADD COLUMN "client_channel_id" text;--> statement-breakpoint
ALTER TABLE "merc_contracts" ADD COLUMN "client_discord_id" text;--> statement-breakpoint
CREATE INDEX "idx_merc_tokens_expires" ON "merc_contract_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_merc_tokens_user" ON "merc_contract_tokens" USING btree ("discord_user_id");