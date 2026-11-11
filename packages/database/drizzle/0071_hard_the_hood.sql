CREATE TABLE "capital_access" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"torn_id" integer,
	"discord_id" text,
	"role" text DEFAULT 'viewer' NOT NULL,
	"investor_id" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"actor_discord_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_book_configs" (
	"book" text PRIMARY KEY NOT NULL,
	"public_show_aum" boolean DEFAULT true NOT NULL,
	"public_show_trades" boolean DEFAULT true NOT NULL,
	"public_show_holdings" boolean DEFAULT false NOT NULL,
	"public_show_fees" boolean DEFAULT true NOT NULL,
	"fee_rate_daily_bps" integer DEFAULT 2500 NOT NULL,
	"fee_rate_weekly_bps" integer DEFAULT 1500 NOT NULL,
	"fee_rate_monthly_bps" integer DEFAULT 500 NOT NULL,
	"min_cash_reserve_pct" double precision DEFAULT 15 NOT NULL,
	"max_equity_pct" double precision DEFAULT 85 NOT NULL,
	"max_stock_weight_pct" double precision DEFAULT 20 NOT NULL,
	"max_positions" integer DEFAULT 12 NOT NULL,
	"risk_per_trade_pct" double precision DEFAULT 0.5 NOT NULL,
	"stop_atr_multiplier" double precision DEFAULT 2 NOT NULL,
	"stop_min_pct" double precision DEFAULT 4 NOT NULL,
	"trailing_trigger_r" double precision DEFAULT 1 NOT NULL,
	"trailing_atr_multiplier" double precision DEFAULT 1.5 NOT NULL,
	"trailing_pct" double precision DEFAULT 6 NOT NULL,
	"tighten_trail_pct" double precision DEFAULT 4 NOT NULL,
	"scale_out_r" double precision DEFAULT 2 NOT NULL,
	"scale_out_fraction" double precision DEFAULT 0.3333 NOT NULL,
	"time_stop_days" integer DEFAULT 20 NOT NULL,
	"min_entry_score" double precision DEFAULT 65 NOT NULL,
	"max_rsi" double precision DEFAULT 75 NOT NULL,
	"overbought_sigma" double precision DEFAULT 2 NOT NULL,
	"regime_sma_days" integer DEFAULT 50 NOT NULL,
	"drawdown_halt_pct" double precision DEFAULT 15 NOT NULL,
	"drawdown_derisk_pct" double precision DEFAULT 25 NOT NULL,
	"daily_loss_halt_pct" double precision DEFAULT 5 NOT NULL,
	"stop_cooldown_days" integer DEFAULT 3 NOT NULL,
	"max_new_positions_per_week" integer DEFAULT 4 NOT NULL,
	"order_validity_minutes" integer DEFAULT 60 NOT NULL,
	"stale_data_seconds" integer DEFAULT 180 NOT NULL,
	"sale_fee_bps" integer DEFAULT 10 NOT NULL,
	"withdrawal_performance_fee_enabled" boolean DEFAULT true NOT NULL,
	"withdrawal_exit_fee_bps" integer DEFAULT 0 NOT NULL,
	"withdrawal_min_amount" numeric(38, 6) DEFAULT '1000000' NOT NULL,
	"withdrawal_notice_days" integer DEFAULT 0 NOT NULL,
	"payment_match_tolerance_pct" double precision DEFAULT 1 NOT NULL,
	"notify_unmatched_buys" boolean DEFAULT true NOT NULL,
	"live_alert_channel_id" text,
	"paper_alert_channel_id" text,
	"paper_starting_cash" numeric(38, 6) DEFAULT '150000000000' NOT NULL,
	"paper_slippage_bps" integer DEFAULT 5 NOT NULL,
	"paper_auto_fill" boolean DEFAULT true NOT NULL,
	"engine_enabled" boolean DEFAULT true NOT NULL,
	"live_enabled" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_books" (
	"book" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_engine_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"data_age_seconds" integer,
	"stocks_scored" integer DEFAULT 0 NOT NULL,
	"recommendations" integer DEFAULT 0 NOT NULL,
	"paper_fills" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capital_engine_runs_details_is_object" CHECK (jsonb_typeof("capital_engine_runs"."details") = 'object')
);
--> statement-breakpoint
CREATE TABLE "capital_fills" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"order_id" text,
	"stock_id" integer NOT NULL,
	"side" text NOT NULL,
	"shares" bigint NOT NULL,
	"price" numeric(24, 6) NOT NULL,
	"notional" numeric(38, 6) NOT NULL,
	"fees" numeric(38, 6) DEFAULT '0' NOT NULL,
	"source" text NOT NULL,
	"source_log_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"variance_shares" bigint,
	"variance_price" numeric(24, 6),
	"slippage_bps" double precision,
	"delay_seconds" integer,
	"notional_delta" numeric(38, 6),
	"decision_issue_id" text,
	"note" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capital_fills_metadata_is_object" CHECK (jsonb_typeof("capital_fills"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "capital_investments" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"investor_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"frequency" text NOT NULL,
	"principal" numeric(38, 6) NOT NULL,
	"units" numeric(30, 10) NOT NULL,
	"nav_at_deposit" numeric(38, 6) NOT NULL,
	"high_water_nav" numeric(38, 6) NOT NULL,
	"cumulative_payouts" numeric(38, 6) DEFAULT '0' NOT NULL,
	"cumulative_fees" numeric(38, 6) DEFAULT '0' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_payout_at" timestamp with time zone,
	"next_payout_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_investor_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"investor_id" text NOT NULL,
	"torn_id" integer,
	"discord_id" text,
	"name" text,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_investors" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"kind" text NOT NULL,
	"torn_id" integer,
	"faction_id" integer,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_market_candles" (
	"stock_id" integer NOT NULL,
	"interval_minutes" integer NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"open" numeric(24, 6) NOT NULL,
	"high" numeric(24, 6) NOT NULL,
	"low" numeric(24, 6) NOT NULL,
	"close" numeric(24, 6) NOT NULL,
	"shares" bigint,
	"investors" integer,
	"samples" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_market_latest" (
	"stock_id" integer PRIMARY KEY NOT NULL,
	"price" numeric(24, 6) NOT NULL,
	"cap" numeric(38, 6) DEFAULT '0' NOT NULL,
	"shares" bigint DEFAULT 0 NOT NULL,
	"investors" integer DEFAULT 0 NOT NULL,
	"performance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detail_updated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_nav_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"granularity" text NOT NULL,
	"cash" numeric(38, 6) NOT NULL,
	"positions_value" numeric(38, 6) NOT NULL,
	"total_value" numeric(38, 6) NOT NULL,
	"units_outstanding" numeric(30, 10) NOT NULL,
	"nav_per_unit" numeric(38, 6) NOT NULL,
	"invested_capital" numeric(38, 6) NOT NULL,
	"cumulative_payouts" numeric(38, 6) NOT NULL,
	"cumulative_fees" numeric(38, 6) NOT NULL,
	"investor_count" integer DEFAULT 0 NOT NULL,
	"return_pct" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_order_outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"book" text NOT NULL,
	"horizon" text NOT NULL,
	"price" numeric(24, 6),
	"return_pct" double precision,
	"max_adverse_pct" double precision,
	"max_favorable_pct" double precision,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"stock_id" integer NOT NULL,
	"side" text NOT NULL,
	"status" text DEFAULT 'recommended' NOT NULL,
	"recommended_shares" bigint DEFAULT 0 NOT NULL,
	"filled_shares" bigint DEFAULT 0 NOT NULL,
	"price_guide" numeric(24, 6) NOT NULL,
	"recommended_price" numeric(24, 6),
	"min_price" numeric(24, 6),
	"max_price" numeric(24, 6),
	"average_fill_price" numeric(24, 6),
	"score" double precision DEFAULT 0 NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"factor_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"risk_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stop_price" numeric(24, 6),
	"target_price" numeric(24, 6),
	"expected_annual_income" numeric(38, 6),
	"run_id" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capital_orders_factors_is_object" CHECK (jsonb_typeof("capital_orders"."factor_snapshot") = 'object')
);
--> statement-breakpoint
CREATE TABLE "capital_payment_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"investor_id" text,
	"investment_id" text,
	"payout_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counterparty_torn_id" integer,
	"expected_amount" numeric(38, 6) NOT NULL,
	"matched_amount" numeric(38, 6),
	"tolerance_pct" double precision DEFAULT 1 NOT NULL,
	"reference_code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"matched_log_id" text,
	"discord_channel_id" text,
	"discord_message_id" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_payout_obligations" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"investment_id" text NOT NULL,
	"investor_id" text NOT NULL,
	"frequency" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"gross_amount" numeric(38, 6) NOT NULL,
	"fee_amount" numeric(38, 6) DEFAULT '0' NOT NULL,
	"net_amount" numeric(38, 6) NOT NULL,
	"paid_amount" numeric(38, 6) DEFAULT '0' NOT NULL,
	"remaining_amount" numeric(38, 6) NOT NULL,
	"status" text DEFAULT 'due' NOT NULL,
	"high_water_nav" numeric(38, 6) NOT NULL,
	"nav_at_creation" numeric(38, 6) NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_by" text,
	"payment_reference" text,
	"source_log_id" text,
	"idempotency_key" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_positions" (
	"book" text NOT NULL,
	"stock_id" integer NOT NULL,
	"shares" bigint DEFAULT 0 NOT NULL,
	"cost_basis" numeric(38, 6) DEFAULT '0' NOT NULL,
	"realized" numeric(38, 6) DEFAULT '0' NOT NULL,
	"opened_at" timestamp with time zone,
	"last_trade_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_reconciliation_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"stock_id" integer,
	"investor_id" text,
	"title" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"amount" numeric(38, 6),
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discord_channel_id" text,
	"discord_message_id" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capital_issues_details_is_object" CHECK (jsonb_typeof("capital_reconciliation_issues"."details") = 'object')
);
--> statement-breakpoint
CREATE TABLE "capital_smoke_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text DEFAULT 'paper' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capital_smoke_reports_report_is_object" CHECK (jsonb_typeof("capital_smoke_reports"."report") = 'object')
);
--> statement-breakpoint
CREATE TABLE "capital_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"type" text NOT NULL,
	"investor_id" text,
	"investment_id" text,
	"stock_id" integer,
	"amount" numeric(38, 6) DEFAULT '0' NOT NULL,
	"shares" bigint,
	"price" numeric(24, 6),
	"fees" numeric(38, 6) DEFAULT '0' NOT NULL,
	"units" numeric(30, 10),
	"nav_per_unit" numeric(38, 6),
	"source" text NOT NULL,
	"source_log_id" text,
	"order_id" text,
	"fill_id" text,
	"payout_id" text,
	"withdrawal_id" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" text,
	"note" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capital_transactions_metadata_is_object" CHECK (jsonb_typeof("capital_transactions"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "capital_withdrawal_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"investment_id" text NOT NULL,
	"investor_id" text NOT NULL,
	"requested_amount" numeric(38, 6) NOT NULL,
	"requested_units" numeric(30, 10),
	"units_to_redeem" numeric(30, 10) NOT NULL,
	"gross_value" numeric(38, 6) NOT NULL,
	"principal_basis" numeric(38, 6) NOT NULL,
	"profit_amount" numeric(38, 6) DEFAULT '0' NOT NULL,
	"loss_amount" numeric(38, 6) DEFAULT '0' NOT NULL,
	"performance_fee" numeric(38, 6) DEFAULT '0' NOT NULL,
	"exit_fee" numeric(38, 6) DEFAULT '0' NOT NULL,
	"net_amount" numeric(38, 6) NOT NULL,
	"liquidity_warning" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"reference_code" text,
	"source_log_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"quoted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"note" text,
	"requested_by" text,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capital_book_configs" ADD CONSTRAINT "capital_book_configs_book_capital_books_book_fk" FOREIGN KEY ("book") REFERENCES "public"."capital_books"("book") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_investments" ADD CONSTRAINT "capital_investments_investor_id_capital_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."capital_investors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_investor_contacts" ADD CONSTRAINT "capital_investor_contacts_investor_id_capital_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."capital_investors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_order_outcomes" ADD CONSTRAINT "capital_order_outcomes_order_id_capital_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."capital_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_payout_obligations" ADD CONSTRAINT "capital_payout_obligations_investment_id_capital_investments_id_fk" FOREIGN KEY ("investment_id") REFERENCES "public"."capital_investments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_payout_obligations" ADD CONSTRAINT "capital_payout_obligations_investor_id_capital_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."capital_investors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_withdrawal_requests" ADD CONSTRAINT "capital_withdrawal_requests_investment_id_capital_investments_id_fk" FOREIGN KEY ("investment_id") REFERENCES "public"."capital_investments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capital_withdrawal_requests" ADD CONSTRAINT "capital_withdrawal_requests_investor_id_capital_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."capital_investors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capital_access_book_torn_idx" ON "capital_access" USING btree ("book","torn_id") WHERE "capital_access"."torn_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "capital_access_book_discord_idx" ON "capital_access" USING btree ("book","discord_id") WHERE "capital_access"."discord_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "capital_access_book_role_idx" ON "capital_access" USING btree ("book","role");--> statement-breakpoint
CREATE INDEX "capital_audit_book_time_idx" ON "capital_audit_log" USING btree ("book","created_at");--> statement-breakpoint
CREATE INDEX "capital_audit_entity_idx" ON "capital_audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "capital_engine_runs_book_time_idx" ON "capital_engine_runs" USING btree ("book","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_fills_source_log_idx" ON "capital_fills" USING btree ("source_log_id") WHERE "capital_fills"."source_log_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "capital_fills_book_time_idx" ON "capital_fills" USING btree ("book","occurred_at");--> statement-breakpoint
CREATE INDEX "capital_fills_order_idx" ON "capital_fills" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "capital_investments_book_investor_idx" ON "capital_investments" USING btree ("book","investor_id");--> statement-breakpoint
CREATE INDEX "capital_investments_book_status_idx" ON "capital_investments" USING btree ("book","status");--> statement-breakpoint
CREATE INDEX "capital_investments_next_payout_idx" ON "capital_investments" USING btree ("book","next_payout_at");--> statement-breakpoint
CREATE INDEX "capital_contacts_investor_idx" ON "capital_investor_contacts" USING btree ("investor_id");--> statement-breakpoint
CREATE INDEX "capital_contacts_discord_idx" ON "capital_investor_contacts" USING btree ("discord_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_investors_book_torn_idx" ON "capital_investors" USING btree ("book","torn_id") WHERE "capital_investors"."torn_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "capital_investors_book_faction_idx" ON "capital_investors" USING btree ("book","faction_id") WHERE "capital_investors"."faction_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "capital_investors_book_status_idx" ON "capital_investors" USING btree ("book","status");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_candles_stock_interval_bucket_idx" ON "capital_market_candles" USING btree ("stock_id","interval_minutes","bucket_start");--> statement-breakpoint
CREATE INDEX "capital_candles_bucket_idx" ON "capital_market_candles" USING btree ("bucket_start");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_nav_snapshots_book_granularity_time_idx" ON "capital_nav_snapshots" USING btree ("book","granularity","captured_at");--> statement-breakpoint
CREATE INDEX "capital_nav_snapshots_book_time_idx" ON "capital_nav_snapshots" USING btree ("book","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_order_outcomes_order_horizon_idx" ON "capital_order_outcomes" USING btree ("order_id","horizon");--> statement-breakpoint
CREATE INDEX "capital_orders_book_status_idx" ON "capital_orders" USING btree ("book","status");--> statement-breakpoint
CREATE INDEX "capital_orders_book_stock_time_idx" ON "capital_orders" USING btree ("book","stock_id","generated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_payment_intents_book_reference_idx" ON "capital_payment_intents" USING btree ("book","reference_code");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_payment_intents_matched_log_idx" ON "capital_payment_intents" USING btree ("matched_log_id") WHERE "capital_payment_intents"."matched_log_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "capital_payment_intents_book_status_idx" ON "capital_payment_intents" USING btree ("book","status");--> statement-breakpoint
CREATE INDEX "capital_payment_intents_counterparty_idx" ON "capital_payment_intents" USING btree ("counterparty_torn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_payouts_source_log_idx" ON "capital_payout_obligations" USING btree ("source_log_id") WHERE "capital_payout_obligations"."source_log_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "capital_payouts_idempotency_idx" ON "capital_payout_obligations" USING btree ("idempotency_key") WHERE "capital_payout_obligations"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "capital_payouts_book_status_due_idx" ON "capital_payout_obligations" USING btree ("book","status","due_at");--> statement-breakpoint
CREATE INDEX "capital_payouts_investment_idx" ON "capital_payout_obligations" USING btree ("investment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_positions_book_stock_idx" ON "capital_positions" USING btree ("book","stock_id");--> statement-breakpoint
CREATE INDEX "capital_issues_book_status_idx" ON "capital_reconciliation_issues" USING btree ("book","status");--> statement-breakpoint
CREATE INDEX "capital_issues_book_kind_idx" ON "capital_reconciliation_issues" USING btree ("book","kind");--> statement-breakpoint
CREATE INDEX "capital_issues_stock_idx" ON "capital_reconciliation_issues" USING btree ("book","stock_id");--> statement-breakpoint
CREATE INDEX "capital_smoke_reports_book_time_idx" ON "capital_smoke_reports" USING btree ("book","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_transactions_source_log_idx" ON "capital_transactions" USING btree ("source_log_id") WHERE "capital_transactions"."source_log_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "capital_transactions_book_time_idx" ON "capital_transactions" USING btree ("book","occurred_at");--> statement-breakpoint
CREATE INDEX "capital_transactions_book_type_idx" ON "capital_transactions" USING btree ("book","type");--> statement-breakpoint
CREATE INDEX "capital_transactions_investment_idx" ON "capital_transactions" USING btree ("investment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capital_withdrawals_source_log_idx" ON "capital_withdrawal_requests" USING btree ("source_log_id") WHERE "capital_withdrawal_requests"."source_log_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "capital_withdrawals_reference_idx" ON "capital_withdrawal_requests" USING btree ("reference_code") WHERE "capital_withdrawal_requests"."reference_code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "capital_withdrawals_book_status_idx" ON "capital_withdrawal_requests" USING btree ("book","status");--> statement-breakpoint
CREATE INDEX "capital_withdrawals_investment_idx" ON "capital_withdrawal_requests" USING btree ("investment_id");