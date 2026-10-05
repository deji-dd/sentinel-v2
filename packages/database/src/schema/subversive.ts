import {
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const subversiveRankedWars = pgTable(
	"subversive_ranked_wars",
	{
		id: integer("id").primaryKey(), // Torn Ranked War ID
		start: timestamp("start", { withTimezone: true, mode: "date" }),
		end: timestamp("end", { withTimezone: true, mode: "date" }),
		target: integer("target").default(0).notNull(),
		winnerFactionId: integer("winner_faction_id"),
		forfeit: boolean("forfeit").default(false).notNull(),
		isTermed: boolean("is_termed").default(false).notNull(),
		termedReason: text("termed_reason"),
		status: text("status").default("processed").notNull(), // 'processed' | 'dropped_forfeit' | 'dropped_termed' | 'error'
		candidateCount: integer("candidate_count").default(0).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		evaluatedAt: timestamp("evaluated_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_subversive_wars_status").on(table.status),
		index("idx_subversive_wars_end").on(table.end),
	],
);

export type SubversiveRankedWar = typeof subversiveRankedWars.$inferSelect;
export type NewSubversiveRankedWar = typeof subversiveRankedWars.$inferInsert;

/**
 * Canonical, deduplicated stream of `/v2/faction/attacks` for the Subversive
 * family factions. The attack feed worker is the only writer; the merc hit
 * validator and the retal tracker are read-only consumers.
 *
 * Rows survive scheduler restarts so a restarted worker can rebuild its
 * in-memory windows from history instead of losing them, and the unique index
 * on (faction_id, attack_id) makes replaying a page free.
 */
export const factionAttackLogs = pgTable(
	"faction_attack_logs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		// Torn attack id. Unique per faction feed rather than globally, because
		// the same attack can legitimately appear on more than one family faction.
		attackId: integer("attack_id").notNull(),
		/** Family faction whose master key surfaced this attack (2013 / 27312). */
		factionId: integer("faction_id").notNull(),
		/** 'incoming' = faction members were attacked, 'outgoing' = they attacked. */
		direction: text("direction").notNull(),
		attackerId: integer("attacker_id"),
		attackerName: text("attacker_name"),
		attackerFactionId: integer("attacker_faction_id"),
		attackerFactionName: text("attacker_faction_name"),
		defenderId: integer("defender_id").notNull(),
		defenderName: text("defender_name"),
		defenderFactionId: integer("defender_faction_id"),
		defenderFactionName: text("defender_faction_name"),
		result: text("result"),
		attackCode: text("attack_code"),
		isRankedWar: boolean("is_ranked_war").default(false).notNull(),
		/** Finishing hit carried the Stricken weapon bonus (merc premium price). */
		isStricken: boolean("is_stricken").default(false).notNull(),
		/** Unix seconds. */
		startedAt: integer("started_at"),
		/** Unix seconds. Null while the attack is still in progress. */
		endedAt: integer("ended_at"),
		/** Master key row id that ingested this attack, for per-key debugging. */
		sourceKeyId: text("source_key_id"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("uq_faction_attack_logs_faction_attack").on(
			table.factionId,
			table.attackId,
		),
		index("idx_faction_attack_logs_faction_direction").on(
			table.factionId,
			table.direction,
		),
		index("idx_faction_attack_logs_ended_at").on(table.endedAt),
		// Retention pruning deletes by created_at in batches; without this index
		// each batch seq-scans the table holding 7 days of every faction's attacks.
		index("idx_faction_attack_logs_created_at").on(table.createdAt),
		index("idx_faction_attack_logs_attacker_id").on(table.attackerId),
		index("idx_faction_attack_logs_defender_faction").on(
			table.defenderFactionId,
			table.endedAt,
		),
	],
);

export type FactionAttackLogRow = typeof factionAttackLogs.$inferSelect;
export type NewFactionAttackLogRow = typeof factionAttackLogs.$inferInsert;

export const subversiveRecruitmentCandidates = pgTable(
	"subversive_recruitment_candidates",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		playerId: integer("player_id").notNull(),
		playerName: text("player_name").notNull(),
		playerLevel: integer("player_level").default(1).notNull(),
		factionId: integer("faction_id").notNull(),
		factionName: text("faction_name").notNull(),
		warId: integer("war_id").notNull(),
		attacks: integer("attacks").default(0).notNull(),
		factionTotalAttacks: integer("faction_total_attacks").default(0).notNull(),
		attackPercentage: doublePrecision("attack_percentage").default(0).notNull(),
		score: doublePrecision("score").default(0).notNull(),
		estimatedStats: jsonb("estimated_stats").$type<{
			bsEstimate: number | null;
			fairFight: number | null;
			source?: string | null;
			humanEstimate?: string | null;
			lastUpdated?: number | null;
			distribution?: Record<string, unknown> | null;
		}>(),
		status: text("status").default("new").notNull(), // 'new' | 'contacted' | 'rejected' | 'recruited'
		notified: boolean("notified").default(false).notNull(),
		notifiedAt: timestamp("notified_at", {
			withTimezone: true,
			mode: "date",
		}),
		notes: text("notes"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_subversive_candidates_player_id").on(table.playerId),
		index("idx_subversive_candidates_war_id").on(table.warId),
		index("idx_subversive_candidates_status").on(table.status),
		index("idx_subversive_candidates_created_at").on(table.createdAt),
	],
);

export type SubversiveRecruitmentCandidate =
	typeof subversiveRecruitmentCandidates.$inferSelect;
export type NewSubversiveRecruitmentCandidate =
	typeof subversiveRecruitmentCandidates.$inferInsert;

export const subversiveApiKeys = pgTable(
	"subversive_api_keys",
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
		donatedByDiscordId: text("donated_by_discord_id"),
		donatedByDiscordTag: text("donated_by_discord_tag"),
		lastUsedAt: timestamp("last_used_at", {
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
		index("idx_subversive_keys_guild_id").on(table.guildId),
		index("idx_subversive_keys_torn_id").on(table.tornId),
	],
);

export type SubversiveApiKey = typeof subversiveApiKeys.$inferSelect;
export type NewSubversiveApiKey = typeof subversiveApiKeys.$inferInsert;

export const subversiveTargetFinderUsers = pgTable(
	"subversive_target_finder_users",
	{
		tornId: integer("torn_id").primaryKey(),
		tornName: text("torn_name").notNull(),
		// Family faction the user belongs to (2013 Subversive Alliance, 27312 SA Succession).
		// Defaults to 2013 so pre-migration rows keep working.
		factionId: integer("faction_id").default(2013).notNull(),
		factionName: text("faction_name"),
		apiKeyEncrypted: text("api_key_encrypted").notNull(),
		apiKeyHash: text("api_key_hash").notNull(),
		bsScore: doublePrecision("bs_score").default(0).notNull(),
		battleStats: jsonb("battle_stats").$type<{
			strength: number;
			speed: number;
			defense: number;
			dexterity: number;
			total: number;
		}>(),
		statsCachedAt: timestamp("stats_cached_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		isActive: boolean("is_active").default(true).notNull(),
		lastSeenAt: timestamp("last_seen_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
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
	},
	(table) => [
		index("idx_subversive_tf_users_hash").on(table.apiKeyHash),
		index("idx_subversive_tf_users_faction").on(table.factionId),
	],
);

export type SubversiveTargetFinderUser =
	typeof subversiveTargetFinderUsers.$inferSelect;
export type NewSubversiveTargetFinderUser =
	typeof subversiveTargetFinderUsers.$inferInsert;

export const subversiveTargetFinderTargets = pgTable(
	"subversive_target_finder_targets",
	{
		targetId: integer("target_id").primaryKey(),
		name: text("name").notNull(),
		level: integer("level").default(1).notNull(),
		factionId: integer("faction_id"),
		factionName: text("faction_name"),
		daysOld: integer("days_old").default(0).notNull(),
		lastAction: timestamp("last_action", {
			withTimezone: true,
			mode: "date",
		}),
		isInactive: boolean("is_inactive").default(false).notNull(),
		isFactionless: boolean("is_factionless").default(false).notNull(),
		inHospital: boolean("in_hospital").default(false).notNull(),
		hospitalUntil: timestamp("hospital_until", {
			withTimezone: true,
			mode: "date",
		}),
		estimatedBs: doublePrecision("estimated_bs").default(0).notNull(),
		estimatedScore: doublePrecision("estimated_score").default(0).notNull(),
		status: text("status").default("okay").notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_subversive_tf_targets_score").on(table.estimatedScore),
		// Single-column indexes on the low-cardinality boolean flags
		// (`is_factionless`, `is_inactive`) used to live here too. `pg_stat_user_indexes`
		// showed zero scans over the database's entire lifetime while this table takes
		// millions of updates, so each one was pure write and vacuum cost. `in_hospital`
		// is retained: it has measurable scans.
		index("idx_subversive_tf_targets_hosp").on(table.inHospital),
		index("idx_subversive_tf_targets_level").on(table.level),
	],
);

export type SubversiveTargetFinderTarget =
	typeof subversiveTargetFinderTargets.$inferSelect;
export type NewSubversiveTargetFinderTarget =
	typeof subversiveTargetFinderTargets.$inferInsert;

/**
 * Hospital dibs settings, one row per Subversive family faction (2013 / 27312).
 *
 * Each faction runs its own ranked war, so its rules — lead time, per-member
 * claim cap, Discord channel and maintenance cadence — are stored separately.
 * Defaults here are the factory defaults; the dashboard only writes a row once
 * an admin actually saves.
 */
export const subversiveDibsConfigs = pgTable("subversive_dibs_configs", {
	/** Family faction these settings apply to (2013 / 27312). */
	factionId: integer("faction_id").primaryKey(),
	enabled: boolean("enabled").default(true).notNull(),
	/** Discord snowflake of the dibs callout channel, or null when unrouted. */
	channelId: text("channel_id"),
	/** Minutes before hospital exit that a dibs can be claimed (e.g. 5). */
	claimLeadTime: integer("claim_lead_time").default(5).notNull(),
	/** Concurrent dibs a single member may hold (e.g. 1). */
	maxDibsPerPerson: integer("max_dibs_per_person").default(1).notNull(),
	/** Seconds a claimed dibs stays locked after hospital exit (e.g. 20). */
	postHospTimeoutSeconds: integer("post_hosp_timeout_seconds")
		.default(20)
		.notNull(),
	/** Removes the dibs callout when the target is downed. */
	autoDeleteOnDowned: boolean("auto_delete_on_downed").default(true).notNull(),
	/** ── Channel maintenance ───────────────────────────────────────────────
	 * Enables the periodic sweep that removes orphaned dibs callouts left by
	 * termed wars, API restarts, or failed Discord deliveries.
	 */
	channelMaintenanceEnabled: boolean("channel_maintenance_enabled")
		.default(true)
		.notNull(),
	/** Callouts older than this are always swept, regardless of liveness. */
	maxDibsMessageAgeHours: integer("max_dibs_message_age_hours")
		.default(6)
		.notNull(),
	/** Minutes between automatic sweeps. 0 disables the schedule only. */
	sweepIntervalMinutes: integer("sweep_interval_minutes").default(15).notNull(),
	updatedBy: text("updated_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export type SubversiveDibsConfigRow = typeof subversiveDibsConfigs.$inferSelect;
export type NewSubversiveDibsConfigRow =
	typeof subversiveDibsConfigs.$inferInsert;

/**
 * Ranked-war channel selections, one row per Subversive family faction.
 *
 * Separate from the dibs config because these route the war tooling itself
 * rather than one feature's alerts. Every column is a Discord snowflake, or
 * NULL when that selection is not routed yet.
 */
export const subversiveRwChannelConfigs = pgTable(
	"subversive_rw_channel_configs",
	{
		/** Family faction these channels apply to (2013 / 27312). */
		factionId: integer("faction_id").primaryKey(),
		/** Channel hosting the faction's primary ranked-war display. */
		primaryDisplaysChannelId: text("primary_displays_channel_id"),
		/**
		 * Channel hosting the faction's secondary ranked-war display, which
		 * summarises where the opposing roster is currently flying.
		 *
		 * Kept separate from the primary channel on purpose: the primary
		 * channel's stale-message sweep deletes any bot-authored message it
		 * does not recognise, which would treat a secondary embed sharing that
		 * channel as strays. The API rejects a selection that repeats the
		 * primary channel.
		 */
		secondaryDisplaysChannelId: text("secondary_displays_channel_id"),
		updatedBy: text("updated_by"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
);

export type SubversiveRwChannelConfigRow =
	typeof subversiveRwChannelConfigs.$inferSelect;
export type NewSubversiveRwChannelConfigRow =
	typeof subversiveRwChannelConfigs.$inferInsert;

/**
 * The Discord messages currently rendering the ranked-war primary displays.
 *
 * Deliberately separate from `subversive_rw_channel_configs`: that table is
 * admin-owned configuration edited through the API's channel manager, whereas
 * this is bot-owned runtime state rewritten every war cycle. Keeping them apart
 * stops the bot's message bookkeeping from leaking into the admin config row
 * (whose field-merge logic is duplicated at three call sites) and makes
 * "fetch every live display for this faction" a single indexed query.
 *
 * One row per category per faction. The primary displays use the four buckets
 * declared by `RW_DISPLAY_CATEGORIES`, and the secondary travel display uses
 * `RW_TRAVELING_CATEGORY` ("traveling"). Because `category` is the second half
 * of the primary key, the two channels coexist in one table without a second
 * table — but any bulk delete scoped only by faction would hit both, so every
 * such delete must filter on the categories it owns.
 *
 * Rows are deleted when the war ends or the channel is deselected, so a stale
 * id is never silently reused.
 */
export const subversiveRwDisplayMessages = pgTable(
	"subversive_rw_display_messages",
	{
		/** Family faction the displays belong to (2013 / 27312). */
		factionId: integer("faction_id")
			.notNull()
			.references(() => subversiveRwChannelConfigs.factionId, {
				onDelete: "cascade",
			}),
		/**
		 * Which embed this row tracks.
		 *
		 * One of `hospital` | `offlineOkay` | `onlineOkay` | `revivable`, as
		 * declared by `RW_DISPLAY_CATEGORIES` in `@sentinel/schemas`, or
		 * `traveling` as declared by `RW_TRAVELING_CATEGORY`. Stored as text
		 * rather than a PG enum to match every other discriminator column in
		 * this schema.
		 */
		category: text("category").notNull(),
		/** Discord snowflake of the message rendering the embed. */
		messageId: text("message_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.factionId, table.category] }),
		index("idx_subversive_rw_display_messages_faction").on(table.factionId),
	],
);

export type SubversiveRwDisplayMessageRow =
	typeof subversiveRwDisplayMessages.$inferSelect;
export type NewSubversiveRwDisplayMessageRow =
	typeof subversiveRwDisplayMessages.$inferInsert;

/**
 * Structural mirror of `StockAlertChangeRule` in `@sentinel/schemas`.
 *
 * Duplicated rather than imported because `@sentinel/database` does not depend
 * on `@sentinel/schemas` — the same reason every other JSON column in this
 * schema declares its shape inline.
 */
type StockAlertChangeRuleJson = {
	windowMinutes: number;
	thresholdPct: number;
};

/**
 * Structural mirror of `StockAlertState` in `@sentinel/schemas`.
 */
type StockAlertStateJson = {
	seeded: boolean;
	lastPrice: number | null;
	extremes: Partial<Record<"24h" | "all_time", { high: number; low: number }>>;
	lastAlertAt: Record<string, number>;
};

/**
 * Stock-market alert settings, one row per Subversive family faction
 * (2013 / 27312).
 *
 * Each faction runs its own channel and sensitivity, so these settings are
 * scoped like dibs and ranked-war channels rather than per Discord guild. A
 * missing row means "never configured", which resolves to the factory defaults
 * (disabled) instead of an error.
 */
export const subversiveStockAlertConfigs = pgTable(
	"subversive_stock_alert_configs",
	{
		/** Family faction these settings apply to (2013 / 27312). */
		factionId: integer("faction_id").primaryKey(),
		/** Master switch. Posting also requires a `channelId`. */
		enabled: boolean("enabled").default(false).notNull(),
		/** Discord snowflake of the alert channel, or null when unrouted. */
		channelId: text("channel_id"),
		/**
		 * Notable-move rules (`{ windowMinutes, thresholdPct }[]`). An empty
		 * list disables change alerting while leaving high/low alerting active.
		 */
		changeRules: jsonb("change_rules")
			.$type<StockAlertChangeRuleJson[]>()
			.default([])
			.notNull(),
		/** High/low windows that raise an alert: `24h` and/or `all_time`. */
		highLowWindows: jsonb("high_low_windows")
			.$type<string[]>()
			.default([])
			.notNull(),
		/** Minimum minutes between two alerts of the same kind for one stock. */
		cooldownMinutes: integer("cooldown_minutes").default(30).notNull(),
		updatedBy: text("updated_by"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
);

export type SubversiveStockAlertConfigRow =
	typeof subversiveStockAlertConfigs.$inferSelect;
export type NewSubversiveStockAlertConfigRow =
	typeof subversiveStockAlertConfigs.$inferInsert;

/**
 * Per-stock alerting memory, one row per faction and stock.
 *
 * Persisted rather than kept in RAM because it carries the two things a restart
 * must not lose: the recorded extremes (so a restart does not re-announce a high
 * the faction has already seen) and the cooldown timestamps (so a restart cannot
 * be used to bypass throttling). The 24h and all-time baselines are seeded from
 * Torn's own chart figures, so a cold start is immediately accurate instead of
 * waiting for a locally-built price history.
 */
export const subversiveStockAlertStates = pgTable(
	"subversive_stock_alert_states",
	{
		/** Family faction these baselines belong to (2013 / 27312). */
		factionId: integer("faction_id").notNull(),
		/** Torn stock id, as returned by `/torn/stocks`. */
		stockId: integer("stock_id").notNull(),
		/** `StockAlertState` — extremes, last price and per-key cooldowns. */
		state: jsonb("state").$type<StockAlertStateJson>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.factionId, table.stockId] }),
		index("idx_subversive_stock_alert_states_faction").on(table.factionId),
	],
);

export type SubversiveStockAlertStateRow =
	typeof subversiveStockAlertStates.$inferSelect;
export type NewSubversiveStockAlertStateRow =
	typeof subversiveStockAlertStates.$inferInsert;
