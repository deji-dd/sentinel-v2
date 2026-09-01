import {
	doublePrecision,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

export const personalLogs = pgTable("personal_logs", {
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
});

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
