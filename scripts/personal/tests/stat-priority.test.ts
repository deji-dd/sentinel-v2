import { describe, expect, test } from "bun:test";
import { analyseStatPriority, type GymProfile } from "../src/lib/stat-priority";
import type { StatType } from "../src/types";

/**
 * Coverage for the shared stat-priority engine.
 *
 * Two bugs prompted extracting this: the Battlestats tab scored against a hardcoded
 * gym while the gym page scored against the selected one (so the two surfaces could
 * name different stats), and an on-target player was told to train strength because
 * on-target stats were scored -1 and then sorted, leaving a real stat on top of the
 * list while the same card's subtitle read "On target".
 */

const GYM: GymProfile = {
	name: "George's",
	energy: 10,
	strength: 7.5,
	defense: 7.5,
	speed: 7.5,
	dexterity: 7.5,
};

/** A faster gym for one attribute, to prove efficiency moves the recommendation. */
const SPECIALIST: GymProfile = {
	name: "Specialist",
	energy: 10,
	strength: 7.5,
	defense: 7.5,
	speed: 7.5,
	dexterity: 10,
};

const BALDR: Record<StatType, number> = {
	strength: 0.3086,
	defense: 0.2222,
	speed: 0.2469,
	dexterity: 0.2222,
};

function statsOf(values: Record<StatType, number>): Record<StatType, number> {
	return values;
}

describe("analyseStatPriority", () => {
	test("recommends the attribute that is behind its ratio target", () => {
		const result = analyseStatPriority({
			stats: statsOf({
				strength: 400_000_000,
				defense: 300_000_000,
				speed: 200_000_000,
				dexterity: 300_000_000,
			}),
			ratios: BALDR,
			fallbackGym: GYM,
			maxHappy: 5025,
		});

		// 1.2B total: strength should hold 370M, speed 296M, defence/dex 267M each.
		// Speed is 96M short of a ~296M target, the largest relative deficit.
		expect(result.recommended?.statType).toBe("speed");
		expect(result.allOnTarget).toBe(false);
		expect(result.rows).toHaveLength(4);
	});

	test("returns no recommendation when every attribute is on target", () => {
		// Exactly on target for all four: the old code sorted four -1 scores and
		// returned strength, which read as "train strength" next to "On target".
		const result = analyseStatPriority({
			stats: statsOf({
				strength: 308_600,
				defense: 222_200,
				speed: 246_900,
				dexterity: 222_300,
			}),
			ratios: BALDR,
			fallbackGym: GYM,
			maxHappy: 5025,
		});

		expect(result.recommended).toBeNull();
		expect(result.allOnTarget).toBe(true);
		expect(result.ranked).toHaveLength(0);
		// Every row still reports its own numbers for the ratio bars.
		expect(result.rows.every((row) => row.isOnTarget)).toBe(true);
		expect(result.rows.every((row) => row.priorityScore === 0)).toBe(true);
	});

	test("treats a surplus attribute as on target but still ranks the deficit ones", () => {
		const result = analyseStatPriority({
			stats: statsOf({
				strength: 600_000_000,
				defense: 100_000_000,
				speed: 100_000_000,
				dexterity: 100_000_000,
			}),
			ratios: BALDR,
			fallbackGym: GYM,
			maxHappy: 5025,
		});

		expect(result.recommended).not.toBeNull();
		expect(result.recommended?.statType).not.toBe("strength");
		expect(
			result.rows.find((row) => row.statType === "strength")?.isOnTarget,
		).toBe(true);
	});

	test("uses the gym supplied per attribute, so the same account scores the same way", () => {
		const stats = statsOf({
			strength: 300_000_000,
			defense: 300_000_000,
			speed: 300_000_000,
			dexterity: 300_000_000,
		});

		const flat = analyseStatPriority({
			stats,
			ratios: BALDR,
			fallbackGym: GYM,
			maxHappy: 5025,
		});
		const specialised = analyseStatPriority({
			stats,
			ratios: BALDR,
			gyms: {
				strength: SPECIALIST,
				defense: SPECIALIST,
				speed: SPECIALIST,
				dexterity: SPECIALIST,
			},
			fallbackGym: GYM,
			maxHappy: 5025,
		});

		// Same ratios, a better gym for dexterity: the gain per energy must move, and
		// with dexterity already ahead of target it must not change the recommendation.
		const flatDex = flat.rows.find((row) => row.statType === "dexterity");
		const fastDex = specialised.rows.find(
			(row) => row.statType === "dexterity",
		);
		expect(fastDex?.gainPerE).toBeGreaterThan(flatDex?.gainPerE ?? 0);
		expect(specialised.recommended?.statType).toBe(flat.recommended?.statType);
	});

	test("reports the largest deficit for context even when nothing is recommended", () => {
		const result = analyseStatPriority({
			stats: statsOf({
				strength: 350_000_000,
				defense: 300_000_000,
				speed: 200_000_000,
				dexterity: 250_000_000,
			}),
			ratios: BALDR,
			fallbackGym: GYM,
			maxHappy: 5025,
		});

		expect(result.largestDeficit?.statType).toBe("speed");
		expect(
			result.rows.find((row) => row.statType === "speed")?.deficitPct,
		).toBeGreaterThan(0);
	});

	test("survives an empty payload without dividing by zero", () => {
		const result = analyseStatPriority({
			stats: statsOf({ strength: 0, defense: 0, speed: 0, dexterity: 0 }),
			ratios: BALDR,
			fallbackGym: GYM,
			maxHappy: 5025,
		});

		expect(result.recommended).toBeNull();
		expect(result.allOnTarget).toBe(true);
		expect(result.rows.every((row) => Number.isFinite(row.gainPerE))).toBe(
			true,
		);
		expect(result.rows.every((row) => Number.isFinite(row.priorityScore))).toBe(
			true,
		);
	});

	test("applies per-stat perks when scoring", () => {
		const base = analyseStatPriority({
			stats: statsOf({
				strength: 200_000_000,
				defense: 300_000_000,
				speed: 300_000_000,
				dexterity: 300_000_000,
			}),
			ratios: BALDR,
			fallbackGym: GYM,
			maxHappy: 5025,
		});
		const withPerk = analyseStatPriority({
			stats: statsOf({
				strength: 200_000_000,
				defense: 300_000_000,
				speed: 300_000_000,
				dexterity: 300_000_000,
			}),
			ratios: BALDR,
			fallbackGym: GYM,
			maxHappy: 5025,
			perks: { strength: 1.5, defense: 1, speed: 1, dexterity: 1 },
		});

		const baseStrength = base.rows.find((row) => row.statType === "strength");
		const perkStrength = withPerk.rows.find(
			(row) => row.statType === "strength",
		);
		expect(perkStrength?.gainPerE).toBeGreaterThan(baseStrength?.gainPerE ?? 0);
	});
});
