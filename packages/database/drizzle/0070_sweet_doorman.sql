CREATE SEQUENCE "public"."chat_reaction_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "chat_message_mentions" (
	"message_id" bigint NOT NULL,
	"room_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_mentions_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_message_reactions" (
	"message_id" bigint NOT NULL,
	"room_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"faction_tag" text,
	"body" text DEFAULT '' NOT NULL,
	"gif_url" text,
	"gif_width" integer,
	"gif_height" integer,
	"gif_title" text,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"reaction_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_room_admins" (
	"room_id" text NOT NULL,
	"torn_id" integer NOT NULL,
	"added_by" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_room_admins_room_id_torn_id_pk" PRIMARY KEY("room_id","torn_id")
);
--> statement-breakpoint
CREATE TABLE "chat_room_bans" (
	"room_id" text NOT NULL,
	"torn_id" integer NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"banned_by" integer NOT NULL,
	"banned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_room_bans_room_id_torn_id_pk" PRIMARY KEY("room_id","torn_id")
);
--> statement-breakpoint
CREATE TABLE "chat_room_grants" (
	"room_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" integer NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"added_by" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_room_grants_room_id_kind_target_id_pk" PRIMARY KEY("room_id","kind","target_id")
);
--> statement-breakpoint
CREATE TABLE "chat_room_memberships" (
	"room_id" text NOT NULL,
	"torn_id" integer NOT NULL,
	"state" text DEFAULT 'joined' NOT NULL,
	"last_read_id" bigint DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_room_memberships_room_id_torn_id_pk" PRIMARY KEY("room_id","torn_id")
);
--> statement-breakpoint
CREATE TABLE "chat_rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"post_policy" text DEFAULT 'everyone' NOT NULL,
	"show_faction_tags" boolean DEFAULT false NOT NULL,
	"owner_id" integer NOT NULL,
	"last_message_id" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_user_settings" (
	"torn_id" integer PRIMARY KEY NOT NULL,
	"avatar_url" text,
	"show_avatar" boolean DEFAULT false NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_message_mentions" ADD CONSTRAINT "chat_message_mentions_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_mentions" ADD CONSTRAINT "chat_message_mentions_room_id_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_reactions" ADD CONSTRAINT "chat_message_reactions_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_reactions" ADD CONSTRAINT "chat_message_reactions_room_id_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_room_id_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_room_admins" ADD CONSTRAINT "chat_room_admins_room_id_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_room_bans" ADD CONSTRAINT "chat_room_bans_room_id_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_room_grants" ADD CONSTRAINT "chat_room_grants_room_id_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_room_memberships" ADD CONSTRAINT "chat_room_memberships_room_id_chat_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."chat_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_mentions_inbox" ON "chat_message_mentions" USING btree ("user_id","room_id","seen");--> statement-breakpoint
CREATE INDEX "idx_chat_reactions_room" ON "chat_message_reactions" USING btree ("room_id","message_id");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_room" ON "chat_messages" USING btree ("room_id","id");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_reaction_seq" ON "chat_messages" USING btree ("reaction_seq");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_user" ON "chat_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_chat_admins_user" ON "chat_room_admins" USING btree ("torn_id");--> statement-breakpoint
CREATE INDEX "idx_chat_bans_user" ON "chat_room_bans" USING btree ("torn_id");--> statement-breakpoint
CREATE INDEX "idx_chat_grants_target" ON "chat_room_grants" USING btree ("kind","target_id");--> statement-breakpoint
CREATE INDEX "idx_chat_memberships_user" ON "chat_room_memberships" USING btree ("torn_id","state");--> statement-breakpoint
CREATE INDEX "idx_chat_rooms_visibility" ON "chat_rooms" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "idx_chat_rooms_owner" ON "chat_rooms" USING btree ("owner_id");