import {
	boolean,
	doublePrecision,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

export const factions = pgTable("factions", {
	id: integer("id").primaryKey(),
	name: text("name").notNull(),
	tag: text("tag"),
	tagImage: text("tag_image"),
	leaderId: integer("leader_id"),
	coLeaderId: integer("co_leader_id"),
	respect: integer("respect").default(0).notNull(),
	capacity: integer("capacity").default(0).notNull(),
	membersCount: integer("members_count").default(0).notNull(),
	data: jsonb("data"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const territoryBlueprints = pgTable("territory_blueprints", {
	id: text("id").primaryKey(),
	sector: integer("sector"),
	size: integer("size"),
	density: integer("density"),
	slots: integer("slots"),
	data: jsonb("data").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const territoryStates = pgTable("territory_states", {
	id: text("id").primaryKey(),
	factionId: integer("faction_id"),
	racket: jsonb("racket"),
	isWarring: boolean("is_warring").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const warLedgers = pgTable("war_ledgers", {
	id: text("id").primaryKey(),
	tt: text("tt").notNull(),
	assaultingFaction: integer("assaulting_faction").notNull(),
	defendingFaction: integer("defending_faction").notNull(),
	victorFaction: integer("victor_faction"),
	startTime: timestamp("start_time", {
		withTimezone: true,
		mode: "date",
	}).notNull(),
	endTime: timestamp("end_time", {
		withTimezone: true,
		mode: "date",
	}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const tornItems = pgTable("torn_items", {
	id: text("id").primaryKey(),
	name: text("name"),
	data: jsonb("data").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const tornCrimes = pgTable("torn_crimes", {
	id: text("id").primaryKey(),
	name: text("name"),
	data: jsonb("data").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const tornStocks = pgTable("torn_stocks", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	acronym: text("acronym").notNull(),
	market: jsonb("market"),
	bonus: jsonb("bonus"),
	images: jsonb("images"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const tornProperties = pgTable("torn_properties", {
	id: text("id").primaryKey(),
	name: text("name"),
	data: jsonb("data").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const tornGyms = pgTable("torn_gyms", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	stage: integer("stage").notNull(),
	cost: integer("cost").notNull(),
	energy: integer("energy").notNull(),
	strength: doublePrecision("strength").notNull(),
	speed: doublePrecision("speed").notNull(),
	defense: doublePrecision("defense").notNull(),
	dexterity: doublePrecision("dexterity").notNull(),
	note: text("note"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const travelDestinations = pgTable("travel_destinations", {
	id: text("id").primaryKey(),
	name: text("name"),
	stocks: jsonb("stocks").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const travelAreaMappings = pgTable("travel_area_mappings", {
	id: integer("id").primaryKey(),
	countryCode: text("country_code").notNull(),
	name: text("name").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});
