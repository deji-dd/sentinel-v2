CREATE TABLE "faction_attack_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"attack_id" integer NOT NULL,
	"faction_id" integer NOT NULL,
	"direction" text NOT NULL,
	"attacker_id" integer,
	"attacker_name" text,
	"attacker_faction_id" integer,
	"attacker_faction_name" text,
	"defender_id" integer NOT NULL,
	"defender_name" text,
	"defender_faction_id" integer,
	"defender_faction_name" text,
	"result" text,
	"attack_code" text,
	"is_ranked_war" boolean DEFAULT false NOT NULL,
	"started_at" integer,
	"ended_at" integer,
	"source_key_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_faction_attack_logs_faction_attack" ON "faction_attack_logs" USING btree ("faction_id","attack_id");--> statement-breakpoint
CREATE INDEX "idx_faction_attack_logs_faction_direction" ON "faction_attack_logs" USING btree ("faction_id","direction");--> statement-breakpoint
CREATE INDEX "idx_faction_attack_logs_ended_at" ON "faction_attack_logs" USING btree ("ended_at");--> statement-breakpoint
CREATE INDEX "idx_faction_attack_logs_attacker_id" ON "faction_attack_logs" USING btree ("attacker_id");--> statement-breakpoint
CREATE INDEX "idx_faction_attack_logs_defender_faction" ON "faction_attack_logs" USING btree ("defender_faction_id","ended_at");