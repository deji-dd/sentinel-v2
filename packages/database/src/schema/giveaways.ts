import {
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export interface ElimsGiveawayConfig {
	announcementChannelId: string | null;
	managerChannelId?: string | null;
	creatorEmbedMessageId?: string | null;
	managerRoleIds: string[];
	blacklistedUserIds?: string[];
	updatedAt: string;
}

export interface GiveawayWinner {
	discordUserId: string;
	discordUsername: string;
	tornId?: number | null;
	tornName?: string | null;
	selectedAt: string;
}

export const giveaways = pgTable("giveaways", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	guildId: text("guild_id").notNull(),
	channelId: text("channel_id").notNull(),
	messageId: text("message_id").notNull(),
	createdByDiscordId: text("created_by_discord_id").notNull(),
	createdByUsername: text("created_by_username").notNull(),
	itemId: text("item_id").notNull(),
	itemName: text("item_name").notNull(),
	itemCategory: text("item_category").notNull(),
	itemCount: integer("item_count").default(1).notNull(),
	winnerCount: integer("winner_count").default(1).notNull(),
	durationStr: text("duration_str").notNull(),
	durationMs: integer("duration_ms").notNull(),
	status: text("status").default("active").notNull(), // 'active' | 'ended' | 'cancelled'
	endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
	winners: jsonb("winners").$type<GiveawayWinner[]>().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const giveawayEntries = pgTable(
	"giveaway_entries",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		giveawayId: text("giveaway_id")
			.notNull()
			.references(() => giveaways.id, { onDelete: "cascade" }),
		discordUserId: text("discord_user_id").notNull(),
		discordUsername: text("discord_username").notNull(),
		tornId: integer("torn_id"),
		tornName: text("torn_name"),
		enteredAt: timestamp("entered_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("giveaway_entry_user_idx").on(
			table.giveawayId,
			table.discordUserId,
		),
	],
);
