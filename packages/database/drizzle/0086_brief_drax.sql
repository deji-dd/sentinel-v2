CREATE TABLE "capital_ml_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"feature_spec_hash" text NOT NULL,
	"feature_spec" jsonb NOT NULL,
	"label_spec" text NOT NULL,
	"data_start" timestamp with time zone,
	"data_end" timestamp with time zone,
	"rows" integer NOT NULL,
	"folds" jsonb NOT NULL,
	"hyperparameters" jsonb NOT NULL,
	"gates" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"baselines" jsonb NOT NULL,
	"uncertainty" jsonb NOT NULL,
	"model_id" text,
	"activated" boolean DEFAULT false NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "capital_ml_runs" ADD CONSTRAINT "capital_ml_runs_model_id_capital_ml_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."capital_ml_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capital_ml_runs_created_idx" ON "capital_ml_runs" USING btree ("created_at");