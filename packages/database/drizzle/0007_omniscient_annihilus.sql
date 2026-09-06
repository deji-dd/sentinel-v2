CREATE TABLE "giveaway_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"giveaway_id" text NOT NULL,
	"discord_user_id" text NOT NULL,
	"discord_username" text NOT NULL,
	"torn_id" integer,
	"torn_name" text,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "giveaways" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"created_by_discord_id" text NOT NULL,
	"created_by_username" text NOT NULL,
	"item_id" text NOT NULL,
	"item_name" text NOT NULL,
	"item_category" text NOT NULL,
	"item_count" integer DEFAULT 1 NOT NULL,
	"winner_count" integer DEFAULT 1 NOT NULL,
	"duration_str" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"winners" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD CONSTRAINT "giveaway_entries_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "giveaway_entry_user_idx" ON "giveaway_entries" USING btree ("giveaway_id","discord_user_id");