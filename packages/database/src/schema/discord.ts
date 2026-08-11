import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const guildConfigs = sqliteTable("guild_configs", {
	guildId: text("guild_id").primaryKey(),
	logChannelId: text("log_channel_id"),
	adminRoleIds: text("admin_role_ids", { mode: "json" })
		.$type<string[]>()
		.default([])
		.notNull(),
	enabledModules: text("enabled_modules", { mode: "json" })
		.$type<string[]>()
		.default([])
		.notNull(),
	verifiedRoleIds: text("verified_role_ids", { mode: "json" })
		.$type<string[]>()
		.default([])
		.notNull(),
	nicknameTemplate: text("nickname_template").default("[{tag}] {name} [{id}]"),
	verifyOnJoin: integer("verify_on_join", { mode: "boolean" })
		.default(false)
		.notNull(),
	verifyCron: integer("verify_cron", { mode: "boolean" })
		.default(false)
		.notNull(),
	verifyCronInterval: integer("verify_cron_interval").default(24).notNull(),
	lastVerifyCronAt: integer("last_verify_cron_at", { mode: "timestamp" }),
	protectedRoleIds: text("protected_role_ids", { mode: "json" })
		.$type<string[]>()
		.default([])
		.notNull(),
	factionListChannelId: text("faction_list_channel_id"),
	factionListMessageIds: text("faction_list_message_ids", { mode: "json" })
		.$type<string[]>()
		.default([])
		.notNull(),
	ttFullChannelId: text("tt_full_channel_id"),
	ttFilteredChannelId: text("tt_filtered_channel_id"),
	ttTerritoryIds: text("tt_territory_ids", { mode: "json" })
		.$type<string[]>()
		.default([])
		.notNull(),
	ttFactionIds: text("tt_faction_ids", { mode: "json" })
		.$type<number[]>()
		.default([])
		.notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const reactionRoleMessages = sqliteTable("reaction_role_messages", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	guildId: text("guild_id").notNull(),
	title: text("title").notNull(),
	channelId: text("channel_id").notNull(),
	messageId: text("message_id").unique(),
	requiredRoleId: text("required_role_id"),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const reactionRoleMappings = sqliteTable("reaction_role_mappings", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	messageId: text("message_id").notNull(),
	emoji: text("emoji").notNull(),
	roleId: text("role_id").notNull(),
	description: text("description"),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const guildApiKeys = sqliteTable("guild_api_keys", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	guildId: text("guild_id").notNull(),
	userId: integer("user_id"),
	apiKeyEncrypted: text("api_key_encrypted").notNull(),
	apiKeyHash: text("api_key_hash").notNull().unique(),
	providedBy: text("provided_by"),
	isValid: integer("is_valid", { mode: "boolean" }).default(true).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const factionRoleMappings = sqliteTable("faction_role_mappings", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	guildId: text("guild_id").notNull(),
	factionId: integer("faction_id").notNull(),
	factionName: text("faction_name"),
	memberRoleIds: text("member_role_ids", { mode: "json" })
		.$type<string[]>()
		.default([])
		.notNull(),
	leaderRoleIds: text("leader_role_ids", { mode: "json" })
		.$type<string[]>()
		.default([])
		.notNull(),
	enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const verifiedUsers = sqliteTable("verified_users", {
	discordId: text("discord_id").primaryKey(),
	tornId: integer("torn_id").notNull(),
	tornName: text("torn_name").notNull(),
	factionId: integer("faction_id"),
	factionTag: text("faction_tag"),
	lastCheckedAt: integer("last_checked_at", { mode: "timestamp" }),
	createdAt: integer("created_at", { mode: "timestamp" }),
	updatedAt: integer("updated_at", { mode: "timestamp" }),
});

export const verificationLogs = sqliteTable("verification_logs", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	guildId: text("guild_id").notNull(),
	discordId: text("discord_id").notNull(),
	status: text("status").notNull(),
	triggeredBy: text("triggered_by").default("user").notNull(),
	rolesAdded: text("roles_added", { mode: "json" })
		.$type<string[]>()
		.default([])
		.notNull(),
	rolesRemoved: text("roles_removed", { mode: "json" })
		.$type<string[]>()
		.default([])
		.notNull(),
	oldNickname: text("old_nickname"),
	newNickname: text("new_nickname"),
	error: text("error"),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});
