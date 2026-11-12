ALTER TABLE "capital_book_configs" ALTER COLUMN "max_stock_weight_pct" SET DEFAULT 12;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ALTER COLUMN "max_positions" SET DEFAULT 7;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ALTER COLUMN "stop_atr_multiplier" SET DEFAULT 3;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ALTER COLUMN "stop_min_pct" SET DEFAULT 1.5;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ALTER COLUMN "trailing_atr_multiplier" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ALTER COLUMN "trailing_pct" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ALTER COLUMN "tighten_trail_pct" SET DEFAULT 1.5;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ALTER COLUMN "scale_out_r" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ALTER COLUMN "reversal_exit_sigma" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ALTER COLUMN "drawdown_halt_pct" SET DEFAULT 20;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ALTER COLUMN "drawdown_derisk_pct" SET DEFAULT 10;--> statement-breakpoint
ALTER TABLE "capital_fills" ADD COLUMN "exit_reason" text;--> statement-breakpoint
ALTER TABLE "capital_orders" ADD COLUMN "exit_reason" text;--> statement-breakpoint
ALTER TABLE "capital_positions" ADD COLUMN "entry_price" numeric(24, 6);--> statement-breakpoint
ALTER TABLE "capital_positions" ADD COLUMN "stop_price" numeric(24, 6);--> statement-breakpoint
ALTER TABLE "capital_positions" ADD COLUMN "target_price" numeric(24, 6);--> statement-breakpoint
ALTER TABLE "capital_positions" ADD COLUMN "peak_price" numeric(24, 6);--> statement-breakpoint
ALTER TABLE "capital_positions" ADD COLUMN "scaled_out_at" timestamp with time zone;--> statement-breakpoint
-- Move existing books off the old defaults, but only where the value still is
-- the old default: a deliberately customised setting is left alone.
UPDATE "capital_book_configs" SET "max_stock_weight_pct" = 12 WHERE "max_stock_weight_pct" = 20;--> statement-breakpoint
UPDATE "capital_book_configs" SET "max_positions" = 7 WHERE "max_positions" = 12;--> statement-breakpoint
UPDATE "capital_book_configs" SET "stop_atr_multiplier" = 3 WHERE "stop_atr_multiplier" = 2;--> statement-breakpoint
UPDATE "capital_book_configs" SET "stop_min_pct" = 1.5 WHERE "stop_min_pct" = 4;--> statement-breakpoint
UPDATE "capital_book_configs" SET "trailing_atr_multiplier" = 2 WHERE "trailing_atr_multiplier" = 1.5;--> statement-breakpoint
UPDATE "capital_book_configs" SET "trailing_pct" = 2 WHERE "trailing_pct" = 6;--> statement-breakpoint
UPDATE "capital_book_configs" SET "tighten_trail_pct" = 1.5 WHERE "tighten_trail_pct" = 4;--> statement-breakpoint
UPDATE "capital_book_configs" SET "scale_out_r" = 1 WHERE "scale_out_r" = 2;--> statement-breakpoint
UPDATE "capital_book_configs" SET "reversal_exit_sigma" = 1 WHERE "reversal_exit_sigma" = 0;--> statement-breakpoint
UPDATE "capital_book_configs" SET "drawdown_halt_pct" = 20 WHERE "drawdown_halt_pct" = 15;--> statement-breakpoint
UPDATE "capital_book_configs" SET "drawdown_derisk_pct" = 10 WHERE "drawdown_derisk_pct" = 25;--> statement-breakpoint
-- Existing open positions: freeze the cost basis as the entry anchor and seed
-- the high-water mark. The engine fills in the stop/target from ATR once.
UPDATE "capital_positions" SET "entry_price" = ROUND("cost_basis" / NULLIF("shares", 0), 6) WHERE "entry_price" IS NULL AND "shares" > 0;--> statement-breakpoint
UPDATE "capital_positions" SET "peak_price" = "entry_price" WHERE "peak_price" IS NULL AND "entry_price" IS NOT NULL;
