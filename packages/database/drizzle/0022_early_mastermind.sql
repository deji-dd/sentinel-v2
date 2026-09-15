CREATE TABLE "subversive_target_finder_targets" (
	"target_id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"faction_id" integer,
	"faction_name" text,
	"days_old" integer DEFAULT 0 NOT NULL,
	"last_action" timestamp with time zone,
	"is_inactive" boolean DEFAULT false NOT NULL,
	"is_factionless" boolean DEFAULT false NOT NULL,
	"in_hospital" boolean DEFAULT false NOT NULL,
	"hospital_until" timestamp with time zone,
	"estimated_bs" double precision DEFAULT 0 NOT NULL,
	"estimated_score" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'okay' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subversive_target_finder_users" (
	"torn_id" integer PRIMARY KEY NOT NULL,
	"torn_name" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"bs_score" double precision DEFAULT 0 NOT NULL,
	"battle_stats" jsonb,
	"stats_cached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_subversive_tf_targets_score" ON "subversive_target_finder_targets" USING btree ("estimated_score");--> statement-breakpoint
CREATE INDEX "idx_subversive_tf_targets_hosp" ON "subversive_target_finder_targets" USING btree ("in_hospital");--> statement-breakpoint
CREATE INDEX "idx_subversive_tf_targets_factionless" ON "subversive_target_finder_targets" USING btree ("is_factionless");--> statement-breakpoint
CREATE INDEX "idx_subversive_tf_targets_inactive" ON "subversive_target_finder_targets" USING btree ("is_inactive");--> statement-breakpoint
CREATE INDEX "idx_subversive_tf_targets_level" ON "subversive_target_finder_targets" USING btree ("level");--> statement-breakpoint
CREATE INDEX "idx_subversive_tf_users_hash" ON "subversive_target_finder_users" USING btree ("api_key_hash");--> statement-breakpoint
CREATE INDEX "idx_subversive_tf_users_active" ON "subversive_target_finder_users" USING btree ("is_active");