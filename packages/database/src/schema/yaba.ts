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
 * Factions tracked by the YABA faction activity report.
 *
 * The initial list is synced from the alliance verification faction map
 * (`faction_role_mappings` for the alliance guild). `type` is an admin
 * override — combat is the default — and rows added manually (for applicants)
 * are marked `source: "manual"` so a map sync never removes them.
 */
export const yabaFactions = pgTable(
	"yaba_factions",
	{
		factionId: integer("faction_id").primaryKey(),
		name: text("name").notNull(),
		tag: text("tag"),
		type: text("type").default("combat").notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		source: text("source").default("verification").notNull(),
		leaderId: integer("leader_id"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_yaba_factions_enabled").on(table.enabled),
		index("idx_yaba_factions_type").on(table.type),
	],
);

export const yabaMembers = pgTable(
	"yaba_members",
	{
		tornId: integer("torn_id").primaryKey(),
		factionId: integer("faction_id").notNull(),
		name: text("name").notNull(),
		level: integer("level"),
		daysInFaction: integer("days_in_faction"),
		lastSeenAt: timestamp("last_seen_at", {
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
		index("idx_yaba_members_faction_id").on(table.factionId),
		index("idx_yaba_members_last_seen").on(table.lastSeenAt),
	],
);

/**
 * Cumulative personal-stat snapshots. One row per member per anchor time.
 * Historical backfill rows use the requested boundary timestamp; nightly
 * rows use the collection time. Window deltas are `latest - baseline`.
 */
export const yabaStatAnchors = pgTable(
	"yaba_stat_anchors",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tornId: integer("torn_id").notNull(),
		at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
		source: text("source").default("popular").notNull(),
		partial: boolean("partial").default(false).notNull(),
		xanax: integer("xanax"),
		activitySeconds: integer("activity_seconds"),
		rankedWarHits: integer("ranked_war_hits"),
		revives: integer("revives"),
		factionRespect: integer("faction_respect"),
		attacksWon: integer("attacks_won"),
		attacksLost: integer("attacks_lost"),
		hitsSuccess: integer("hits_success"),
		hitsCritical: integer("hits_critical"),
		damageTotal: integer("damage_total"),
		reviveSkill: integer("revive_skill"),
		rankedWarWins: integer("ranked_war_wins"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("idx_yaba_stat_anchors_member_at").on(table.tornId, table.at),
		index("idx_yaba_stat_anchors_at").on(table.at),
	],
);

/** Daily faction roster counts, used by the UI's size-tier filter. */
export const yabaFactionDaily = pgTable(
	"yaba_faction_daily",
	{
		factionId: integer("faction_id").notNull(),
		day: timestamp("day", { withTimezone: true, mode: "date" }).notNull(),
		membersCount: integer("members_count").notNull(),
		respect: integer("respect"),
		daysOld: integer("days_old"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("idx_yaba_faction_daily_faction_day").on(
			table.factionId,
			table.day,
		),
	],
);

/** Provider-agnostic battle score estimates (FFScouter). */
export const yabaBattleEstimates = pgTable(
	"yaba_battle_estimates",
	{
		tornId: integer("torn_id").notNull(),
		provider: text("provider").default("ffscouter").notNull(),
		score: integer("score"),
		fairFight: integer("fair_fight"),
		source: text("source"),
		capturedAt: timestamp("captured_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("idx_yaba_battle_estimates_member_provider").on(
			table.tornId,
			table.provider,
		),
	],
);

/** Immutable, versioned ranking results served by the UI and bot. */
export const yabaRankings = pgTable(
	"yaba_rankings",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		scope: text("scope").notNull(),
		factionType: text("faction_type").notNull(),
		window: text("window").notNull(),
		presetHash: text("preset_hash").notNull(),
		generatedAt: timestamp("generated_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		rows: jsonb("rows").$type<unknown>().notNull(),
		unrankedCount: integer("unranked_count").default(0).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("idx_yaba_rankings_version").on(
			table.scope,
			table.factionType,
			table.window,
			table.presetHash,
			table.generatedAt,
		),
		index("idx_yaba_rankings_lookup").on(
			table.scope,
			table.factionType,
			table.window,
		),
	],
);

/** User-selected ranking metric combo; the default mirrors the Google Sheet. */
export const yabaPresets = pgTable("yaba_presets", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	name: text("name").notNull(),
	factionType: text("faction_type").default("combat").notNull(),
	metrics: jsonb("metrics").$type<string[]>().notNull(),
	weights: jsonb("weights")
		.$type<Record<string, number>>()
		.default({})
		.notNull(),
	hash: text("hash").notNull().unique(),
	isDefault: boolean("is_default").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

/** Audit trail for collection runs and their per-stage counters. */
export const yabaCollectionRuns = pgTable("yaba_collection_runs", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	kind: text("kind").notNull(),
	status: text("status").default("running").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
	keyCount: integer("key_count").default(0).notNull(),
	counters: jsonb("counters")
		.$type<Record<string, number>>()
		.default({})
		.notNull(),
	error: text("error"),
});
