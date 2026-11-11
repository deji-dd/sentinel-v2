ALTER TABLE "capital_book_configs" ADD COLUMN "signal_mode" text DEFAULT 'reversal' NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ADD COLUMN "reversal_entry_sigma" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ADD COLUMN "reversal_exit_sigma" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ADD COLUMN "max_volatility_pct" double precision DEFAULT 40 NOT NULL;