import {
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Shared pool of public Torn API keys donated by Alliance members.
 *
 * `guildId` is nullable because the keys that originally powered territory
 * activity were imported from the system key pool, which is global. A null
 * guild id therefore means "available to every guild"; the pool resolver
 * includes those rows alongside the keys donated for a specific guild.
 */
export const allianceApiKeys = pgTable(
	"alliance_api_keys",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		guildId: text("guild_id"),
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
		index("idx_alliance_keys_guild_id").on(table.guildId),
		index("idx_alliance_keys_torn_id").on(table.tornId),
		index("idx_alliance_keys_valid").on(table.isValid),
		uniqueIndex("idx_alliance_keys_hash").on(table.apiKeyHash),
	],
);

export type AllianceApiKey = typeof allianceApiKeys.$inferSelect;
export type NewAllianceApiKey = typeof allianceApiKeys.$inferInsert;
