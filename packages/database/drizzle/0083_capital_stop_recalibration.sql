ALTER TABLE "capital_book_configs" ALTER COLUMN "stop_atr_multiplier" SET DEFAULT 2.5;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ALTER COLUMN "stop_min_pct" SET DEFAULT 2;--> statement-breakpoint
UPDATE "capital_book_configs" SET "stop_atr_multiplier" = 2.5 WHERE "stop_atr_multiplier" = 3;--> statement-breakpoint
UPDATE "capital_book_configs" SET "stop_min_pct" = 2 WHERE "stop_min_pct" = 1.5;
