CREATE TABLE "elims_armory_deposits" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"discord_user_id" text NOT NULL,
	"discord_username" text NOT NULL,
	"torn_id" integer,
	"torn_name" text,
	"item_id" text NOT NULL,
	"item_name" text NOT NULL,
	"item_category" text NOT NULL,
	"quantity" integer NOT NULL,
	"raw_log" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "elims_item_requests" ADD COLUMN "verification_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "elims_item_requests" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "elims_item_requests" ADD COLUMN "verified_by_discord_id" text;--> statement-breakpoint
ALTER TABLE "elims_item_requests" ADD COLUMN "verification_log" text;