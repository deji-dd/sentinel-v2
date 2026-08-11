import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const factions = sqliteTable("factions", {
	id: integer("id").primaryKey(),
	name: text("name").notNull(),
	tag: text("tag"),
	tagImage: text("tag_image"),
	leaderId: integer("leader_id"),
	coLeaderId: integer("co_leader_id"),
	respect: integer("respect").default(0).notNull(),
	capacity: integer("capacity").default(0).notNull(),
	membersCount: integer("members_count").default(0).notNull(),
	data: text("data", { mode: "json" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const territoryBlueprints = sqliteTable("territory_blueprints", {
	id: text("id").primaryKey(),
	sector: integer("sector"),
	size: integer("size"),
	density: integer("density"),
	slots: integer("slots"),
	data: text("data", { mode: "json" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const territoryStates = sqliteTable("territory_states", {
	id: text("id").primaryKey(),
	factionId: integer("faction_id"),
	racket: text("racket", { mode: "json" }),
	isWarring: integer("is_warring", { mode: "boolean" })
		.default(false)
		.notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const warLedgers = sqliteTable("war_ledgers", {
	id: text("id").primaryKey(),
	tt: text("tt").notNull(),
	assaultingFaction: integer("assaulting_faction").notNull(),
	defendingFaction: integer("defending_faction").notNull(),
	victorFaction: integer("victor_faction"),
	startTime: integer("start_time", { mode: "timestamp" }).notNull(),
	endTime: integer("end_time", { mode: "timestamp" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const tornItems = sqliteTable("torn_items", {
	id: text("id").primaryKey(),
	name: text("name"),
	data: text("data", { mode: "json" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const tornCrimes = sqliteTable("torn_crimes", {
	id: text("id").primaryKey(),
	name: text("name"),
	data: text("data", { mode: "json" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const tornStocks = sqliteTable("torn_stocks", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	acronym: text("acronym").notNull(),
	market: text("market", { mode: "json" }),
	bonus: text("bonus", { mode: "json" }),
	images: text("images", { mode: "json" }),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const tornProperties = sqliteTable("torn_properties", {
	id: text("id").primaryKey(),
	name: text("name"),
	data: text("data", { mode: "json" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const tornGyms = sqliteTable("torn_gyms", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	stage: integer("stage").notNull(),
	cost: integer("cost").notNull(),
	energy: integer("energy").notNull(),
	strength: real("strength").notNull(),
	speed: real("speed").notNull(),
	defense: real("defense").notNull(),
	dexterity: real("dexterity").notNull(),
	note: text("note"),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const travelDestinations = sqliteTable("travel_destinations", {
	id: text("id").primaryKey(),
	name: text("name"),
	stocks: text("stocks", { mode: "json" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});

export const travelAreaMappings = sqliteTable("travel_area_mappings", {
	id: integer("id").primaryKey(),
	countryCode: text("country_code").notNull(),
	name: text("name").notNull(),
	createdAt: integer("created_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.default(sql`(strftime('%s', 'now'))`)
		.notNull(),
});
