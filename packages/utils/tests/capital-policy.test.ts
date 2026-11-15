import { describe, expect, test } from "bun:test";

import {
	CAPITAL_BASE_WEIGHT_PCT,
	CAPITAL_SIZING,
	capitalExitReasonLabel,
	capitalSlotPolicy,
	confidenceMultiplier,
	dailyReturnPct,
	drawdownPctFromPeak,
	isPriceOutlier,
	isStopCooldownActive,
} from "../src/capital-policy";

describe("capital policy", () => {
	test("position count and weight fit under the equity cap", () => {
		expect(
			CAPITAL_SIZING.minPositions * CAPITAL_SIZING.maxStockWeightPct,
		).toBeLessThanOrEqual(CAPITAL_SIZING.maxEquityPct);
		expect(CAPITAL_BASE_WEIGHT_PCT).toBeCloseTo(8, 6);
	});

	test("slot policy holds 7 slots at inception and grows with NAV", () => {
		const atInception = capitalSlotPolicy({ nav: 1_000, referenceNav: 1_000 });
		expect(atInception.maxPositions).toBe(7);
		expect(atInception.maxStockWeightPct).toBeCloseTo(12, 6);

		const doubled = capitalSlotPolicy({ nav: 2_000, referenceNav: 1_000 });
		expect(doubled.maxPositions).toBe(12);
		expect(doubled.maxStockWeightPct).toBeCloseTo(85 / 12, 6);

		const halfAgain = capitalSlotPolicy({ nav: 1_500, referenceNav: 1_000 });
		expect(halfAgain.maxPositions).toBe(10);
		expect(halfAgain.maxStockWeightPct).toBeCloseTo(8.5, 6);

		const belowInception = capitalSlotPolicy({
			nav: 800,
			referenceNav: 1_000,
		});
		expect(belowInception.maxPositions).toBe(7);
		expect(belowInception.maxStockWeightPct).toBeCloseTo(12, 6);

		const noReference = capitalSlotPolicy({ nav: 1_000, referenceNav: null });
		expect(noReference.maxPositions).toBe(7);
		expect(noReference.maxStockWeightPct).toBeCloseTo(12, 6);
	});

	test("every slot count fits the equity budget", () => {
		for (
			let slots = CAPITAL_SIZING.minPositions;
			slots <= CAPITAL_SIZING.maxPositions;
			slots++
		) {
			const growth = slots / CAPITAL_SIZING.minPositions;
			const policy = capitalSlotPolicy({
				nav: growth,
				referenceNav: 1,
			});
			expect(policy.maxPositions).toBe(slots);
			expect(
				policy.maxPositions * policy.maxStockWeightPct,
			).toBeLessThanOrEqual(CAPITAL_SIZING.maxEquityPct + 1e-9);
		}
	});

	test("confidence multiplier is bounded to 0.5–1.5", () => {
		expect(confidenceMultiplier(0)).toBeCloseTo(0.5, 6);
		expect(confidenceMultiplier(65)).toBeCloseTo(1.15, 6);
		expect(confidenceMultiplier(100)).toBeCloseTo(1.5, 6);
		expect(confidenceMultiplier(150)).toBeCloseTo(1.5, 6);
		expect(confidenceMultiplier(Number.NaN)).toBeCloseTo(0.5, 6);
	});

	test("stop cooldown blocks a re-entry inside the window", () => {
		const now = new Date("2026-11-12T12:00:00Z");
		const twoDaysAgo = new Date("2026-11-10T12:00:00Z");
		const fourDaysAgo = new Date("2026-11-08T12:00:00Z");
		expect(isStopCooldownActive(twoDaysAgo, now, 3)).toBe(true);
		expect(isStopCooldownActive(fourDaysAgo, now, 3)).toBe(false);
		expect(isStopCooldownActive(null, now, 3)).toBe(false);
		expect(isStopCooldownActive(twoDaysAgo, now, 0)).toBe(false);
	});

	test("drawdown and daily return are flow-insensitive NAV-per-unit maths", () => {
		expect(drawdownPctFromPeak(0.95, 1)).toBeCloseTo(-5, 6);
		expect(drawdownPctFromPeak(1.1, 1)).toBeCloseTo(10, 6);
		expect(drawdownPctFromPeak(1, 0)).toBeNull();
		expect(dailyReturnPct(0.98, 1)).toBeCloseTo(-2, 6);
		expect(dailyReturnPct(1, 0)).toBeNull();
	});

	test("rejects obviously corrupt price prints", () => {
		expect(isPriceOutlier(100, 101)).toBe(false);
		expect(isPriceOutlier(100, 120)).toBe(false);
		expect(isPriceOutlier(100, 130)).toBe(true);
		expect(isPriceOutlier(100, 10)).toBe(true);
		expect(isPriceOutlier(0, 10)).toBe(true);
		expect(isPriceOutlier(100, Number.NaN)).toBe(true);
	});

	test("exit reasons render as human labels", () => {
		expect(capitalExitReasonLabel("stop")).toBe("Hard stop");
		expect(capitalExitReasonLabel("reversal")).toBe("Mean reversion");
		expect(capitalExitReasonLabel("something_new")).toBe("something_new");
		expect(capitalExitReasonLabel(null)).toBeNull();
	});
});
