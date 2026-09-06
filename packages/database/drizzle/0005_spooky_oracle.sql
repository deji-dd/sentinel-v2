CREATE TABLE "elims_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"torn_id" integer NOT NULL,
	"torn_name" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"invalid_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "elims_verified_users" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"torn_id" integer NOT NULL,
	"torn_name" text NOT NULL,
	"faction_id" integer,
	"faction_tag" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "elims_item_requests" ADD COLUMN "handled_by_torn_id" integer;--> statement-breakpoint
ALTER TABLE "elims_item_requests" ADD COLUMN "handled_by_torn_name" text;