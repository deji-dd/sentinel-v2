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

/**
 * Structural mirror of `UserShopliftingAlertState` in `@sentinel/schemas`.
 *
 * Kept inline for the same reason the stock-alert state is: the database package
 * does not depend on the schema package.
 */
type UserShopliftingAlertStateJson = {
	seeded: boolean;
	wasTrue: boolean | null;
	lastAlertAt: number | null;
};

/**
 * One user's personal shoplifting-security alert, delivered by DM.
 *
 * Created from `/shoplifting-alerts` in the faction guild. A row watches one
 * condition at one shop (`cameras_down`, `guards_down` or `all_down`), so the
 * same shop can be watched for several kinds of clean window without one
 * subscription having to encode a set of triggers.
 *
 * Keyed by `(discordUserId, conditionKey)` rather than by the condition columns
 * because `conditionKey` is the canonical signature the command builds and
 * deduplicates against.
 */
export const userShopliftingAlerts = pgTable(
	"user_shoplifting_alerts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		/** Discord guild the subscription was created in. */
		guildId: text("guild_id").notNull(),
		/** Discord snowflake of the subscribing user. */
		discordUserId: text("discord_user_id").notNull(),
		/** Torn shoplifting sub-crime id, as returned by `/torn/shoplifting`. */
		shopId: integer("shop_id").notNull(),
		/**
		 * One of `cameras_down`, `guards_down`, `all_down`. Held as text so adding
		 * a condition stays a code change rather than a migration.
		 */
		condition: text("condition").notNull(),
		/** Canonical signature of the condition, unique per user. */
		conditionKey: text("condition_key").notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		/** `UserShopliftingAlertState` — seed flag, edge memory and cooldown. */
		state: jsonb("state").$type<UserShopliftingAlertStateJson>().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("user_shoplifting_alerts_user_condition_idx").on(
			table.discordUserId,
			table.conditionKey,
		),
		index("idx_user_shoplifting_alerts_shop").on(table.shopId),
		index("idx_user_shoplifting_alerts_user").on(table.discordUserId),
	],
);

export type UserShopliftingAlertRow = typeof userShopliftingAlerts.$inferSelect;
export type NewUserShopliftingAlertRow =
	typeof userShopliftingAlerts.$inferInsert;
