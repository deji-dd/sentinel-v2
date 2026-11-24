CREATE TABLE "capital_alert_preferences" (
	"investor_id" text PRIMARY KEY NOT NULL,
	"payouts_enabled" boolean DEFAULT true NOT NULL,
	"apr_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capital_alert_preferences" ADD CONSTRAINT "capital_alert_preferences_investor_id_capital_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "capital_investors"("id") ON DELETE cascade ON UPDATE no action;
