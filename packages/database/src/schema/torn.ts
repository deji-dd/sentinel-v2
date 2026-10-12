import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	doublePrecision,
	index,
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

export const warLedgers = pgTable(
	"war_ledgers",
	{
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
	},
	(table) => [
		// The territory engine reads open wars (`end_time IS NULL`) on every cycle.
		// A partial index stays tiny while the table accumulates every war forever.
		index("idx_war_ledgers_open")
			.on(table.endTime)
			.where(sql`${table.endTime} IS NULL`),
		// Retention pruning deletes by end_time; without this it seq-scans.
		index("idx_war_ledgers_end_time").on(table.endTime),
	],
);

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

export const tornUsers = pgTable("torn_users", {
	tornId: integer("torn_id").primaryKey(),
	name: text("name").notNull(),
	discordId: text("discord_id").unique(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export type TornUser = typeof tornUsers.$inferSelect;
export type NewTornUser = typeof tornUsers.$inferInsert;

/**
 * Official annual Torn calendar activities (competitions & events)
 * fetched from /torn/calendar by the scheduler reference sync worker.
 */
export const tornCalendarActivities = pgTable(
	"torn_calendar_activities",
	{
		id: text("id").primaryKey(),
		title: text("title").notNull(),
		description: text("description").default("").notNull(),
		/** 'competition' | 'event' */
		type: text("type").notNull(),
		/** Unix start timestamp in seconds */
		start: integer("start").notNull(),
		/** Unix end timestamp in seconds */
		end: integer("end").notNull(),
		/** Timestamp start */
		startTime: timestamp("start_time", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		/** Timestamp end */
		endTime: timestamp("end_time", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		/** This value is false if the event uses personal calendar time. */
		fixedStartTime: boolean("fixed_start_time").default(false).notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("idx_torn_calendar_activities_type").on(table.type),
		index("idx_torn_calendar_activities_start").on(table.start),
		index("idx_torn_calendar_activities_end").on(table.end),
	],
);

export type TornCalendarActivityRow =
	typeof tornCalendarActivities.$inferSelect;
export type NewTornCalendarActivityRow =
	typeof tornCalendarActivities.$inferInsert;

/**
 * Reference key for the points market price in {@link tornMarketPrices}.
 *
 * Shared by the sampler and every reader so the key cannot drift between them —
 * the legacy blob key it replaces (`points_market_price`) is now only a
 * historical note.
 */
export const POINTS_MARKET_PRICE_KEY = "points";

/**
 * Scalar market references sampled from Torn, addressed by a stable key.
 *
 * Replaces the `points_market_price` row in the legacy `system_states` blob,
 * which stored `{ "price": <number> }` as untyped JSON. That column accepted a
 * double-encoded value (JSON stored as a JSON *string*) without complaint, and
 * every reader guarded with `typeof data === "object"` — so a corrupt row
 * silently degraded to "price unknown" and points payouts were valued at zero
 * instead of the problem being visible. A typed numeric column makes that state
 * unrepresentable.
 *
 * The only key in use is `points` (dollars per point, volume-weighted across the
 * top of the market), sampled daily by the Torn reference sync.
 */
export const tornMarketPrices = pgTable("torn_market_prices", {
	/** Stable reference key, e.g. `points`. */
	refKey: text("ref_key").primaryKey(),
	/** Dollars per unit. `bigint` for headroom; the sampler rounds to an integer. */
	price: bigint("price", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export type TornMarketPriceRow = typeof tornMarketPrices.$inferSelect;
export type NewTornMarketPriceRow = typeof tornMarketPrices.$inferInsert;
