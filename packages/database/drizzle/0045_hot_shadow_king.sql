CREATE INDEX "idx_api_keys_valid_type" ON "api_keys" USING btree ("is_valid","key_type");--> statement-breakpoint
CREATE INDEX "idx_verification_logs_created_at" ON "verification_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_personal_logs_log_timestamp" ON "personal_logs" USING btree ("log","timestamp");--> statement-breakpoint
CREATE INDEX "idx_faction_attack_logs_created_at" ON "faction_attack_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_system_metrics_created_at" ON "system_metrics" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_war_ledgers_open" ON "war_ledgers" USING btree ("end_time") WHERE "war_ledgers"."end_time" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_war_ledgers_end_time" ON "war_ledgers" USING btree ("end_time");