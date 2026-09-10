CREATE TABLE "elims_team_attacks" (
	"id" text PRIMARY KEY NOT NULL,
	"attacker_id" integer NOT NULL,
	"attacker_name" text NOT NULL,
	"attacker_team_id" integer NOT NULL,
	"victim_id" integer NOT NULL,
	"victim_name" text NOT NULL,
	"victim_team_id" integer NOT NULL,
	"hospital_until" integer NOT NULL,
	"details" text,
	"is_mock" boolean DEFAULT false NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "elims_attacks_victim_until_idx" ON "elims_team_attacks" USING btree ("victim_id","hospital_until");--> statement-breakpoint
CREATE INDEX "elims_attacks_attacker_team_idx" ON "elims_team_attacks" USING btree ("attacker_team_id");--> statement-breakpoint
CREATE INDEX "elims_attacks_victim_team_idx" ON "elims_team_attacks" USING btree ("victim_team_id");--> statement-breakpoint
CREATE INDEX "elims_attacks_detected_at_idx" ON "elims_team_attacks" USING btree ("detected_at");