CREATE TABLE "subversive_rw_display_messages" (
	"faction_id" integer NOT NULL,
	"category" text NOT NULL,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subversive_rw_display_messages_faction_id_category_pk" PRIMARY KEY("faction_id","category")
);
--> statement-breakpoint
ALTER TABLE "subversive_rw_display_messages" ADD CONSTRAINT "subversive_rw_display_messages_faction_id_subversive_rw_channel_configs_faction_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."subversive_rw_channel_configs"("faction_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_subversive_rw_display_messages_faction" ON "subversive_rw_display_messages" USING btree ("faction_id");