ALTER TABLE "capital_positions" ADD COLUMN "unrealized_pnl" numeric(38, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_positions" ADD COLUMN "unrealized_pnl_pct" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_positions" ADD COLUMN "last_marked_at" timestamp with time zone;