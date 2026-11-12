import { describe, expect, test } from "bun:test";

import {
	CAPITAL_BASE_WEIGHT_PCT,
	CAPITAL_SIZING,
	capitalExitReasonLabel,
	confidenceMultiplier,
	dailyReturnPct,
	drawdownPctFromPeak,
	isPriceOutlier,
	isStopCooldownActive,
} from "../src/capital-policy";

describe("capital policy", () => {
	test("position count and weight fit under the equity cap", () => {
		expect(
			CAPITAL_SIZING.maxPositions * CAPITAL_SIZING.maxStockWeightPct,
		).toBeLessThanOrEqual(CAPITAL_SIZING.maxEquityPct);
		expect(CAPITAL_BASE_WEIGHT_PCT).toBeCloseTo(8, 6);
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
