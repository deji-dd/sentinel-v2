CREATE TABLE "player_stat_cache" (
	"player_id" integer PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"source" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "player_stat_cache_expires_at_idx" ON "player_stat_cache" USING btree ("expires_at");
