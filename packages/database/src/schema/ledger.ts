import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const personalLogs = sqliteTable("personal_logs", {
	id: text("id").primaryKey(),
	log: integer("log").notNull(),
	title: text("title"),
	timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
	category: text("category"),
	data: text("data", { mode: "json" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const gymLedgers = sqliteTable("gym_ledgers", {
	id: text("id").primaryKey(),
	timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
	statType: text("stat_type").notNull(),
	source: text("source").notNull(),
	trains: integer("trains"),
	energyUsed: integer("energy_used"),
	statGained: real("stat_gained").notNull(),
	statBefore: real("stat_before"),
	statAfter: real("stat_after"),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const crimeLogs = sqliteTable("crime_logs", {
	id: text("id").primaryKey(),
	crimeId: integer("crime_id").notNull(),
	action: text("action").notNull(),
	nerve: integer("nerve").default(0).notNull(),
	value: real("value").default(0).notNull(),
	timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const crimeActionMappings = sqliteTable("crime_action_mappings", {
	id: text("id").primaryKey(),
	crimeId: integer("crime_id").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const assets = sqliteTable("assets", {
	id: text("id").primaryKey(),
	type: text("type").notNull(),
	assetId: text("asset_id").notNull(),
	quantity: real("quantity").default(0).notNull(),
	movingAverageCost: real("moving_average_cost").default(0).notNull(),
	totalCostBasis: real("total_cost_basis").default(0).notNull(),
	location: text("location").notNull(),
	owner: text("owner").default("personal").notNull(),
	origin: text("origin"),
	realizedPnl: real("realized_pnl").default(0).notNull(),
	lastUpdated: integer("last_updated", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const ledgerEvents = sqliteTable("ledger_events", {
	id: text("id").primaryKey(),
	logId: text("log_id"),
	timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
	type: text("type").notNull(),
	categoryId: integer("category_id").notNull(),
	transactionName: text("transaction_name").notNull(),
	assetsAffected: text("assets_affected", { mode: "json" }).notNull(),
	cashFlow: real("cash_flow").default(0).notNull(),
	realizedPnl: real("realized_pnl").default(0).notNull(),
	rawLog: text("raw_log", { mode: "json" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const companyDailyProfits = sqliteTable("company_daily_profits", {
	id: text("id").primaryKey(),
	timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
	inflow: real("inflow").notNull(),
	outflow: real("outflow").notNull(),
	profit: real("profit").notNull(),
	profile: text("profile", { mode: "json" }).notNull(),
	employees: text("employees", { mode: "json" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const userStocks = sqliteTable("user_stocks", {
	id: text("id").primaryKey(),
	shares: integer("shares").default(0).notNull(),
	transactions: text("transactions", { mode: "json" }),
	bonus: text("bonus", { mode: "json" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const stockLedgers = sqliteTable("stock_ledgers", {
	id: text("id").primaryKey(),
	timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
	stockId: integer("stock_id").notNull(),
	logType: integer("log_type").notNull(),
	value: real("value").notNull(),
	itemId: integer("item_id"),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const travelPurchaseLogs = sqliteTable("travel_purchase_logs", {
	id: text("id").primaryKey(),
	timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
	destination: integer("destination").notNull(),
	itemId: integer("item_id").notNull(),
	quantity: integer("quantity").default(0).notNull(),
	costTotal: real("cost_total").default(0).notNull(),
	marketValue: real("market_value").default(0).notNull(),
	profit: real("profit").default(0).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});
