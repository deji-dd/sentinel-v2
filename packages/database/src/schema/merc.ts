import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
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
		// Optional floor on how long a target must have been offline before it
		// qualifies. Deliberately nullable with no default: NULL means "no
		// minimum", so every pre-existing contract keeps alerting on any offline
		// target until an operator opts into a duration.
		minOfflineMinutes: integer("min_offline_minutes"),
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
		warStartMinOfflineMinutes: integer("war_start_min_offline_minutes"),
		warStartAllowStrickenHits: boolean("war_start_allow_stricken_hits"),
		warStartMinLevel: integer("war_start_min_level"),
		warStartMaxLevel: integer("war_start_max_level"),
		warStartHitPrice: integer("war_start_hit_price"),
		warStartStrickenHitPrice: integer("war_start_stricken_hit_price"),

		// Lifecycle & Metadata
		status: text("status").default("active").notNull(), // 'active' | 'upcoming' | 'completed' | 'cancelled'
		// Settlement: set once an admin marks a concluded contract as paid.
		// Nullable rather than a boolean so "unpaid" is simply paidAt IS NULL,
		// which needs no backfill and no risk of the two columns disagreeing.
		// Only ever set on 'completed' contracts.
		paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
		clientChannelId: text("client_channel_id"),
		clientDiscordId: text("client_discord_id"),
		upcomingMessageId: text("upcoming_message_id"),
		upcomingChannelId: text("upcoming_channel_id"),
		revivablesMessageId: text("revivables_message_id"),
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
	revivables: text("revivables"),
	revivablesMessageId: text("revivables_message_id"),
	mercLog: text("merc_log"),
	// Alerts posted when a concluded contract is marked as paid.
	pastContracts: text("past_contracts"),
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

/**
 * Faction master API keys registered against a Mercenary guild.
 *
 * Replaces the `merc:master_keys:<guildId>` rows in the legacy `system_states`
 * blob table, which stored this as a single JSON object keyed by faction id and
 * had to be read, spread and written back in full on every change. This is
 * plainly relational data — one row per faction — so it belongs in rows: the
 * "only one master key per faction" rule is now the primary key rather than a
 * check in application code, and registering or removing a key touches exactly
 * one row instead of rewriting the map for every faction.
 *
 * `keyId` references {@link ./discord.guildApiKeys} — the encrypted key itself
 * is never held here.
 */
export const mercMasterKeys = pgTable(
	"merc_master_keys",
	{
		guildId: text("guild_id").notNull(),
		/** Torn faction the master key belongs to. */
		factionId: integer("faction_id").notNull(),
		/** Row id in `guild_api_keys` holding the encrypted key. */
		keyId: text("key_id").notNull(),
		factionName: text("faction_name"),
		/** Torn user who donated the key. */
		tornId: integer("torn_id"),
		tornName: text("torn_name"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		// One master key per faction per guild — the rule the old map enforced
		// in application code, now enforced by the database.
		primaryKey({
			name: "merc_master_keys_guild_id_faction_id_pk",
			columns: [table.guildId, table.factionId],
		}),
		index("idx_merc_master_keys_key_id").on(table.keyId),
	],
);

export type MercMasterKeyRow = typeof mercMasterKeys.$inferSelect;
export type NewMercMasterKeyRow = typeof mercMasterKeys.$inferInsert;

/**
 * Live mercenary target alerts: which targets the contract worker has posted,
 * and who has claimed them.
 *
 * Replaces part of the `merc:active_state` row in the legacy `system_states`
 * blob, which held this list — plus two tracker maps — as one JSON object
 * rewritten in full on every change. The worker keeps everything in RAM and
 * persists so a redeploy does not lose claims: without it, mercenaries lost
 * claims they were holding and duplicate alerts were posted next to the
 * orphaned originals.
 *
 * The in-memory store is a `Map<"contractId:targetId", alert>`, so the composite
 * primary key matches the key the worker already looks up by.
 *
 * Epoch columns are `bigint` with the unit recorded per column: the worker does
 * arithmetic on these values against `Date.now()`, and Torn reports some in
 * seconds and some in milliseconds, so integers keep the semantics exactly as
 * they were rather than adding a conversion at every read.
 */
export const mercActiveAlerts = pgTable(
	"merc_active_alerts",
	{
		contractId: text("contract_id").notNull(),
		targetId: integer("target_id").notNull(),
		guildId: text("guild_id").notNull(),
		/** Discord channel the alert was posted into. */
		channelName: text("channel_name").notNull(),
		targetName: text("target_name").notNull(),
		targetLevel: integer("target_level").notNull(),
		estimatedBs: bigint("estimated_bs", { mode: "number" })
			.default(0)
			.notNull(),
		/** `open` until a mercenary claims it. */
		status: text("status").notNull(),
		claimedByDiscordId: text("claimed_by_discord_id"),
		claimedByDiscordTag: text("claimed_by_discord_tag"),
		claimedByTornId: integer("claimed_by_torn_id"),
		claimedByTornName: text("claimed_by_torn_name"),
		/** Epoch MILLISECONDS the claim was taken. */
		claimedAt: bigint("claimed_at", { mode: "number" }),
		/** Discord snowflake of the posted alert message. */
		messageId: text("message_id"),
		/** Epoch MILLISECONDS the alert was last (re)posted. */
		lastAlertAt: bigint("last_alert_at", { mode: "number" }).notNull(),
		isStrickenEligible: boolean("is_stricken_eligible")
			.default(false)
			.notNull(),
		/**
		 * Epoch SECONDS the target is hospitalised until. Nullable on both sides:
		 * the alert carried `undefined` and `null` distinctly in the blob, and
		 * every reader treats them the same (`?? 0`), so the distinction is not
		 * preserved here.
		 */
		hospitalUntil: bigint("hospital_until", { mode: "number" }),
		/** Epoch SECONDS the 60-second ranked-war immunity expires. */
		rwCooldownUntil: bigint("rw_cooldown_until", { mode: "number" }),
		wasInHospital: boolean("was_in_hospital"),
		/** Epoch SECONDS the target was first seen out of hospital. */
		hospitalExitTime: bigint("hospital_exit_time", { mode: "number" }),
		/** Epoch MILLISECONDS the RW cooldown lock was taken. */
		lockStartedAt: bigint("lock_started_at", { mode: "number" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({
			name: "merc_active_alerts_contract_id_target_id_pk",
			columns: [table.contractId, table.targetId],
		}),
		index("idx_merc_active_alerts_contract").on(table.contractId),
	],
);

export type MercActiveAlertRow = typeof mercActiveAlerts.$inferSelect;
export type NewMercActiveAlertRow = typeof mercActiveAlerts.$inferInsert;

/**
 * Hospital bookkeeping per mercenary target, keyed `contractId:targetId`.
 *
 * Split out from the alert because the worker tracks hospital state for targets
 * it has not (or no longer) posted an alert for, and the two maps are
 * independently added to and cleared.
 */
export const mercHospitalTrackers = pgTable(
	"merc_hospital_trackers",
	{
		contractId: text("contract_id").notNull(),
		targetId: integer("target_id").notNull(),
		wasInHospital: boolean("was_in_hospital").notNull(),
		/** Epoch SECONDS the target is hospitalised until. */
		hospitalUntil: bigint("hospital_until", { mode: "number" }),
		/** Epoch SECONDS the target was first seen out of hospital. */
		hospitalExitTime: bigint("hospital_exit_time", { mode: "number" }),
		/** Epoch SECONDS this hospital state was last observed. */
		lastSeenHospSec: bigint("last_seen_hosp_sec", { mode: "number" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({
			name: "merc_hospital_trackers_contract_id_target_id_pk",
			columns: [table.contractId, table.targetId],
		}),
	],
);

export type MercHospitalTrackerRow = typeof mercHospitalTrackers.$inferSelect;
export type NewMercHospitalTrackerRow =
	typeof mercHospitalTrackers.$inferInsert;

/**
 * When each mercenary target was last seen offline, keyed `contractId:targetId`.
 *
 * The value is a single epoch-seconds timestamp, but it is a per-target entry in
 * a growing map, so it gets rows rather than a JSON object.
 */
export const mercOfflineTrackers = pgTable(
	"merc_offline_trackers",
	{
		contractId: text("contract_id").notNull(),
		targetId: integer("target_id").notNull(),
		/** Epoch SECONDS the target was last observed offline. */
		lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({
			name: "merc_offline_trackers_contract_id_target_id_pk",
			columns: [table.contractId, table.targetId],
		}),
	],
);

export type MercOfflineTrackerRow = typeof mercOfflineTrackers.$inferSelect;
export type NewMercOfflineTrackerRow = typeof mercOfflineTrackers.$inferInsert;
