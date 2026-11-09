import {
	bigint,
	bigserial,
	boolean,
	index,
	integer,
	pgSequence,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

/**
 * Chat is the Subversive family's own chat server, embedded in Torn's chat bar
 * by the userscript. It replaces the Cloudflare-hosted "Torn Rooms" backend
 * with the Sentinel Postgres database, so the data never leaves our server.
 *
 * Identity is deliberately not duplicated here: a chat account is an active
 * row in `subversive_target_finder_users`, the same session the rest of the
 * userscript authenticates with. This table only holds chat-specific state
 * (avatar consent and a site-wide ban flag).
 */
export const chatUserSettings = pgTable("chat_user_settings", {
	tornId: integer("torn_id").primaryKey(),
	/** Torn profile picture URL, kept only while `showAvatar` is true. */
	avatarUrl: text("avatar_url"),
	showAvatar: boolean("show_avatar").default(false).notNull(),
	/** Site-wide chat ban; separate from any per-room ban. */
	banned: boolean("banned").default(false).notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export type ChatUserSettings = typeof chatUserSettings.$inferSelect;
export type NewChatUserSettings = typeof chatUserSettings.$inferInsert;

/**
 * Per-message reaction cursor. Every reaction change stamps the message with
 * the next value of this sequence. Polling clients send the last value they saw
 * so they can catch up on reaction changes without receiving every message
 * again.
 */
export const chatReactionSequence = pgSequence("chat_reaction_seq");

export const chatRooms = pgTable(
	"chat_rooms",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		description: text("description").default("").notNull(),
		topic: text("topic").default("").notNull(),
		/** One of Torn's room icon names; empty is the default chats icon. */
		icon: text("icon").default("").notNull(),
		/** `#rrggbb`, or empty for Torn's default grey. */
		color: text("color").default("").notNull(),
		/** "private" (invite only) or "public" (anyone may join). */
		visibility: text("visibility").default("private").notNull(),
		/** "everyone" or "admins". */
		postPolicy: text("post_policy").default("everyone").notNull(),
		showFactionTags: boolean("show_faction_tags").default(false).notNull(),
		ownerId: integer("owner_id").notNull(),
		/** Denormalised newest message id; 0 when the room is empty. */
		lastMessageId: bigint("last_message_id", { mode: "number" })
			.default(0)
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_chat_rooms_visibility").on(table.visibility),
		index("idx_chat_rooms_owner").on(table.ownerId),
	],
);

export type ChatRoom = typeof chatRooms.$inferSelect;
export type NewChatRoom = typeof chatRooms.$inferInsert;

/** A player or whole faction invited to a private room. */
export const chatRoomGrants = pgTable(
	"chat_room_grants",
	{
		roomId: text("room_id")
			.notNull()
			.references(() => chatRooms.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(), // 'player' | 'faction'
		targetId: integer("target_id").notNull(),
		label: text("label").default("").notNull(),
		addedBy: integer("added_by").notNull(),
		addedAt: timestamp("added_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.roomId, table.kind, table.targetId] }),
		index("idx_chat_grants_target").on(table.kind, table.targetId),
	],
);

export type ChatRoomGrant = typeof chatRoomGrants.$inferSelect;

export const chatRoomAdmins = pgTable(
	"chat_room_admins",
	{
		roomId: text("room_id")
			.notNull()
			.references(() => chatRooms.id, { onDelete: "cascade" }),
		tornId: integer("torn_id").notNull(),
		addedBy: integer("added_by").notNull(),
		addedAt: timestamp("added_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.roomId, table.tornId] }),
		index("idx_chat_admins_user").on(table.tornId),
	],
);

export const chatRoomBans = pgTable(
	"chat_room_bans",
	{
		roomId: text("room_id")
			.notNull()
			.references(() => chatRooms.id, { onDelete: "cascade" }),
		tornId: integer("torn_id").notNull(),
		label: text("label").default("").notNull(),
		bannedBy: integer("banned_by").notNull(),
		bannedAt: timestamp("banned_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.roomId, table.tornId] }),
		index("idx_chat_bans_user").on(table.tornId),
	],
);

export const chatRoomMemberships = pgTable(
	"chat_room_memberships",
	{
		roomId: text("room_id")
			.notNull()
			.references(() => chatRooms.id, { onDelete: "cascade" }),
		tornId: integer("torn_id").notNull(),
		/** "joined" or "left": a left room stays hidden until invited again. */
		state: text("state").default("joined").notNull(),
		lastReadId: bigint("last_read_id", { mode: "number" }).default(0).notNull(),
		joinedAt: timestamp("joined_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.roomId, table.tornId] }),
		index("idx_chat_memberships_user").on(table.tornId, table.state),
	],
);

export type ChatRoomMembership = typeof chatRoomMemberships.$inferSelect;

export const chatMessages = pgTable(
	"chat_messages",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		roomId: text("room_id")
			.notNull()
			.references(() => chatRooms.id, { onDelete: "cascade" }),
		userId: integer("user_id").notNull(),
		/** Name and faction tag as they were when the message was posted. */
		name: text("name").notNull(),
		avatarUrl: text("avatar_url"),
		factionTag: text("faction_tag"),
		body: text("body").default("").notNull(),
		/** Optional GIF attachment. Only URLs from the provider allow-list are stored. */
		gifUrl: text("gif_url"),
		gifWidth: integer("gif_width"),
		gifHeight: integer("gif_height"),
		gifTitle: text("gif_title"),
		isDeleted: boolean("is_deleted").default(false).notNull(),
		/** Global sequence value of the last reaction change; 0 when none. */
		reactionSeq: bigint("reaction_seq", { mode: "number" })
			.default(0)
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_chat_messages_room").on(table.roomId, table.id),
		index("idx_chat_messages_reaction_seq").on(table.reactionSeq),
		index("idx_chat_messages_user").on(table.userId),
	],
);

export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;

export const chatMessageReactions = pgTable(
	"chat_message_reactions",
	{
		messageId: bigint("message_id", { mode: "number" })
			.notNull()
			.references(() => chatMessages.id, { onDelete: "cascade" }),
		roomId: text("room_id")
			.notNull()
			.references(() => chatRooms.id, { onDelete: "cascade" }),
		userId: integer("user_id").notNull(),
		emoji: text("emoji").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.messageId, table.userId, table.emoji] }),
		index("idx_chat_reactions_room").on(table.roomId, table.messageId),
	],
);

export const chatMessageMentions = pgTable(
	"chat_message_mentions",
	{
		messageId: bigint("message_id", { mode: "number" })
			.notNull()
			.references(() => chatMessages.id, { onDelete: "cascade" }),
		roomId: text("room_id")
			.notNull()
			.references(() => chatRooms.id, { onDelete: "cascade" }),
		userId: integer("user_id").notNull(),
		name: text("name").notNull(),
		seen: boolean("seen").default(false).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.messageId, table.userId] }),
		index("idx_chat_mentions_inbox").on(table.userId, table.roomId, table.seen),
	],
);
