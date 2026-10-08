CREATE TABLE "torn_log_types" (
	"id" integer PRIMARY KEY NOT NULL,
	"title" text,
	"category" text,
	"wealth_category" text,
	"observed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wealth_account_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"wallet" double precision DEFAULT 0 NOT NULL,
	"points" double precision DEFAULT 0 NOT NULL,
	"vault" double precision DEFAULT 0 NOT NULL,
	"company" double precision DEFAULT 0 NOT NULL,
	"city_bank" double precision DEFAULT 0 NOT NULL,
	"cayman_bank" double precision DEFAULT 0 NOT NULL,
	"piggy_bank" double precision DEFAULT 0 NOT NULL,
	"bookie" double precision DEFAULT 0 NOT NULL,
	"items_value" double precision DEFAULT 0 NOT NULL,
	"tracked_net_worth" double precision DEFAULT 0 NOT NULL,
	"torn_net_worth" double precision,
	"net_worth_drift" double precision,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "market_value" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "item_type" text;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD COLUMN "log_type" integer;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD COLUMN "wealth_category" text;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD COLUMN "wallet_delta" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD COLUMN "account" text;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD COLUMN "account_delta" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD COLUMN "asset_delta" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD COLUMN "priced" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_wealth_account_snapshots_timestamp" ON "wealth_account_snapshots" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_assets_asset_location" ON "assets" USING btree ("asset_id","location");--> statement-breakpoint
CREATE INDEX "idx_ledger_events_timestamp" ON "ledger_events" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_ledger_events_log_type" ON "ledger_events" USING btree ("log_type");