import {
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
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
		index("idx_subversive_keys_is_valid").on(table.isValid),
	],
);

export type SubversiveApiKey = typeof subversiveApiKeys.$inferSelect;
export type NewSubversiveApiKey = typeof subversiveApiKeys.$inferInsert;
