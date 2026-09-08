CREATE TABLE "elims_stock_holders" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"discord_user_id" text NOT NULL,
	"discord_username" text NOT NULL,
	"item_id" text NOT NULL,
	"item_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "elims_armory_deposits" ALTER COLUMN "quantity" SET DATA TYPE bigint;