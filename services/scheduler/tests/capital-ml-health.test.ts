import { describe, expect, test } from "bun:test";

import {
	shadowDrawdownPct,
	weightedCalibrationError,
} from "../src/workers/capital/ml-health";

describe("capital ML health guard", () => {
	test("calibration error is small when bucket probabilities match outcomes", () => {
		// 0.25 entries all lose and 0.75 entries all win; bucket midpoints are
		// 0.3 and 0.7, so the residual is the bucket granularity, not drift.
		const probabilities = [0.25, 0.25, 0.75, 0.75];
		const labels = [0, 0, 1, 1];
		expect(weightedCalibrationError(probabilities, labels)).toBeCloseTo(
			0.25,
			10,
		);
	});

	test("calibration error rises when observed rates diverge", () => {
		const error = weightedCalibrationError([0.2, 0.2, 0.2, 0.2], [1, 1, 0, 0]);
		expect(error).toBeCloseTo(0.3, 10);
	});

	test("shadow drawdown compounds the return path", () => {
		expect(shadowDrawdownPct([0.1, -0.05, 0.02])).toBeGreaterThan(0);
		expect(shadowDrawdownPct([0.01, 0.02, 0.03])).toBe(0);
		expect(shadowDrawdownPct([-0.1, -0.1])).toBeGreaterThan(0.1);
	});
});
