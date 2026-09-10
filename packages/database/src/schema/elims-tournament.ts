import {
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const elimsTeams = pgTable("elims_teams", {
	id: integer("id").primaryKey(), // 70, 80-90
	name: text("name").notNull(),
	score: integer("score").default(0).notNull(),
	attacks: integer("attacks").default(0).notNull(),
	membersCount: integer("members_count").default(0).notNull(),
	lives: integer("lives").default(50).notNull(),
	wins: integer("wins").default(0).notNull(),
	losses: integer("losses").default(0).notNull(),
	position: integer("position").default(0).notNull(),
	eliminated: boolean("eliminated").default(false).notNull(),
	eliminatedTimestamp: timestamp("eliminated_timestamp", {
		withTimezone: true,
		mode: "date",
	}),
	leaders: jsonb("leaders").$type<unknown>(),
	isMock: boolean("is_mock").default(false).notNull(),
	lastSyncedAt: timestamp("last_synced_at", {
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

export const elimsTeamPlayers = pgTable("elims_team_players", {
	id: integer("id").primaryKey(), // Torn User ID
	teamId: integer("team_id").notNull(),
	name: text("name").notNull(),
	level: integer("level").default(1).notNull(),
	score: integer("score").default(0).notNull(),
	attacks: integer("attacks").default(0).notNull(),
	lastAction: jsonb("last_action").$type<{
		status: "Online" | "Idle" | "Offline";
		timestamp: number;
		relative: string;
	}>(),
	status: jsonb("status").$type<{
		description: string;
		details: string | null;
		state: string;
		color: string;
		until: number | null;
		plane_image_type?: string;
	}>(),
	isMock: boolean("is_mock").default(false).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const elimsTeamSnapshots = pgTable("elims_team_snapshots", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	teamId: integer("team_id").notNull(),
	score: integer("score").default(0).notNull(),
	attacks: integer("attacks").default(0).notNull(),
	membersCount: integer("members_count").default(0).notNull(),
	activeCount: integer("active_count").default(0).notNull(),
	lives: integer("lives").default(50).notNull(),
	position: integer("position").default(0).notNull(),
	eliminated: boolean("eliminated").default(false).notNull(),
	hourTct: integer("hour_tct").notNull(), // 0-23 TCT hour
	isMock: boolean("is_mock").default(false).notNull(),
	capturedAt: timestamp("captured_at", {
		withTimezone: true,
		mode: "date",
	})
		.defaultNow()
		.notNull(),
});

export const elimsMemberStats = pgTable("elims_member_stats", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	guildId: text("guild_id").notNull(),
	discordId: text("discord_id").notNull().unique(),
	discordUsername: text("discord_username"),
	discordNickname: text("discord_nickname"),
	roles: jsonb("roles").$type<string[]>().default([]).notNull(),
	tornId: integer("torn_id"),
	tornName: text("torn_name"),
	tornLevel: integer("torn_level"),
	tornProfile: jsonb("torn_profile"),
	ffScouterStats: jsonb("ff_scouter_stats").$type<Record<string, unknown>>(),
	bsEstimate: doublePrecision("bs_estimate"),
	bsEstimateHuman: text("bs_estimate_human"),
	fairFight: doublePrecision("fair_fight"),
	networth: doublePrecision("networth"),
	source: text("source"), // 'bss' | 'premium' | 'spies' | 'unlinked' | 'none'
	lastFetchedAt: timestamp("last_fetched_at", {
		withTimezone: true,
		mode: "date",
	})
		.defaultNow()
		.notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.defaultNow()
		.notNull(),
});

export const elimsTeamAttacks = pgTable(
	"elims_team_attacks",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		attackerId: integer("attacker_id").notNull(),
		attackerName: text("attacker_name").notNull(),
		attackerTeamId: integer("attacker_team_id").notNull(),
		victimId: integer("victim_id").notNull(),
		victimName: text("victim_name").notNull(),
		victimTeamId: integer("victim_team_id").notNull(),
		hospitalUntil: integer("hospital_until").notNull(),
		details: text("details"),
		isMock: boolean("is_mock").default(false).notNull(),
		detectedAt: timestamp("detected_at", {
			withTimezone: true,
			mode: "date",
		})
			.defaultNow()
			.notNull(),
	},
	(table) => [
		uniqueIndex("elims_attacks_victim_until_idx").on(
			table.victimId,
			table.hospitalUntil,
		),
		index("elims_attacks_attacker_team_idx").on(table.attackerTeamId),
		index("elims_attacks_victim_team_idx").on(table.victimTeamId),
		index("elims_attacks_detected_at_idx").on(table.detectedAt),
	],
);
