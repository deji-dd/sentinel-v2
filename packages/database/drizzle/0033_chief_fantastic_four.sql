ALTER TABLE "guild_configs" ALTER COLUMN "module_verification" SET DEFAULT true;--> statement-breakpoint
UPDATE "guild_configs" SET "module_verification" = true WHERE "module_verification" = false;