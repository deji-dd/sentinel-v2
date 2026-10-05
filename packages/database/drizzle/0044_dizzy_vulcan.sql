CREATE TABLE "subversive_stock_alert_configs" (
	"faction_id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"channel_id" text,
	"change_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"high_low_windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cooldown_minutes" integer DEFAULT 30 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subversive_stock_alert_states" (
	"faction_id" integer NOT NULL,
	"stock_id" integer NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subversive_stock_alert_states_faction_id_stock_id_pk" PRIMARY KEY("faction_id","stock_id")
);
--> statement-breakpoint
CREATE INDEX "idx_subversive_stock_alert_states_faction" ON "subversive_stock_alert_states" USING btree ("faction_id");