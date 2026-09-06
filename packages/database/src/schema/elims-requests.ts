import {
	boolean,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

export interface WhitelistedItem {
	id: string;
	name: string;
	category: string;
	marketPrice?: number;
	image?: string;
}

export interface ElimsItemRequestConfig {
	requestChannelId: string | null;
	grantingChannelId: string | null;
	requesterRoleIds: string[];
	managerRoleIds: string[];
	allowedItems: WhitelistedItem[];
	embedMessageId?: string | null;
	updatedAt: string;
}

export const elimsItemRequests = pgTable("elims_item_requests", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	guildId: text("guild_id").notNull(),
	discordUserId: text("discord_user_id").notNull(),
	discordUsername: text("discord_username").notNull(),
	tornId: integer("torn_id"),
	tornName: text("torn_name"),
	itemId: text("item_id").notNull(),
	itemName: text("item_name").notNull(),
	itemCategory: text("item_category").notNull(),
	quantity: integer("quantity").notNull(),
	status: text("status").default("pending").notNull(), // 'pending' | 'accepted' | 'rejected'
	isTest: boolean("is_test").default(false).notNull(),
	reason: text("reason"),
	requestMessageId: text("request_message_id"),
	grantingMessageId: text("granting_message_id"),
	dmSent: boolean("dm_sent").default(false).notNull(),
	handledByDiscordId: text("handled_by_discord_id"),
	handledByUsername: text("handled_by_username"),
	handledByTornId: integer("handled_by_torn_id"),
	handledByTornName: text("handled_by_torn_name"),
	handledAt: timestamp("handled_at", { withTimezone: true, mode: "date" }),
	metadata: jsonb("metadata"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const elimsVerifiedUsers = pgTable("elims_verified_users", {
	discordId: text("discord_id").primaryKey(),
	tornId: integer("torn_id").notNull(),
	tornName: text("torn_name").notNull(),
	factionId: integer("faction_id"),
	factionTag: text("faction_tag"),
	lastCheckedAt: timestamp("last_checked_at", {
		withTimezone: true,
		mode: "date",
	}),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "date",
	})
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", {
		withTimezone: true,
		mode: "date",
	})
		.defaultNow()
		.notNull(),
});

export const elimsApiKeys = pgTable("elims_api_keys", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	guildId: text("guild_id").notNull(),
	tornId: integer("torn_id").notNull(),
	tornName: text("torn_name").notNull(),
	apiKeyEncrypted: text("api_key_encrypted").notNull(),
	apiKeyHash: text("api_key_hash").notNull(),
	isValid: boolean("is_valid").default(true).notNull(),
	invalidCount: integer("invalid_count").default(0).notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});
