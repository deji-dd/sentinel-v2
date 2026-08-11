import { describe, expect, test } from "bun:test";
import {
	checkSector7Cooldown,
	checkTerritoryBurn,
	getBurnedTerritories,
} from "../src/lib/territory-burn-logic";
import type { WarRecord } from "../src/lib/territory-burn-logic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOURS_MS = 60 * 60 * 1000;
const FACTION_A = 100;
const FACTION_B = 200;

/** Build a minimal WarRecord at `hoursAgo` hours in the past. */
function makeWar(
	overrides: Partial<WarRecord> & { hoursAgo: number },
): WarRecord {
	const { hoursAgo, ...rest } = overrides;
	return {
		id: `WAR_TEST_${Math.random()}`,
		tt: "AAA",
		assaultingFaction: FACTION_A,
		defendingFaction: FACTION_B,
		victorFaction: FACTION_B,
		startTime: new Date(Date.now() - hoursAgo * HOURS_MS),
		endTime: null,
		...rest,
	} as WarRecord;
}

// ---------------------------------------------------------------------------
// checkTerritoryBurn
// ---------------------------------------------------------------------------

describe("checkTerritoryBurn", () => {
	test("returns canAssault=true when no war history exists for the territory", () => {
		const result = checkTerritoryBurn("AAA", FACTION_A, [], 5);
		expect(result.canAssault).toBe(true);
		expect(result.reasons).toHaveLength(0);
	});

	test("returns canAssault=true for war on a different territory", () => {
		const war = makeWar({
			hoursAgo: 10,
			tt: "BBB",
			assaultingFaction: FACTION_A,
			victorFaction: FACTION_B,
		});
		const result = checkTerritoryBurn("AAA", FACTION_A, [war], 5);
		expect(result.canAssault).toBe(true);
	});

	test("burns territory when faction lost a war on it within 72h", () => {
		const war = makeWar({
			hoursAgo: 10,
			tt: "AAA",
			assaultingFaction: FACTION_A,
			defendingFaction: FACTION_B,
			victorFaction: FACTION_B, // faction A lost
		});
		const result = checkTerritoryBurn("AAA", FACTION_A, [war], 5);
		expect(result.canAssault).toBe(false);
		expect(result.reasons.some((r) => /Lost war/.test(r))).toBe(true);
		expect(result.hoursRemaining).toBeGreaterThan(0);
	});

	test("clears loss burn after 72h has elapsed", () => {
		const war = makeWar({
			hoursAgo: 73, // just past the 72h window
			tt: "AAA",
			assaultingFaction: FACTION_A,
			victorFaction: FACTION_B,
		});
		const result = checkTerritoryBurn("AAA", FACTION_A, [war], 5);
		expect(result.canAssault).toBe(true);
	});

	test("burns territory via 90-day rule when ANY faction warred within 72h and ours was involved historically", () => {
		const factionsWar = makeWar({
			hoursAgo: 80, // our faction's war is outside 72h window — loss rule won't trigger
			tt: "AAA",
			assaultingFaction: FACTION_A,
			defendingFaction: FACTION_B,
			victorFaction: FACTION_A, // we won, so loss rule is N/A
		});
		const anyFactionWar = makeWar({
			hoursAgo: 5, // a different faction fought on the same territory recently
			tt: "AAA",
			assaultingFaction: 300,
			defendingFaction: 400,
			victorFaction: 300,
		});
		// Pass wars with most recent first (as the DB would return them)
		const result = checkTerritoryBurn(
			"AAA",
			FACTION_A,
			[anyFactionWar, factionsWar],
			5,
		);
		expect(result.canAssault).toBe(false);
		expect(result.reasons.some((r) => /90-day rule/.test(r))).toBe(true);
	});

	test("does NOT apply 90-day rule when faction was never involved in this territory", () => {
		const unrelatedWar = makeWar({
			hoursAgo: 5,
			tt: "AAA",
			assaultingFaction: 300,
			defendingFaction: 400,
			victorFaction: 300,
		});
		// FACTION_A has no history on AAA — 90-day rule should not apply
		const result = checkTerritoryBurn("AAA", FACTION_A, [unrelatedWar], 5);
		expect(result.canAssault).toBe(true);
	});

	test("normalises territory ID casing (lower vs upper)", () => {
		const war = makeWar({
			hoursAgo: 10,
			tt: "aaa",
			assaultingFaction: FACTION_A,
			victorFaction: FACTION_B,
		});
		const result = checkTerritoryBurn("AAA", FACTION_A, [war], 5);
		// Case-insensitive match — loss rule should fire
		expect(result.canAssault).toBe(false);
	});

	test("hoursRemaining reflects the maximum of both rules when both fire", () => {
		const lossWar = makeWar({
			hoursAgo: 5, // loss 5h ago → 67h remaining
			tt: "AAA",
			assaultingFaction: FACTION_A,
			victorFaction: FACTION_B,
		});
		// Same war triggers both the loss rule AND the 90-day "any faction" rule
		const result = checkTerritoryBurn("AAA", FACTION_A, [lossWar], 5);
		expect(result.canAssault).toBe(false);
		expect(result.hoursRemaining).toBeGreaterThanOrEqual(67);
	});
});

// ---------------------------------------------------------------------------
// getBurnedTerritories
// ---------------------------------------------------------------------------

describe("getBurnedTerritories", () => {
	test("returns empty array when no territories are burned", () => {
		const burned = getBurnedTerritories(FACTION_A, ["AAA", "BBB"], [], 5);
		expect(burned).toHaveLength(0);
	});

	test("returns only the burned territory IDs", () => {
		const recentLoss = makeWar({
			hoursAgo: 10,
			tt: "AAA",
			assaultingFaction: FACTION_A,
			victorFaction: FACTION_B,
		});
		// BBB has no war history
		const burned = getBurnedTerritories(
			FACTION_A,
			["AAA", "BBB"],
			[recentLoss],
			5,
		);
		expect(burned).toContain("AAA");
		expect(burned).not.toContain("BBB");
	});

	test("handles an empty territory list without throwing", () => {
		const burned = getBurnedTerritories(FACTION_A, [], [], 0);
		expect(burned).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// checkSector7Cooldown
// ---------------------------------------------------------------------------

describe("checkSector7Cooldown", () => {
	test("not on cooldown when faction holds at least one territory", () => {
		const result = checkSector7Cooldown(FACTION_A, [], 1);
		expect(result.isOnCooldown).toBe(false);
	});

	test("not on cooldown when faction has 0 territories but no recent losses", () => {
		const oldLoss = makeWar({
			hoursAgo: 80, // outside 72h window
			tt: "AAA",
			assaultingFaction: FACTION_A,
			victorFaction: FACTION_B,
		});
		const result = checkSector7Cooldown(FACTION_A, [oldLoss], 0);
		expect(result.isOnCooldown).toBe(false);
	});

	test("on cooldown when faction has 0 territories and lost within 72h", () => {
		const recentLoss = makeWar({
			hoursAgo: 10,
			tt: "AAA",
			assaultingFaction: FACTION_A,
			victorFaction: FACTION_B,
		});
		const result = checkSector7Cooldown(FACTION_A, [recentLoss], 0);
		expect(result.isOnCooldown).toBe(true);
		expect(result.hoursRemaining).toBeGreaterThan(0);
		expect(result.hoursRemaining).toBeLessThanOrEqual(72);
	});

	test("not on cooldown when faction with 0 territories has no loss history at all", () => {
		const result = checkSector7Cooldown(FACTION_A, [], 0);
		expect(result.isOnCooldown).toBe(false);
	});

	test("uses most recent loss for cooldown calculation (wars ordered recent-first)", () => {
		const olderLoss = makeWar({
			hoursAgo: 60,
			tt: "BBB",
			assaultingFaction: FACTION_A,
			victorFaction: FACTION_B,
		});
		const recentLoss = makeWar({
			hoursAgo: 5,
			tt: "AAA",
			assaultingFaction: FACTION_A,
			victorFaction: FACTION_B,
		});
		// Most recent first (mimics DB ordering)
		const result = checkSector7Cooldown(
			FACTION_A,
			[recentLoss, olderLoss],
			0,
		);
		expect(result.isOnCooldown).toBe(true);
		// hoursRemaining should reflect the 5h-ago loss (~67h left), not the 60h-ago one (~12h left)
		expect(result.hoursRemaining).toBeGreaterThan(12);
	});
});
