CREATE TABLE "merc_contract_hits" (
	"id" text PRIMARY KEY NOT NULL,
	"contract_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"attack_id" integer NOT NULL,
	"attacker_id" integer NOT NULL,
	"attacker_name" text NOT NULL,
	"defender_id" integer NOT NULL,
	"defender_name" text NOT NULL,
	"result" text NOT NULL,
	"is_stricken" boolean DEFAULT false NOT NULL,
	"payout_value" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merc_contract_hits_attack_id_unique" UNIQUE("attack_id")
);
--> statement-breakpoint
ALTER TABLE "guild_configs" ADD COLUMN "merc_role_id" text;--> statement-breakpoint
ALTER TABLE "merc_contracts" ADD COLUMN "hit_price" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "merc_contracts" ADD COLUMN "stricken_hit_price" integer;--> statement-breakpoint
ALTER TABLE "merc_contracts" ADD COLUMN "war_start_hit_price" integer;--> statement-breakpoint
ALTER TABLE "merc_contracts" ADD COLUMN "war_start_stricken_hit_price" integer;--> statement-breakpoint
ALTER TABLE "merc_contract_hits" ADD CONSTRAINT "merc_contract_hits_contract_id_merc_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."merc_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_merc_hits_contract_id" ON "merc_contract_hits" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "idx_merc_hits_guild_id" ON "merc_contract_hits" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "idx_merc_hits_attacker_id" ON "merc_contract_hits" USING btree ("attacker_id");--> statement-breakpoint
CREATE INDEX "idx_merc_hits_defender_id" ON "merc_contract_hits" USING btree ("defender_id");