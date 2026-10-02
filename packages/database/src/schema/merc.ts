import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const mercContracts = pgTable(
	"merc_contracts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		guildId: text("guild_id").notNull(),
		factionId: integer("faction_id").notNull(),
		factionName: text("faction_name").notNull(),
		warStatusAtCreation: text("war_status_at_creation").notNull(), // 'no_war' | 'upcoming' | 'active'
		warId: integer("war_id"),
		warStart: timestamp("war_start", { withTimezone: true, mode: "date" }),
		warEnd: timestamp("war_end", { withTimezone: true, mode: "date" }),
		warTarget: integer("war_target"),
		warOpponentId: integer("war_opponent_id"),
		warOpponentName: text("war_opponent_name"),

		// Timing
		startTime: timestamp("start_time", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		startImmediately: boolean("start_immediately").default(false).notNull(),
		startMinutesBeforeWar: integer("start_minutes_before_war"),
		endTime: timestamp("end_time", { withTimezone: true, mode: "date" }),
		endOnWarEnd: boolean("end_on_war_end").default(false).notNull(),

		// Primary Target Hit Terms
		allowOnline: boolean("allow_online").default(true).notNull(),
		allowIdle: boolean("allow_idle").default(true).notNull(),
		allowOffline: boolean("allow_offline").default(false).notNull(),
		maxIdleMinutes: integer("max_idle_minutes").default(15),
		allowStrickenHits: boolean("allow_stricken_hits").default(false).notNull(),
		minLevel: integer("min_level").default(1).notNull(),
		maxLevel: integer("max_level").default(100).notNull(),

		// Pricing & Payouts
		hitPrice: integer("hit_price").default(0).notNull(),
		strickenHitPrice: integer("stricken_hit_price"),
		autoStopPrice: bigint("auto_stop_price", { mode: "number" }),
		excludedMembers: jsonb("excluded_members")
			.$type<number[]>()
			.default([])
			.notNull(),

		// Pause Windows: [{ pausedAt: string, resumedAt: string | null }]
		// Hits whose attack timestamp falls inside an open or closed window are
		// excluded from payout. Used to keep paused contracts from accruing earnings.
		pausedWindows: jsonb("paused_windows")
			.$type<Array<{ pausedAt: string; resumedAt: string | null }>>()
			.default([])
			.notNull(),

		// War-Start Dynamic Terms (For upcoming wars)
		changeTermsOnWarStart: boolean("change_terms_on_war_start")
			.default(false)
			.notNull(),
		warStartAllowOnline: boolean("war_start_allow_online"),
		warStartAllowIdle: boolean("war_start_allow_idle"),
		warStartAllowOffline: boolean("war_start_allow_offline"),
		warStartMaxIdleMinutes: integer("war_start_max_idle_minutes"),
		warStartAllowStrickenHits: boolean("war_start_allow_stricken_hits"),
		warStartMinLevel: integer("war_start_min_level"),
		warStartMaxLevel: integer("war_start_max_level"),
		warStartHitPrice: integer("war_start_hit_price"),
		warStartStrickenHitPrice: integer("war_start_stricken_hit_price"),

		// Lifecycle & Metadata
		status: text("status").default("active").notNull(), // 'active' | 'upcoming' | 'completed' | 'cancelled'
		clientChannelId: text("client_channel_id"),
		clientDiscordId: text("client_discord_id"),
		upcomingMessageId: text("upcoming_message_id"),
		upcomingChannelId: text("upcoming_channel_id"),
		createdBy: text("created_by"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_merc_contracts_guild_id").on(table.guildId),
		index("idx_merc_contracts_faction_id").on(table.factionId),
		index("idx_merc_contracts_status").on(table.status),
		index("idx_merc_contracts_start_time").on(table.startTime),
	],
);

export type MercContractRow = typeof mercContracts.$inferSelect;
export type NewMercContractRow = typeof mercContracts.$inferInsert;

export const mercContractHits = pgTable(
	"merc_contract_hits",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		contractId: text("contract_id")
			.notNull()
			.references(() => mercContracts.id, { onDelete: "cascade" }),
		guildId: text("guild_id").notNull(),
		// NOTE: intentionally NOT globally unique. The same Torn attack can be
		// credited against more than one contract (e.g. overlapping contracts for
		// the same faction). Uniqueness is enforced per-contract by the composite
		// index below — a global unique constraint silently swallowed inserts via
		// the validator's catch block, starving the newest contract of logs.
		attackId: integer("attack_id").notNull(),
		attackerId: integer("attacker_id").notNull(),
		attackerName: text("attacker_name").notNull(),
		attackerFactionId: integer("attacker_faction_id"),
		attackerFactionName: text("attacker_faction_name"),
		defenderId: integer("defender_id").notNull(),
		defenderName: text("defender_name").notNull(),
		result: text("result").notNull(),
		isStricken: boolean("is_stricken").default(false).notNull(),
		payoutValue: integer("payout_value").notNull(),
		timestamp: timestamp("timestamp", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_merc_hits_contract_id").on(table.contractId),
		index("idx_merc_hits_guild_id").on(table.guildId),
		index("idx_merc_hits_attacker_id").on(table.attackerId),
		index("idx_merc_hits_defender_id").on(table.defenderId),
		uniqueIndex("uq_merc_hits_contract_attack").on(
			table.contractId,
			table.attackId,
		),
	],
);

export type MercContractHitRow = typeof mercContractHits.$inferSelect;
export type NewMercContractHitRow = typeof mercContractHits.$inferInsert;

export const mercChannelConfigs = pgTable("merc_channel_configs", {
	guildId: text("guild_id").primaryKey(),
	contractCreation: text("contract_creation"),
	contractCreationMessageId: text("contract_creation_message_id"),
	upcomingContracts: text("upcoming_contracts"),
	targets: text("targets"),
	mercLog: text("merc_log"),
	clientCategory: text("client_category"),
	archiveCategory: text("archive_category"),
	updatedBy: text("updated_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export type MercChannelConfigRow = typeof mercChannelConfigs.$inferSelect;
export type NewMercChannelConfigRow = typeof mercChannelConfigs.$inferInsert;

export const mercContractTokens = pgTable(
	"merc_contract_tokens",
	{
		token: text("token")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		guildId: text("guild_id").notNull(),
		channelId: text("channel_id"),
		discordUserId: text("discord_user_id").notNull(),
		discordUsername: text("discord_username"),
		factionId: integer("faction_id").notNull(),
		factionName: text("faction_name"),
		used: boolean("used").default(false).notNull(),
		archived: boolean("archived").default(false).notNull(),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_merc_tokens_expires").on(table.expiresAt),
		index("idx_merc_tokens_user").on(table.discordUserId),
		index("idx_merc_tokens_cleanup").on(
			table.used,
			table.archived,
			table.expiresAt,
		),
	],
);

export type MercContractTokenRow = typeof mercContractTokens.$inferSelect;
export type NewMercContractTokenRow = typeof mercContractTokens.$inferInsert;
