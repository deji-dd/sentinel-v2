CREATE TABLE "subversive_ranked_wars" (
	"id" integer PRIMARY KEY NOT NULL,
	"start" timestamp with time zone,
	"end" timestamp with time zone,
	"target" integer DEFAULT 0 NOT NULL,
	"winner_faction_id" integer,
	"forfeit" boolean DEFAULT false NOT NULL,
	"is_termed" boolean DEFAULT false NOT NULL,
	"termed_reason" text,
	"status" text DEFAULT 'processed' NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subversive_recruitment_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" integer NOT NULL,
	"player_name" text NOT NULL,
	"player_level" integer DEFAULT 1 NOT NULL,
	"faction_id" integer NOT NULL,
	"faction_name" text NOT NULL,
	"war_id" integer NOT NULL,
	"attacks" integer DEFAULT 0 NOT NULL,
	"faction_total_attacks" integer DEFAULT 0 NOT NULL,
	"attack_percentage" double precision DEFAULT 0 NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"estimated_stats" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"notified" boolean DEFAULT false NOT NULL,
	"notified_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_subversive_wars_status" ON "subversive_ranked_wars" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_subversive_wars_end" ON "subversive_ranked_wars" USING btree ("end");--> statement-breakpoint
CREATE INDEX "idx_subversive_candidates_player_id" ON "subversive_recruitment_candidates" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "idx_subversive_candidates_war_id" ON "subversive_recruitment_candidates" USING btree ("war_id");--> statement-breakpoint
CREATE INDEX "idx_subversive_candidates_status" ON "subversive_recruitment_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_subversive_candidates_created_at" ON "subversive_recruitment_candidates" USING btree ("created_at");