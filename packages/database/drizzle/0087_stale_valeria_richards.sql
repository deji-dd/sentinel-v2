CREATE TABLE "capital_ml_health" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"book" text NOT NULL,
	"model_id" text,
	"window_days" integer NOT NULL,
	"evaluated_count" integer NOT NULL,
	"ic" double precision,
	"hit_rate" double precision,
	"calibration_error" double precision,
	"drawdown_pct" double precision,
	"training_base_rate" double precision,
	"live_vs_backtest_pct" double precision,
	"breached" boolean DEFAULT false NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action" text DEFAULT 'none' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capital_book_configs" ADD COLUMN "ml_kill_switch_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ADD COLUMN "ml_disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ADD COLUMN "ml_disabled_reason" text;--> statement-breakpoint
ALTER TABLE "capital_ml_health" ADD CONSTRAINT "capital_ml_health_model_id_capital_ml_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."capital_ml_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capital_ml_health_book_created_idx" ON "capital_ml_health" USING btree ("book","created_at");