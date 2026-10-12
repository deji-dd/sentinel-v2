import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

/**
 * Sentinel primary key for the single {@link battlestatsPreferences} row.
 *
 * The ledger's build-ratio target is deployment-wide, so the table holds one
 * row. The value matches the legacy `system_states` key it replaces, so anyone
 * tracing the old key can follow it here.
 */
export const BATTLESTATS_PREFERENCES_ID = "personal:battlestats_preferences";

export const personalLogs = pgTable(
	"personal_logs",
	{
		id: text("id").primaryKey(),
		log: integer("log").notNull(),
		title: text("title"),
		timestamp: timestamp("timestamp", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		category: text("category"),
		data: jsonb("data").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		// The ledger reconciliation sweeps filter on `log IN (...)` and order by
		// `timestamp` (crimes/battlestats/stocks anti-joins and the gym-unlock
		// scan). Without this the whole table is seq-scanned and sorted on every
		// sweep, with cost growing as log history accumulates.
		index("idx_personal_logs_log_timestamp").on(table.log, table.timestamp),
	],
);

export const battlestatsLedgers = pgTable("gym_ledgers", {
	id: text("id").primaryKey(),
	timestamp: timestamp("timestamp", {
		withTimezone: true,
		mode: "date",
	}).notNull(),
	statType: text("stat_type").notNull(),
	source: text("source").notNull(),
	trains: integer("trains"),
	energyUsed: integer("energy_used"),
	statGained: doublePrecision("stat_gained").notNull(),
	statBefore: doublePrecision("stat_before"),
	statAfter: doublePrecision("stat_after"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const gymLedgers = battlestatsLedgers;

/**
 * Build-ratio target used by the Battlestats ledger views.
 *
 * Replaces the `personal:battlestats_preferences` row in the legacy
 * `system_states` blob table. Exactly one row exists (the legacy key carried no
 * user id, so it was never per-user despite the `personal:` prefix) and it is
 * addressed by {@link BATTLESTATS_PREFERENCES_ID}.
 *
 * Two scalar values do not need a schemaless JSON column: as columns they are
 * validated on write instead of being accepted as arbitrary JSON and cast with
 * `as unknown as` on read.
 */
export const battlestatsPreferences = pgTable("battlestats_preferences", {
	/** Always {@link BATTLESTATS_PREFERENCES_ID}; enforces a single row. */
	id: text("id").primaryKey().default(BATTLESTATS_PREFERENCES_ID),
	/** Which stat the target ratio is balanced against. */
	mainStat: text("main_stat").default("dexterity").notNull(),
	/** Ratio preset the ledger compares build progress against. */
	ratioType: text("ratio_type").default("baldr").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export type BattlestatsPreferenceRow =
	typeof battlestatsPreferences.$inferSelect;
export type NewBattlestatsPreferenceRow =
	typeof battlestatsPreferences.$inferInsert;

/**
 * Which personal ledgers persist sync progress in
 * {@link personalLedgerSyncStates}.
 */
export const PERSONAL_LEDGER_SYNC_IDS = [
	"battlestats",
	"crimes",
	"stocks",
] as const;

export type PersonalLedgerSyncId = (typeof PERSONAL_LEDGER_SYNC_IDS)[number];

/**
 * Backfill progress for the personal log-backed ledgers, one row per ledger.
 *
 * Replaces three separate `system_states` keys — `personal:battlestats_ledger`,
 * `personal:crimes_ledger` and `personal:stocks_ledger` — which all carried the
 * same JSON shape, so one keyed table replaces all three and the discriminator
 * makes it obvious that they are the same kind of state rather than three
 * unrelated blobs.
 *
 * The legacy rows also carried an `init` boolean that was simply
 * `status === "completed"`; it is not reproduced here because it was written by
 * the workers but never read by anything, and `status` already says it.
 *
 * `lastProcessedTimestamp` is a Torn log timestamp (epoch seconds), kept as an
 * integer so cursor comparisons stay exact.
 */
export const personalLedgerSyncStates = pgTable("personal_ledger_sync_states", {
	/** One of {@link PERSONAL_LEDGER_SYNC_IDS}. */
	ledger: text("ledger").primaryKey(),
	/** `idle` | `running` | `completed` | `error`. */
	status: text("status").default("idle").notNull(),
	lastError: text("last_error"),
	/** Total log rows indexed by the last completed backfill. */
	totalIndexed: bigint("total_indexed", { mode: "number" })
		.default(0)
		.notNull(),
	/** Epoch SECONDS of the newest log the backfill consumed. */
	lastProcessedTimestamp: bigint("last_processed_timestamp", {
		mode: "number",
	}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export type PersonalLedgerSyncStateRow =
	typeof personalLedgerSyncStates.$inferSelect;
export type NewPersonalLedgerSyncStateRow =
	typeof personalLedgerSyncStates.$inferInsert;

/**
 * One row per bounty target the finder is currently tracking.
 *
 * Replaces the `personal:bounties` row in the legacy `system_states` blob, which
 * held two arrays — `readyTargets` and `hospitalQueue` — inside a single JSON
 * object. Both lists grow with the candidate pool, so every change rewrote the
 * whole thing: re-checking one target's hospital status cost a write of every
 * target. Worse, the row had two writers in different processes (the scheduler's
 * bounty finder and the API's "profile target" endpoint), each doing a
 * read-modify-write of the entire object, so one could silently revert the
 * other's update.
 *
 * The two lists are distinguished by `queue` rather than by two tables: they
 * hold the same target shape and the API moves a target between them, which is
 * now a single column update. `secondsRemaining` is the only field exclusive to
 * the hospital queue.
 *
 * Deployment-level counters (last sync, target and pending counts) are not here
 * — they belong to the worker and live in `worker_state` under
 * `WORKER_STATE_IDS.bounties`.
 */
export const personalBountyTargets = pgTable(
	"personal_bounty_targets",
	{
		targetId: integer("target_id").primaryKey(),
		/** `ready` (attackable now) or `hospital` (waiting on a hospital exit). */
		queue: text("queue").notNull(),
		name: text("name").notNull(),
		level: integer("level").notNull(),
		/** Highest single qualifying bounty reward, in dollars. */
		reward: bigint("reward", { mode: "number" }).default(0).notNull(),
		/** Null when the target has not been scouted yet. */
		fairFight: doublePrecision("fair_fight"),
		estimatedBs: bigint("estimated_bs", { mode: "number" }),
		/** Target age in days; the finder only keeps targets at 14+ days. */
		age: integer("age").notNull(),
		/** Torn status string, e.g. `Okay`, `Hospital`, `Abroad`. */
		statusState: text("status_state").notNull(),
		statusDescription: text("status_description"),
		/** Epoch SECONDS the current status ends, when Torn reports one. */
		statusUntil: bigint("status_until", { mode: "number" }),
		attackUrl: text("attack_url").notNull(),
		/** Epoch SECONDS this target was last profiled. */
		lastCheckedAt: bigint("last_checked_at", { mode: "number" }).notNull(),
		/** Seconds left in hospital. Only meaningful for the `hospital` queue. */
		secondsRemaining: integer("seconds_remaining"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_personal_bounty_targets_queue").on(table.queue, table.reward),
	],
);

export type PersonalBountyTargetRow = typeof personalBountyTargets.$inferSelect;
export type NewPersonalBountyTargetRow =
	typeof personalBountyTargets.$inferInsert;

/**
 * One row per unlocked user perk, with the category Torn reported it under.
 *
 * Replaces `personal:user_perks` in the legacy `system_states` blob, which held
 * the same data twice — a flat `allPerks` array of ~128 strings *and* a
 * `categorizedPerks` object repeating every one of them under eight category
 * keys — inside a single ~4 KB JSON value rewritten in full on every daily sync.
 *
 * `allPerks` is not reproduced: it was exactly the concatenation of the
 * categorized values, so it is derived by querying the rows. `perk` is the
 * primary key because Torn reports each perk string once.
 */
export const personalPerks = pgTable(
	"personal_perks",
	{
		perk: text("perk").primaryKey(),
		/** Torn's category: `faction_perks`, `job_perks`, `merit_perks`, … */
		category: text("category").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [index("idx_personal_perks_category").on(table.category)],
);

export type PersonalPerkRow = typeof personalPerks.$inferSelect;
export type NewPersonalPerkRow = typeof personalPerks.$inferInsert;

/**
 * One row per gym the account has unlocked.
 *
 * Replaces the `unlockedGymIds` array in the `personal:gym_unlocks`
 * `system_states` blob. That blob's other contents are scalars and live in
 * {@link personalReferenceSummaries}.
 */
export const personalGymUnlocks = pgTable("personal_gym_unlocks", {
	gymId: integer("gym_id").primaryKey(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export type PersonalGymUnlockRow = typeof personalGymUnlocks.$inferSelect;
export type NewPersonalGymUnlockRow = typeof personalGymUnlocks.$inferInsert;

/** Sentinel primary key: the reference sync is deployment-wide. */
export const PERSONAL_REFERENCE_SUMMARY_ID = "personal:reference_summary";

/**
 * Scalar rollups of the personal reference sync: the perk-derived travel
 * modifiers and the best unlocked gym per stat.
 *
 * Replaces the scalar parts of the `personal:user_perks` and
 * `personal:gym_unlocks` blobs. These are derived summaries rather than raw
 * lists — the lists themselves are rows in {@link personalPerks} and
 * {@link personalGymUnlocks} — and they come from a single worker, so one
 * singleton row keeps everything typed without a table per field group.
 */
export const personalReferenceSummaries = pgTable(
	"personal_reference_summaries",
	{
		/** Always {@link PERSONAL_REFERENCE_SUMMARY_ID}; enforces one row. */
		id: text("id").primaryKey().default(PERSONAL_REFERENCE_SUMMARY_ID),
		/** Epoch SECONDS the perk list was fetched. */
		perksFetchedAt: bigint("perks_fetched_at", { mode: "number" }),
		/** Whether the account holds the property airstrip perk. */
		hasAirstrip: boolean("has_airstrip").default(false).notNull(),
		hasBookPerk: boolean("has_book_perk").default(false).notNull(),
		hasWltBenefit: boolean("has_wlt_benefit").default(false).notNull(),
		/** Percentage travel-time reduction from faction perks. */
		factionTravelReduction: doublePrecision("faction_travel_reduction")
			.default(0)
			.notNull(),
		/** Total percentage travel-time reduction across all sources. */
		totalTravelReduction: doublePrecision("total_travel_reduction")
			.default(0)
			.notNull(),
		/** Epoch SECONDS the gym unlocks were fetched. */
		gymsFetchedAt: bigint("gyms_fetched_at", { mode: "number" }),
		/** Best unlocked gym id per stat, or null when never synced. */
		strengthGym: integer("strength_gym"),
		defenseGym: integer("defense_gym"),
		speedGym: integer("speed_gym"),
		dexterityGym: integer("dexterity_gym"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
);

export type PersonalReferenceSummaryRow =
	typeof personalReferenceSummaries.$inferSelect;
export type NewPersonalReferenceSummaryRow =
	typeof personalReferenceSummaries.$inferInsert;

/** The four Torn bars, which all share one shape. */
export const PERSONAL_LIVE_BAR_IDS = [
	"energy",
	"nerve",
	"happy",
	"life",
] as const;

export type PersonalLiveBarId = (typeof PERSONAL_LIVE_BAR_IDS)[number];

/** Sentinel primary key: this is a single-account snapshot. */
export const PERSONAL_LIVE_STATE_ID = "personal:live_state";

/**
 * One row per Torn bar (energy, nerve, happy, life).
 *
 * Replaces the `bars` half of the `personal:live_state` blob. The four bars are
 * structurally identical, so a row per bar keeps them typed without repeating
 * twenty columns in a single-row table.
 */
export const personalLiveBars = pgTable("personal_live_bars", {
	/** One of {@link PERSONAL_LIVE_BAR_IDS}. */
	bar: text("bar").primaryKey(),
	current: integer("current").notNull(),
	maximum: integer("maximum").notNull(),
	increment: integer("increment").notNull(),
	/** Seconds between increments. */
	interval: integer("interval").notNull(),
	/** Epoch SECONDS the bar next fills by one increment. */
	fullTime: bigint("full_time", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export type PersonalLiveBarRow = typeof personalLiveBars.$inferSelect;
export type NewPersonalLiveBarRow = typeof personalLiveBars.$inferInsert;

/**
 * Cooldowns, battle stats and the raw money payload for the synced account.
 *
 * Replaces the scalar half of the `personal:live_state` blob; the bars are rows
 * in {@link personalLiveBars}.
 *
 * `money` is the one `jsonb` here, and deliberately so: Torn's money selection
 * is a free-form payload with no typed consumer yet — the worker stores it
 * wholesale and only `battlestats` and `bars` are read back. Rather than drop
 * data nobody asked to lose, it is kept verbatim behind the same
 * object-only CHECK the worker state uses, so the double-encoded shape the
 * legacy blob accepted cannot be stored.
 */
export const personalLiveStates = pgTable(
	"personal_live_states",
	{
		/** Always {@link PERSONAL_LIVE_STATE_ID}; enforces one row. */
		id: text("id").primaryKey().default(PERSONAL_LIVE_STATE_ID),
		/** Epoch SECONDS each cooldown expires. */
		drugCooldown: bigint("drug_cooldown", { mode: "number" })
			.default(0)
			.notNull(),
		medicalCooldown: bigint("medical_cooldown", { mode: "number" })
			.default(0)
			.notNull(),
		boosterCooldown: bigint("booster_cooldown", { mode: "number" })
			.default(0)
			.notNull(),
		/** Battle stats. `bigint` because totals exceed the 32-bit integer range. */
		strength: bigint("strength", { mode: "number" }).default(0).notNull(),
		defense: bigint("defense", { mode: "number" }).default(0).notNull(),
		speed: bigint("speed", { mode: "number" }).default(0).notNull(),
		dexterity: bigint("dexterity", { mode: "number" }).default(0).notNull(),
		/** Torn's own total, when it reports one; null otherwise. */
		totalStats: bigint("total_stats", { mode: "number" }),
		lastSyncDurationMs: integer("last_sync_duration_ms"),
		/** Raw Torn money selection, kept verbatim. Never configuration. */
		money: jsonb("money")
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		// Rejects the double-encoded payloads the legacy blob accepted silently.
		check(
			"personal_live_states_money_is_object",
			sql`jsonb_typeof(${table.money}) = 'object'`,
		),
	],
);

export type PersonalLiveStateRow = typeof personalLiveStates.$inferSelect;
export type NewPersonalLiveStateRow = typeof personalLiveStates.$inferInsert;

export const crimeLogs = pgTable("crime_logs", {
	id: text("id").primaryKey(),
	crimeId: integer("crime_id").notNull(),
	action: text("action").notNull(),
	nerve: integer("nerve").default(0).notNull(),
	value: doublePrecision("value").default(0).notNull(),
	timestamp: timestamp("timestamp", {
		withTimezone: true,
		mode: "date",
	}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const crimeActionMappings = pgTable("crime_action_mappings", {
	id: text("id").primaryKey(),
	crimeId: integer("crime_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const companyDailyProfits = pgTable("company_daily_profits", {
	id: text("id").primaryKey(),
	timestamp: timestamp("timestamp", {
		withTimezone: true,
		mode: "date",
	}).notNull(),
	inflow: doublePrecision("inflow").notNull(),
	outflow: doublePrecision("outflow").notNull(),
	profit: doublePrecision("profit").notNull(),
	profile: jsonb("profile").notNull(),
	employees: jsonb("employees").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const oilRigSnapshots = pgTable("oil_rig_snapshots", {
	id: text("id").primaryKey(),
	companyId: integer("company_id").notNull(),
	timestamp: timestamp("timestamp", {
		withTimezone: true,
		mode: "date",
	}).notNull(),
	rating: integer("rating").notNull(),
	dailyRevenue: doublePrecision("daily_revenue").notNull(),
	weeklyRevenue: doublePrecision("weekly_revenue").notNull(),
	dailyCustomers: integer("daily_customers").notNull(),
	weeklyCustomers: integer("weekly_customers").notNull(),
	barrelsSold: integer("barrels_sold").notNull(),
	barrelsInStock: integer("barrels_in_stock").notNull(),
	barrelPrice: integer("barrel_price").notNull(),
	adBudget: doublePrecision("ad_budget").notNull(),
	storageCapacity: integer("storage_capacity").notNull(),
	efficiency: integer("efficiency").notNull(),
	environment: integer("environment").notNull(),
	popularity: integer("popularity").notNull(),
	trains: integer("trains").notNull(),
	profile: jsonb("profile").notNull(),
	employees: jsonb("employees").notNull(),
	stock: jsonb("stock").notNull(),
	metrics: jsonb("metrics").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

/**
 * One row per issued director briefing.
 *
 * This is the audit trail that makes the advice falsifiable: it records what the
 * engines decided, on what data basis, and - once the next tick lands - what
 * actually happened. Without it there is no way to tell whether following a
 * brief beat ignoring it, and no way to tune the policy constants from evidence.
 *
 * `regime` and `inventoryState` are stored because they are *hysteretic*: the
 * next analysis reads them back so a brief can only re-enter a structural
 * recommendation under the policy's enter conditions, which is what stops the
 * advice oscillating between "add sell-through capacity" and "remove it".
 */
export const oilRigBriefs = pgTable(
	"oil_rig_briefs",
	{
		id: text("id").primaryKey(),
		companyId: integer("company_id").notNull(),
		/** When the analysis ran. */
		asOf: timestamp("as_of", { withTimezone: true, mode: "date" }).notNull(),
		/** Which data basis the decisions were taken on. */
		dataBasis: text("data_basis").notNull(),
		/** Age of the recorded tick the decisions used, in minutes. */
		tickAgeMinutes: integer("tick_age_minutes"),
		/** Hysteretic capacity regime: "balanced" | "extraction_bound". */
		regime: text("regime").notNull(),
		regimeSince: timestamp("regime_since", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		/** Hysteretic inventory state: "deficit" | "equilibrium" | "surplus". */
		inventoryState: text("inventory_state").notNull(),
		warehouseCritical: integer("warehouse_critical").notNull(),
		/** Stable signature of the deterministic advice, for change detection. */
		adviceSignature: text("advice_signature").notNull(),
		/** The full CompanyDirectives payload as issued. */
		directives: jsonb("directives").notNull(),
		/** Every engine input and output, for auditing a past decision. */
		analysis: jsonb("analysis").notNull(),
		/** Filled at the next tick: what actually happened after this advice. */
		outcome: jsonb("outcome"),
		outcomeEvaluatedAt: timestamp("outcome_evaluated_at", {
			withTimezone: true,
			mode: "date",
		}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [index("oil_rig_briefs_as_of_idx").on(table.asOf)],
);

/**
 * A capture of how the top-rated rigs in the industry are actually staffed.
 *
 * The roster blueprint in `getOptimalRoleQuotas` is a hand-written target. This
 * table is the measured alternative: the role distribution of the best rigs in
 * the game, which is public information and therefore the one lever we do not
 * have to guess at. `roleShares` is the share of total staff per role, so it can
 * be scaled to any staff count.
 */
export const oilRigBenchmarks = pgTable(
	"oil_rig_benchmarks",
	{
		id: text("id").primaryKey(),
		capturedAt: timestamp("captured_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		/** Star rating band this capture describes (e.g. 10). */
		rating: integer("rating").notNull(),
		/** Total oil rigs seen in the industry listing. */
		fieldSize: integer("field_size").notNull(),
		/** Number of rigs actually sampled for the medians below. */
		sampleSize: integer("sample_size").notNull(),
		avgWeeklyRevenue: doublePrecision("avg_weekly_revenue").notNull(),
		avgWeeklyCustomers: doublePrecision("avg_weekly_customers").notNull(),
		avgHired: doublePrecision("avg_hired").notNull(),
		avgCapacity: doublePrecision("avg_capacity").notNull(),
		/** Median headcount per role across the sample. */
		roleCounts: jsonb("role_counts").notNull(),
		/** Median share of staff per role (0..1), scale-invariant. */
		roleShares: jsonb("role_shares").notNull(),
		/** Per-rig detail so a median can be recomputed or audited later. */
		topRigs: jsonb("top_rigs").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [index("oil_rig_benchmarks_captured_idx").on(table.capturedAt)],
);

export const userStocks = pgTable("user_stocks", {
	id: text("id").primaryKey(),
	shares: integer("shares").default(0).notNull(),
	transactions: jsonb("transactions"),
	bonus: jsonb("bonus"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const stockLedgers = pgTable("stock_ledgers", {
	id: text("id").primaryKey(),
	timestamp: timestamp("timestamp", {
		withTimezone: true,
		mode: "date",
	}).notNull(),
	stockId: integer("stock_id").notNull(),
	logType: integer("log_type").notNull(),
	value: doublePrecision("value").notNull(),
	itemId: integer("item_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const travelPurchaseLogs = pgTable("travel_purchase_logs", {
	id: text("id").primaryKey(),
	timestamp: timestamp("timestamp", {
		withTimezone: true,
		mode: "date",
	}).notNull(),
	destination: integer("destination").notNull(),
	itemId: integer("item_id").notNull(),
	quantity: integer("quantity").default(0).notNull(),
	costTotal: doublePrecision("cost_total").default(0).notNull(),
	marketValue: doublePrecision("market_value").default(0).notNull(),
	profit: doublePrecision("profit").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});
