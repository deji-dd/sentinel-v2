import { describe, expect, it } from "bun:test";
import {
	ATTACK_FEED_CADENCE_MS,
	type AttackFeedActivity,
	cadenceForActivity,
	DEFAULT_ATTACK_FEED_CADENCE_MS,
} from "../src/lib/attack-feed-cadence";

/**
 * Replicates the tier-selection rule in `resolveAttackFeedActivity` so the two
 * independent checks can be exercised without a database.
 */
function selectTier(
	warEngaged: boolean,
	contractActive: boolean,
): AttackFeedActivity {
	if (warEngaged && contractActive) return "both";
	if (warEngaged) return "war";
	if (contractActive) return "contract";
	return "idle";
}

describe("Attack Feed Cadence", () => {
	describe("tier selection", () => {
		it("picks the fastest tier when both contract and war are engaged", () => {
			expect(selectTier(true, true)).toBe("both");
		});

		it("ramps up for a war with no merc contract", () => {
			expect(selectTier(true, false)).toBe("war");
		});

		it("ramps up for a merc contract with no war", () => {
			expect(selectTier(false, true)).toBe("contract");
		});

		it("ramps all the way down when neither is active", () => {
			expect(selectTier(false, false)).toBe("idle");
		});

		it("never returns to idle while exactly one source is engaged", () => {
			expect(selectTier(true, false)).not.toBe("idle");
			expect(selectTier(false, true)).not.toBe("idle");
		});
	});

	describe("cadenceForActivity", () => {
		it("polls at 5s whether one or both sources are engaged", () => {
			// Merc hits and the 5-minute Retal window are both time-sensitive, so
			// neither consumer is starved while the other is quiet.
			expect(cadenceForActivity("both")).toBe(5_000);
			expect(cadenceForActivity("war")).toBe(5_000);
			expect(cadenceForActivity("contract")).toBe(5_000);
		});

		it("keeps an engaged feed comfortably inside the retal window", () => {
			// A 5s poll gives 60 samples inside the 300s window, so even a badge
			// raised and cleared between two polls is unlikely to be missed.
			expect(300_000 / cadenceForActivity("war")).toBeGreaterThanOrEqual(10);
		});

		it("backs off hard only when nothing is engaged", () => {
			expect(cadenceForActivity("idle")).toBe(60_000);
			expect(cadenceForActivity("idle")).toBeGreaterThan(
				cadenceForActivity("war"),
			);
			expect(cadenceForActivity("idle")).toBeGreaterThan(
				cadenceForActivity("contract"),
			);
		});

		it("falls back to the idle default for an unknown tier", () => {
			expect(cadenceForActivity("bogus" as AttackFeedActivity)).toBe(
				DEFAULT_ATTACK_FEED_CADENCE_MS,
			);
		});
	});

	describe("cadence table", () => {
		it("defines every tier exactly once", () => {
			expect(Object.keys(ATTACK_FEED_CADENCE_MS).sort()).toEqual([
				"both",
				"contract",
				"idle",
				"war",
			]);
		});

		it("keeps the idle cadence as the boot default", () => {
			// Booting slow is deliberate: the first cycle re-evaluates activity
			// immediately, so nothing is delayed at startup.
			expect(DEFAULT_ATTACK_FEED_CADENCE_MS).toBe(ATTACK_FEED_CADENCE_MS.idle);
		});
	});
});
