import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const guildConfigs = pgTable("guild_configs", {
	guildId: text("guild_id").primaryKey(),
	authorized: boolean("authorized").default(true).notNull(),
	moduleVerification: boolean("module_verification").default(true).notNull(),
	moduleTerritory: boolean("module_territory").default(false).notNull(),
	moduleReactionRoles: boolean("module_reaction_roles")
		.default(false)
		.notNull(),
	moduleMonitoring: boolean("module_monitoring").default(false).notNull(),
	moduleGiveaways: boolean("module_giveaways").default(false).notNull(),
	logChannelId: text("log_channel_id"),
	adminRoleIds: jsonb("admin_role_ids").$type<string[]>().default([]).notNull(),
	verifiedRoleIds: jsonb("verified_role_ids")
		.$type<string[]>()
		.default([])
		.notNull(),
	nicknameTemplate: text("nickname_template").default("[{tag}] {name} [{id}]"),
	verifyOnJoin: boolean("verify_on_join").default(false).notNull(),
	verifyCron: boolean("verify_cron").default(false).notNull(),
	verifyCronInterval: integer("verify_cron_interval").default(24).notNull(),
	lastVerifyCronAt: timestamp("last_verify_cron_at", {
		withTimezone: true,
		mode: "date",
	}),
	protectedRoleIds: jsonb("protected_role_ids")
		.$type<string[]>()
		.default([])
		.notNull(),
	factionListChannelId: text("faction_list_channel_id"),
	factionListMessageIds: jsonb("faction_list_message_ids")
		.$type<string[]>()
		.default([])
		.notNull(),
	ttFullChannelId: text("tt_full_channel_id"),
	ttFilteredChannelId: text("tt_filtered_channel_id"),
	ttTerritoryIds: jsonb("tt_territory_ids")
		.$type<string[]>()
		.default([])
		.notNull(),
	ttFactionIds: jsonb("tt_faction_ids").$type<number[]>().default([]).notNull(),
	mercRoleId: text("merc_role_id"),
	mercManagerRoleId: text("merc_manager_role_id"),
	mercDefaultHitPrice: integer("merc_default_hit_price").default(3000000),
	mercDefaultStrickenHitPrice: integer(
		"merc_default_stricken_hit_price",
	).default(4000000),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const reactionRoleMessages = pgTable("reaction_role_messages", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	guildId: text("guild_id").notNull(),
	title: text("title").notNull(),
	channelId: text("channel_id").notNull(),
	messageId: text("message_id").unique(),
	requiredRoleId: text("required_role_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const reactionRoleMappings = pgTable("reaction_role_mappings", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	messageId: text("message_id").notNull(),
	emoji: text("emoji").notNull(),
	roleId: text("role_id").notNull(),
	description: text("description"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const factionRoleMappings = pgTable("faction_role_mappings", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	guildId: text("guild_id").notNull(),
	factionId: integer("faction_id").notNull(),
	factionName: text("faction_name"),
	memberRoleIds: jsonb("member_role_ids")
		.$type<string[]>()
		.default([])
		.notNull(),
	leaderRoleIds: jsonb("leader_role_ids")
		.$type<string[]>()
		.default([])
		.notNull(),
	enabled: boolean("enabled").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const verifiedUsers = pgTable("verified_users", {
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

export const verificationLogs = pgTable(
	"verification_logs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		guildId: text("guild_id").notNull(),
		discordId: text("discord_id").notNull(),
		status: text("status").notNull(),
		triggeredBy: text("triggered_by").default("user").notNull(),
		rolesAdded: jsonb("roles_added").$type<string[]>().default([]).notNull(),
		rolesRemoved: jsonb("roles_removed")
			.$type<string[]>()
			.default([])
			.notNull(),
		oldNickname: text("old_nickname"),
		newNickname: text("new_nickname"),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		// Retention pruning and the recent-logs lookup both filter by created_at.
		index("idx_verification_logs_created_at").on(table.createdAt),
	],
);

export const guildMonitoredFactions = pgTable(
	"guild_monitored_factions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		guildId: text("guild_id").notNull(),
		factionId: integer("faction_id").notNull(),
		factionName: text("faction_name"),
		factionTag: text("faction_tag"),
		revivesEnabled: boolean("revives_enabled").default(true).notNull(),
		revivesChannelId: text("revives_channel_id"),
		revivesMessageIds: jsonb("revives_message_ids")
			.$type<string[]>()
			.default([])
			.notNull(),
		lastRevivesCheckAt: timestamp("last_revives_check_at", {
			withTimezone: true,
			mode: "date",
		}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("guild_monitored_factions_guild_faction_idx").on(
			table.guildId,
			table.factionId,
		),
	],
);

export const guildApiKeys = pgTable(
	"guild_api_keys",
	{
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
		lastInvalidAt: timestamp("last_invalid_at", {
			withTimezone: true,
			mode: "date",
		}),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
		donatedByDiscordId: text("donated_by_discord_id"),
		donatedByDiscordTag: text("donated_by_discord_tag"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_guild_api_keys_guild_id").on(table.guildId),
		index("idx_guild_api_keys_hash").on(table.apiKeyHash),
	],
);
