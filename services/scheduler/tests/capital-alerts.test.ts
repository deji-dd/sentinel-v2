import { describe, expect, test } from "bun:test";

import { parseMoney } from "@sentinel/utils";

import {
	detectPriceTrend,
	formatTrendAlert,
	type TrendPoint,
} from "../src/workers/capital/alerts";

const PERIODS = 3;
const MIN_MOVE_PCT = 1;

function series(values: string[]): TrendPoint[] {
	return values.map((navPerUnit) => ({ navPerUnit }));
}

describe("capital unit-price trend insights", () => {
	test("words a rise as 'has risen by x% in y hours'", () => {
		const alert = formatTrendAlert(
			{ direction: "up", changePct: 1.25 },
			PERIODS,
		);
		expect(alert.body).toBe("Unit price has risen by 1.25% in 3 hours.");
		expect(alert.changeLabel).toBe("+1.25%");
	});

	test("words a fall as 'has fallen by x% in y hours'", () => {
		const alert = formatTrendAlert(
			{ direction: "down", changePct: -2.5 },
			PERIODS,
		);
		expect(alert.body).toBe("Unit price has fallen by 2.50% in 3 hours.");
		expect(alert.changeLabel).toBe("-2.50%");
	});

	test("detects a meaningful three-hour rise", () => {
		const trend = detectPriceTrend(
			series(["1.0000", "1.0040", "1.0080", "1.0120"]),
			parseMoney("1.0120"),
			PERIODS,
			MIN_MOVE_PCT,
		);
		expect(trend?.direction).toBe("up");
		expect(trend?.changePct).toBeCloseTo(1.2, 6);
	});

	test("detects a meaningful three-hour fall", () => {
		const trend = detectPriceTrend(
			series(["1.0200", "1.0160", "1.0120", "1.0080"]),
			parseMoney("1.0080"),
			PERIODS,
			MIN_MOVE_PCT,
		);
		expect(trend?.direction).toBe("down");
	});

	test("ignores sub-cent noise while the unit price sits at par", () => {
		expect(
			detectPriceTrend(
				series(["1.0000", "1.0001", "1.0002", "1.0003"]),
				parseMoney("1.0003"),
				PERIODS,
				MIN_MOVE_PCT,
			),
		).toBeNull();
	});

	test("ignores flat hourly snapshots", () => {
		expect(
			detectPriceTrend(
				series(["1.0000", "1.0000", "1.0000", "1.0000"]),
				parseMoney("1.0000"),
				PERIODS,
				MIN_MOVE_PCT,
			),
		).toBeNull();
	});

	test("ignores a streak whose current mark has already reversed", () => {
		expect(
			detectPriceTrend(
				series(["1.0000", "1.0050", "1.0100", "1.0150"]),
				parseMoney("1.0010"),
				PERIODS,
				MIN_MOVE_PCT,
			),
		).toBeNull();
	});

	test("ignores mixed directions and too-short history", () => {
		expect(
			detectPriceTrend(
				series(["1.0000", "1.0100", "0.9900", "1.0000"]),
				parseMoney("1.0000"),
				PERIODS,
				MIN_MOVE_PCT,
			),
		).toBeNull();
		expect(
			detectPriceTrend(
				series(["1.0000", "1.0100", "1.0200"]),
				parseMoney("1.0200"),
				PERIODS,
				MIN_MOVE_PCT,
			),
		).toBeNull();
	});
});
