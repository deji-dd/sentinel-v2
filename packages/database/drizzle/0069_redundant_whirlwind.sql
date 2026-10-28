CREATE TABLE "user_shoplifting_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"discord_user_id" text NOT NULL,
	"shop_id" integer NOT NULL,
	"condition" text NOT NULL,
	"condition_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_shoplifting_alerts_user_condition_idx" ON "user_shoplifting_alerts" USING btree ("discord_user_id","condition_key");--> statement-breakpoint
CREATE INDEX "idx_user_shoplifting_alerts_shop" ON "user_shoplifting_alerts" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "idx_user_shoplifting_alerts_user" ON "user_shoplifting_alerts" USING btree ("discord_user_id");