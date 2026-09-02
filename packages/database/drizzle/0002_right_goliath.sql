ALTER TABLE "guild_configs" ADD COLUMN "module_verification" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_configs" ADD COLUMN "module_territory" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_configs" ADD COLUMN "module_reaction_roles" boolean DEFAULT true NOT NULL;