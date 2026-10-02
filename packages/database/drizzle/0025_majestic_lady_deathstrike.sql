CREATE TABLE "merc_channel_configs" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"contract_creation" text,
	"upcoming_contracts" text,
	"targets" text,
	"merc_log" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merc_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"faction_id" integer NOT NULL,
	"faction_name" text NOT NULL,
	"war_status_at_creation" text NOT NULL,
	"war_id" integer,
	"war_start" timestamp with time zone,
	"war_end" timestamp with time zone,
	"war_target" integer,
	"war_opponent_id" integer,
	"war_opponent_name" text,
	"start_time" timestamp with time zone NOT NULL,
	"start_immediately" boolean DEFAULT false NOT NULL,
	"start_minutes_before_war" integer,
	"end_time" timestamp with time zone,
	"end_on_war_end" boolean DEFAULT false NOT NULL,
	"allow_online" boolean DEFAULT true NOT NULL,
	"allow_idle" boolean DEFAULT true NOT NULL,
	"allow_offline" boolean DEFAULT false NOT NULL,
	"max_idle_minutes" integer DEFAULT 15,
	"allow_stricken_hits" boolean DEFAULT false NOT NULL,
	"min_level" integer DEFAULT 1 NOT NULL,
	"max_level" integer DEFAULT 100 NOT NULL,
	"change_terms_on_war_start" boolean DEFAULT false NOT NULL,
	"war_start_allow_online" boolean,
	"war_start_allow_idle" boolean,
	"war_start_allow_offline" boolean,
	"war_start_max_idle_minutes" integer,
	"war_start_allow_stricken_hits" boolean,
	"war_start_min_level" integer,
	"war_start_max_level" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_merc_contracts_guild_id" ON "merc_contracts" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "idx_merc_contracts_faction_id" ON "merc_contracts" USING btree ("faction_id");--> statement-breakpoint
CREATE INDEX "idx_merc_contracts_status" ON "merc_contracts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_merc_contracts_start_time" ON "merc_contracts" USING btree ("start_time");