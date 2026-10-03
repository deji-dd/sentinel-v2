ALTER TABLE "merc_channel_configs" ADD COLUMN "revivables" text;--> statement-breakpoint
ALTER TABLE "merc_channel_configs" ADD COLUMN "revivables_message_id" text;--> statement-breakpoint
ALTER TABLE "merc_contracts" ADD COLUMN "revivables_message_id" text;