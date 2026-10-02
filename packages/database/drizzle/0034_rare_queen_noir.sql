ALTER TABLE "merc_contract_hits" DROP CONSTRAINT IF EXISTS "merc_contract_hits_attack_id_unique";--> statement-breakpoint
ALTER TABLE "merc_contract_hits" ADD COLUMN IF NOT EXISTS "attacker_faction_id" integer;--> statement-breakpoint
ALTER TABLE "merc_contract_hits" ADD COLUMN IF NOT EXISTS "attacker_faction_name" text;--> statement-breakpoint
ALTER TABLE "merc_contracts" ADD COLUMN IF NOT EXISTS "excluded_members" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "merc_contracts" ADD COLUMN IF NOT EXISTS "paused_windows" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_merc_hits_contract_attack" ON "merc_contract_hits" USING btree ("contract_id","attack_id");