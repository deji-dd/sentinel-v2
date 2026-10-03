ALTER TABLE "merc_channel_configs" ADD COLUMN "past_contracts" text;--> statement-breakpoint
ALTER TABLE "merc_contracts" ADD COLUMN "paid_at" timestamp with time zone;