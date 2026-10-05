CREATE TABLE "oil_rig_benchmarks" (
	"id" text PRIMARY KEY NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"rating" integer NOT NULL,
	"field_size" integer NOT NULL,
	"sample_size" integer NOT NULL,
	"avg_weekly_revenue" double precision NOT NULL,
	"avg_weekly_customers" double precision NOT NULL,
	"avg_hired" double precision NOT NULL,
	"avg_capacity" double precision NOT NULL,
	"role_counts" jsonb NOT NULL,
	"role_shares" jsonb NOT NULL,
	"top_rigs" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oil_rig_briefs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"data_basis" text NOT NULL,
	"tick_age_minutes" integer,
	"regime" text NOT NULL,
	"regime_since" timestamp with time zone NOT NULL,
	"inventory_state" text NOT NULL,
	"warehouse_critical" integer NOT NULL,
	"advice_signature" text NOT NULL,
	"directives" jsonb NOT NULL,
	"analysis" jsonb NOT NULL,
	"outcome" jsonb,
	"outcome_evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "oil_rig_benchmarks_captured_idx" ON "oil_rig_benchmarks" USING btree ("captured_at");--> statement-breakpoint
CREATE INDEX "oil_rig_briefs_as_of_idx" ON "oil_rig_briefs" USING btree ("as_of");