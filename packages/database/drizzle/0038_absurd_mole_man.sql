ALTER TABLE "subversive_target_finder_users" ADD COLUMN "faction_id" integer DEFAULT 2013 NOT NULL;--> statement-breakpoint
ALTER TABLE "subversive_target_finder_users" ADD COLUMN "faction_name" text;--> statement-breakpoint
CREATE INDEX "idx_subversive_tf_users_faction" ON "subversive_target_finder_users" USING btree ("faction_id");