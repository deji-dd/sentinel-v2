import { describe, expect, it } from "bun:test";
import {
	DISQUALIFYING_RESULTS,
	isLandedHit,
} from "../src/workers/merc/merc-attack-validator-worker";
import { qualifiesAsRankedWarHit } from "../src/workers/subversive/hit-counter";

const WAR_START = 1_800_000_000;
const OPPONENT_FACTION_ID = 16312;

const context = {
	start: WAR_START,
	opponentFactionId: OPPONENT_FACTION_ID,
};

const landedHit = (overrides: Record<string, unknown> = {}) => ({
	direction: "outgoing",
	isRankedWar: true,
	attackerId: 555,
	defenderFactionId: OPPONENT_FACTION_ID,
	startedAt: WAR_START + 60,
	result: "Hospitalized",
	...overrides,
});

describe("Ranked War Hit Counter - Qualifying Rules", () => {
	it("counts a landed ranked war hit on the opponent", () => {
		expect(qualifiesAsRankedWarHit(landedHit(), context)).toBe(true);
	});

	it("counts a non-hospitalized landed attack such as Attacked", () => {
		expect(
			qualifiesAsRankedWarHit(landedHit({ result: "Attacked" }), context),
		).toBe(true);
	});

	describe("landed-only exclusion", () => {
		for (const result of [
			"Lost",
			"Stalemate",
			"Escape",
			"Assist",
			"Interrupted",
			"Timeout",
		]) {
			it(`excludes ${result}`, () => {
				expect(qualifiesAsRankedWarHit(landedHit({ result }), context)).toBe(
					false,
				);
			});
		}

		it("excludes a missing result rather than defaulting to a hit", () => {
			expect(
				qualifiesAsRankedWarHit(landedHit({ result: null }), context),
			).toBe(false);
		});
	});

	describe("ranked war requirement", () => {
		it("excludes attacks outside a ranked war", () => {
			expect(
				qualifiesAsRankedWarHit(landedHit({ isRankedWar: false }), context),
			).toBe(false);
		});
	});

	describe("direction requirement", () => {
		it("excludes incoming attacks on our own members", () => {
			expect(
				qualifiesAsRankedWarHit(landedHit({ direction: "incoming" }), context),
			).toBe(false);
		});
	});

	describe("opponent faction scoping", () => {
		it("excludes hits on a faction that is not the war opponent", () => {
			expect(
				qualifiesAsRankedWarHit(
					landedHit({ defenderFactionId: 99999 }),
					context,
				),
			).toBe(false);
		});

		it("excludes hits on our own faction", () => {
			expect(
				qualifiesAsRankedWarHit(
					landedHit({ defenderFactionId: 2013 }),
					context,
				),
			).toBe(false);
		});

		it("excludes everything when the opponent is unknown", () => {
			expect(
				qualifiesAsRankedWarHit(landedHit(), {
					start: WAR_START,
					opponentFactionId: null,
				}),
			).toBe(false);
		});
	});

	describe("war boundary", () => {
		it("counts an attack exactly at the war start", () => {
			expect(
				qualifiesAsRankedWarHit(landedHit({ startedAt: WAR_START }), context),
			).toBe(true);
		});

		it("excludes an attack from before this war began", () => {
			expect(
				qualifiesAsRankedWarHit(
					landedHit({ startedAt: WAR_START - 1 }),
					context,
				),
			).toBe(false);
		});

		it("excludes attacks when the war start is unknown", () => {
			expect(
				qualifiesAsRankedWarHit(landedHit(), {
					start: null,
					opponentFactionId: OPPONENT_FACTION_ID,
				}),
			).toBe(false);
		});

		it("excludes attacks with no start timestamp", () => {
			expect(
				qualifiesAsRankedWarHit(landedHit({ startedAt: null }), context),
			).toBe(false);
		});
	});

	describe("attacker requirement", () => {
		it("excludes attacks with no resolvable attacker", () => {
			expect(
				qualifiesAsRankedWarHit(landedHit({ attackerId: null }), context),
			).toBe(false);
			expect(
				qualifiesAsRankedWarHit(landedHit({ attackerId: 0 }), context),
			).toBe(false);
		});
	});

	describe("isLandedHit shared with merc validation", () => {
		it("rejects a missing result rather than defaulting to a hit", () => {
			expect(isLandedHit(null)).toBe(false);
			expect(isLandedHit(undefined)).toBe(false);
			expect(isLandedHit("")).toBe(false);
		});

		it("accepts landed outcomes", () => {
			expect(isLandedHit("Hospitalized")).toBe(true);
			expect(isLandedHit("Attacked")).toBe(true);
		});

		it("rejects every disqualifying outcome", () => {
			for (const result of DISQUALIFYING_RESULTS) {
				expect(isLandedHit(result)).toBe(false);
			}
		});
	});
});
