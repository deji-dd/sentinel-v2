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
 *
 * Keyed by range (`1h` … `all_time`) rather than by the two fixed windows the
 * feature used to have.
 */
type StockAlertStateJson = {
	seeded: boolean;
	lastPrice: number | null;
	extremes: Partial<Record<string, { high: number; low: number }>>;
	lastAlertAt: Record<string, number>;
};

/**
 * Structural mirror of `UserStockAlertState` in `@sentinel/schemas`.
 */
type UserStockAlertStateJson = {
	seeded: boolean;
	wasTrue: boolean | null;
	lastExtreme: number | null;
	lastAlertAt: number | null;
};

/**
 * Stock-market alert settings, one row per Discord guild.
 *
 * Guild-scoped rather than per Torn faction: the alert channel, the sensitivity
 * and the audience all belong to the *server*, and both family factions are
 * members of it. Scoping this per faction meant the same Discord channel had to
 * be configured twice, with two independent cooldowns to reason about.
 *
 * A missing row means "never configured", which resolves to the factory
 * defaults (disabled) instead of an error.
 */
export const guildStockAlertConfigs = pgTable("guild_stock_alert_configs", {
	/** Discord guild these settings apply to. */
	guildId: text("guild_id").primaryKey(),
	/** Master switch. Posting also requires a `channelId`. */
	enabled: boolean("enabled").default(false).notNull(),
	/** Discord snowflake of the alert channel, or null when unrouted. */
	channelId: text("channel_id"),
	/**
	 * Notable-move rules (`{ windowMinutes, thresholdPct }[]`). An empty list
	 * disables change alerting while leaving high/low alerting active.
	 */
	changeRules: jsonb("change_rules")
		.$type<StockAlertChangeRuleJson[]>()
		.default([])
		.notNull(),
	/**
	 * Ranges that raise a high/low alert: any subset of `1h`, `24h`, `7d`,
	 * `30d`, `1y`, `all_time`.
	 */
	highLowRanges: jsonb("high_low_ranges")
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
});

export type GuildStockAlertConfigRow =
	typeof guildStockAlertConfigs.$inferSelect;
export type NewGuildStockAlertConfigRow =
	typeof guildStockAlertConfigs.$inferInsert;

/**
 * Per-stock alerting memory, one row per guild and stock.
 *
 * Persisted rather than kept in RAM because it carries the two things a restart
 * must not lose: the recorded extremes (so a restart does not re-announce a high
 * the guild has already seen) and the cooldown timestamps (so a restart cannot
 * be used to bypass throttling). Every range's baseline is seeded from Torn's
 * own chart figures, so a cold start is immediately accurate instead of waiting
 * for a locally-built price history.
 */
export const guildStockAlertStates = pgTable(
	"guild_stock_alert_states",
	{
		/** Discord guild these baselines belong to. */
		guildId: text("guild_id").notNull(),
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
	(table) => [primaryKey({ columns: [table.guildId, table.stockId] })],
);

export type GuildStockAlertStateRow = typeof guildStockAlertStates.$inferSelect;
export type NewGuildStockAlertStateRow =
	typeof guildStockAlertStates.$inferInsert;

/**
 * One user's personal stock alert, delivered by DM.
 *
 * Created from the `/stock-alerts` command in a faction guild. Rows are keyed by
 * `(discordUserId, conditionKey)` rather than by the individual condition
 * columns: Postgres treats NULLs as distinct in a unique index, so a unique
 * index over `(user, stock, condition, range, threshold)` would happily accept
 * the same range-less `price_above` subscription twice.
 *
 * `guildId` records where the subscription was created. It scopes the list and
 * remove commands, so a member of two servers cannot see or delete the other
 * server's alerts, but delivery itself is a DM and therefore guild-independent.
 */
export const userStockAlerts = pgTable(
	"user_stock_alerts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		/** Discord guild the subscription was created in. */
		guildId: text("guild_id").notNull(),
		/** Discord snowflake of the subscribing user. */
		discordUserId: text("discord_user_id").notNull(),
		/** Torn stock id, as returned by `/torn/stocks`. */
		stockId: integer("stock_id").notNull(),
		/** One of `price_above`, `price_below`, `change_up`, `change_down`, `new_high`, `new_low`. */
		condition: text("condition").notNull(),
		/** Range the condition is measured over; null for the price conditions. */
		rangeKey: text("range_key"),
		/** Price in dollars or percentage move; null for the extreme conditions. */
		threshold: doublePrecision("threshold"),
		/** Canonical signature of the condition, unique per user. */
		conditionKey: text("condition_key").notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		/** `UserStockAlertState` — seed flag, edge memory and cooldown. */
		state: jsonb("state").$type<UserStockAlertStateJson>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("user_stock_alerts_user_condition_idx").on(
			table.discordUserId,
			table.conditionKey,
		),
		index("idx_user_stock_alerts_stock").on(table.stockId),
		index("idx_user_stock_alerts_user").on(table.discordUserId),
	],
);

export type UserStockAlertRow = typeof userStockAlerts.$inferSelect;
export type NewUserStockAlertRow = typeof userStockAlerts.$inferInsert;
