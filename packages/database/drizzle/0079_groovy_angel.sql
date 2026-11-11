ALTER TABLE "capital_investors" ADD COLUMN "frequency" text DEFAULT 'weekly' NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_investors" ADD COLUMN "payout_mode" text DEFAULT 'cash' NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_book_configs" DROP COLUMN "live_alert_channel_id";--> statement-breakpoint
ALTER TABLE "capital_book_configs" DROP COLUMN "paper_alert_channel_id";