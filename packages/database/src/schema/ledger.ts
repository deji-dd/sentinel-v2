import {
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

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
		// `timestamp` (crimes/battlestats/stocks anti-joins, gym-unlock scan, and
		// the wealth range query). Without this the whole table is seq-scanned and
		// sorted on every sweep, with cost growing as log history accumulates.
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

export const assets = pgTable("assets", {
	id: text("id").primaryKey(),
	type: text("type").notNull(),
	assetId: text("asset_id").notNull(),
	quantity: doublePrecision("quantity").default(0).notNull(),
	movingAverageCost: doublePrecision("moving_average_cost")
		.default(0)
		.notNull(),
	totalCostBasis: doublePrecision("total_cost_basis").default(0).notNull(),
	location: text("location").notNull(),
	owner: text("owner").default("personal").notNull(),
	origin: text("origin"),
	realizedPnl: doublePrecision("realized_pnl").default(0).notNull(),
	lastUpdated: timestamp("last_updated", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const ledgerEvents = pgTable("ledger_events", {
	id: text("id").primaryKey(),
	logId: text("log_id"),
	timestamp: timestamp("timestamp", {
		withTimezone: true,
		mode: "date",
	}).notNull(),
	type: text("type").notNull(),
	categoryId: integer("category_id").notNull(),
	transactionName: text("transaction_name").notNull(),
	assetsAffected: jsonb("assets_affected").notNull(),
	cashFlow: doublePrecision("cash_flow").default(0).notNull(),
	realizedPnl: doublePrecision("realized_pnl").default(0).notNull(),
	rawLog: jsonb("raw_log"),
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
