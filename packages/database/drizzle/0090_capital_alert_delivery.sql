CREATE TABLE "capital_alert_delivery" (
	"discord_user_id" text PRIMARY KEY NOT NULL,
	"dm_closed_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
