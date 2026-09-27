CREATE TABLE "oil_rig_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"rating" integer NOT NULL,
	"daily_revenue" double precision NOT NULL,
	"weekly_revenue" double precision NOT NULL,
	"daily_customers" integer NOT NULL,
	"weekly_customers" integer NOT NULL,
	"barrels_sold" integer NOT NULL,
	"barrels_in_stock" integer NOT NULL,
	"barrel_price" integer NOT NULL,
	"ad_budget" double precision NOT NULL,
	"storage_capacity" integer NOT NULL,
	"efficiency" integer NOT NULL,
	"environment" integer NOT NULL,
	"popularity" integer NOT NULL,
	"trains" integer NOT NULL,
	"profile" jsonb NOT NULL,
	"employees" jsonb NOT NULL,
	"stock" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "torn_users" (
	"torn_id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"discord_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "torn_users_discord_id_unique" UNIQUE("discord_id")
);
