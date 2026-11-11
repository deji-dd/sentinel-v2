ALTER TABLE "capital_investments" ADD COLUMN "payout_mode" text DEFAULT 'cash' NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_positions" ADD COLUMN "is_unplanned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "capital_investments"
SET "next_payout_at" = CASE
	WHEN "frequency" = 'daily' THEN date_trunc('day', now()) + interval '1 day'
	WHEN "frequency" = 'weekly' THEN date_trunc('week', now()) + interval '1 week'
	WHEN "frequency" = 'monthly' THEN date_trunc('month', now()) + interval '1 month'
	ELSE "next_payout_at"
END
WHERE "status" = 'active'
	AND "frequency" IN ('daily', 'weekly', 'monthly');
