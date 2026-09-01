CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"key_type" text DEFAULT 'personal' NOT NULL,
	"is_valid" boolean DEFAULT true NOT NULL,
	"invalid_count" integer DEFAULT 0 NOT NULL,
	"last_invalid_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"discord_id" text,
	"torn_id" integer,
	"username" text NOT NULL,
	"avatar" text,
	"role" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_discord_id_unique" UNIQUE("discord_id"),
	CONSTRAINT "users_torn_id_unique" UNIQUE("torn_id")
);
--> statement-breakpoint
CREATE TABLE "faction_role_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"faction_id" integer NOT NULL,
	"faction_name" text,
	"member_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"leader_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_configs" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"log_channel_id" text,
	"admin_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"verified_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"nickname_template" text DEFAULT '[{tag}] {name} [{id}]',
	"verify_on_join" boolean DEFAULT false NOT NULL,
	"verify_cron" boolean DEFAULT false NOT NULL,
	"verify_cron_interval" integer DEFAULT 24 NOT NULL,
	"last_verify_cron_at" timestamp with time zone,
	"protected_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"faction_list_channel_id" text,
	"faction_list_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tt_full_channel_id" text,
	"tt_filtered_channel_id" text,
	"tt_territory_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tt_faction_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reaction_role_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"emoji" text NOT NULL,
	"role_id" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reaction_role_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"title" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text,
	"required_role_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reaction_role_messages_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "verification_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"discord_id" text NOT NULL,
	"status" text NOT NULL,
	"triggered_by" text DEFAULT 'user' NOT NULL,
	"roles_added" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"roles_removed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"old_nickname" text,
	"new_nickname" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verified_users" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"torn_id" integer NOT NULL,
	"torn_name" text NOT NULL,
	"faction_id" integer,
	"faction_tag" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"asset_id" text NOT NULL,
	"quantity" double precision DEFAULT 0 NOT NULL,
	"moving_average_cost" double precision DEFAULT 0 NOT NULL,
	"total_cost_basis" double precision DEFAULT 0 NOT NULL,
	"location" text NOT NULL,
	"owner" text DEFAULT 'personal' NOT NULL,
	"origin" text,
	"realized_pnl" double precision DEFAULT 0 NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gym_ledgers" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"stat_type" text NOT NULL,
	"source" text NOT NULL,
	"trains" integer,
	"energy_used" integer,
	"stat_gained" double precision NOT NULL,
	"stat_before" double precision,
	"stat_after" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_daily_profits" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"inflow" double precision NOT NULL,
	"outflow" double precision NOT NULL,
	"profit" double precision NOT NULL,
	"profile" jsonb NOT NULL,
	"employees" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crime_action_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"crime_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crime_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"crime_id" integer NOT NULL,
	"action" text NOT NULL,
	"nerve" integer DEFAULT 0 NOT NULL,
	"value" double precision DEFAULT 0 NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"id" text PRIMARY KEY NOT NULL,
	"log_id" text,
	"timestamp" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"category_id" integer NOT NULL,
	"transaction_name" text NOT NULL,
	"assets_affected" jsonb NOT NULL,
	"cash_flow" double precision DEFAULT 0 NOT NULL,
	"realized_pnl" double precision DEFAULT 0 NOT NULL,
	"raw_log" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"log" integer NOT NULL,
	"title" text,
	"timestamp" timestamp with time zone NOT NULL,
	"category" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_ledgers" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"stock_id" integer NOT NULL,
	"log_type" integer NOT NULL,
	"value" double precision NOT NULL,
	"item_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_purchase_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"destination" integer NOT NULL,
	"item_id" integer NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"cost_total" double precision DEFAULT 0 NOT NULL,
	"market_value" double precision DEFAULT 0 NOT NULL,
	"profit" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_stocks" (
	"id" text PRIMARY KEY NOT NULL,
	"shares" integer DEFAULT 0 NOT NULL,
	"transactions" jsonb,
	"bonus" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_controls" (
	"device_id" text PRIMARY KEY NOT NULL,
	"manual_mode" boolean DEFAULT false NOT NULL,
	"pump_in" boolean DEFAULT false NOT NULL,
	"pump_drain" boolean DEFAULT false NOT NULL,
	"simulate_breach" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sensor_readings" (
	"id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"temperature_c" double precision NOT NULL,
	"ph" double precision NOT NULL,
	"turbidity_ntu" double precision NOT NULL,
	"pond_level_pct" integer NOT NULL,
	"pump_in_active" boolean NOT NULL,
	"pump_drain_active" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"component" text NOT NULL,
	"message" text NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "system_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"service_id" text NOT NULL,
	"service_name" text NOT NULL,
	"status" text NOT NULL,
	"cpu_usage" double precision NOT NULL,
	"memory_rss_bytes" double precision NOT NULL,
	"memory_heap_used_bytes" double precision NOT NULL,
	"memory_heap_total_bytes" double precision NOT NULL,
	"latency_ms" integer NOT NULL,
	"uptime_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_states" (
	"id" text PRIMARY KEY NOT NULL,
	"init" boolean DEFAULT false NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"cadence_seconds" integer DEFAULT 86400 NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"force_run" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "factions" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tag" text,
	"tag_image" text,
	"leader_id" integer,
	"co_leader_id" integer,
	"respect" integer DEFAULT 0 NOT NULL,
	"capacity" integer DEFAULT 0 NOT NULL,
	"members_count" integer DEFAULT 0 NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "territory_blueprints" (
	"id" text PRIMARY KEY NOT NULL,
	"sector" integer,
	"size" integer,
	"density" integer,
	"slots" integer,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "territory_states" (
	"id" text PRIMARY KEY NOT NULL,
	"faction_id" integer,
	"racket" jsonb,
	"is_warring" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "torn_crimes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "torn_gyms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"stage" integer NOT NULL,
	"cost" integer NOT NULL,
	"energy" integer NOT NULL,
	"strength" double precision NOT NULL,
	"speed" double precision NOT NULL,
	"defense" double precision NOT NULL,
	"dexterity" double precision NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "torn_items" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "torn_properties" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "torn_stocks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"acronym" text NOT NULL,
	"market" jsonb,
	"bonus" jsonb,
	"images" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_area_mappings" (
	"id" integer PRIMARY KEY NOT NULL,
	"country_code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_destinations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"stocks" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "war_ledgers" (
	"id" text PRIMARY KEY NOT NULL,
	"tt" text NOT NULL,
	"assaulting_faction" integer NOT NULL,
	"defending_faction" integer NOT NULL,
	"victor_faction" integer,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_maps" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_maps" ADD CONSTRAINT "user_maps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;