import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Global cache for FFScouter player stats keyed by Torn player ID.
 * Cache entries are valid for 30 days from the time they were fetched.
 */
export const playerStatCache = pgTable("player_stat_cache", {
	playerId: integer("player_id").primaryKey(),
	/** Full FFScouterTargetResult payload */
	data: jsonb("data").notNull(),
	/** Top-level source field from FFScouter (bss | premium | spies | …) */
	source: text("source"),
	/** Wall-clock time the API result was retrieved */
	fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	/** fetched_at + 30 days — entries after this timestamp are stale */
	expiresAt: timestamp("expires_at", {
		withTimezone: true,
		mode: "date",
	}).notNull(),
});
