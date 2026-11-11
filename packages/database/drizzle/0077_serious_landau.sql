CREATE TABLE "capital_ml_models" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"kind" text NOT NULL,
	"feature_spec" jsonb NOT NULL,
	"artifact" jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data_start" timestamp with time zone,
	"data_end" timestamp with time zone,
	"trained_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capital_ml_predictions" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"stock_id" integer NOT NULL,
	"model_id" text,
	"horizon_days" integer NOT NULL,
	"probability" double precision NOT NULL,
	"rule_score" double precision,
	"eligible" boolean DEFAULT false NOT NULL,
	"features" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evaluated_at" timestamp with time zone,
	"realized_return_pct" double precision,
	"barrier_hit" integer
);
--> statement-breakpoint
ALTER TABLE "capital_book_configs" ADD COLUMN "ml_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ADD COLUMN "ml_weight" double precision DEFAULT 0.25 NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ADD COLUMN "ml_min_confidence" double precision DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_book_configs" ADD COLUMN "ml_max_model_age_days" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "capital_ml_predictions" ADD CONSTRAINT "capital_ml_predictions_model_id_capital_ml_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."capital_ml_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capital_ml_models_active_idx" ON "capital_ml_models" USING btree ("active");--> statement-breakpoint
CREATE INDEX "capital_ml_predictions_book_created_idx" ON "capital_ml_predictions" USING btree ("book","created_at");--> statement-breakpoint
CREATE INDEX "capital_ml_predictions_pending_idx" ON "capital_ml_predictions" USING btree ("evaluated_at");