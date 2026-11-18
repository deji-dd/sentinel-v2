import { describe, expect, test } from "bun:test";

import {
	adjustForCorporateActions,
	auc,
	brierScore,
	calibrationBuckets,
	CAPITAL_ML_FEATURES,
	CAPITAL_SALE_FEE_PCT,
	capitalMlFeatureVector,
	detectCorporateActions,
	evaluateTripleBarrier,
	featureStats,
	fitLogistic,
	logLoss,
	predictProbability,
	sigmoid,
	standardise,
} from "../src/capital-ml";
import { computeFeatures } from "../src/capital-signals";

function syntheticRows(count: number): { rows: number[][]; labels: number[] } {
	const rows: number[][] = [];
	const labels: number[] = [];
	for (let i = 0; i < count; i++) {
		const x = (i / count) * 10 - 5;
		const noise = Math.sin(i) * 0.2;
		rows.push([x, noise, x * 0.5]);
		labels.push(x > 0 ? 1 : 0);
	}
	return { rows, labels };
}

describe("capital ml", () => {
	test("sigmoid is stable at the extremes", () => {
		expect(sigmoid(0)).toBe(0.5);
		expect(sigmoid(1000)).toBe(1);
		expect(sigmoid(-1000)).toBe(0);
		expect(sigmoid(2)).toBeCloseTo(0.8808, 3);
	});

	test("feature vector matches the declared feature list", () => {
		const candles = Array.from({ length: 120 }, (_, i) => ({
			timestamp: Date.UTC(2025, 0, 1) / 1000 + i * 86_400,
			open: 100,
			high: 101,
			low: 99,
			close: 100 + Math.sin(i / 4),
			shares: 1_000_000 + i * 100,
		}));
		const last = candles[candles.length - 1];
		const features = computeFeatures({
			stockId: 1,
			price: last?.close ?? 100,
			candles,
			regimeOn: true,
		});
		expect(features).not.toBeNull();
		if (!features) return;
		const vector = capitalMlFeatureVector(features);
		expect(vector).toHaveLength(CAPITAL_ML_FEATURES.length);
		expect(vector.every((value) => Number.isFinite(value))).toBe(true);
	});

	test("logistic regression learns a separable boundary", () => {
		const { rows, labels } = syntheticRows(200);
		const { mean, std } = featureStats(rows);
		const scaled = standardise(rows, mean, std);
		const { intercept, weights } = fitLogistic(scaled, labels, { l2: 0.1 });
		const model = {
			intercept,
			weights,
			mean,
			std,
			features: CAPITAL_ML_FEATURES,
			targetPct: 2,
			stopPct: 2,
			horizonDays: 20,
		};
		const probabilities = scaled.map((row, i) => {
			const original = rows[i] ?? [];
			return predictProbability(model, original);
		});
		expect(auc(probabilities, labels)).toBeGreaterThan(0.95);
		expect(brierScore(probabilities, labels)).toBeLessThan(0.1);
		expect(logLoss(probabilities, labels)).toBeLessThan(0.3);
	});

	test("metrics behave on a known ranking", () => {
		expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
		expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
		expect(auc([0.5, 0.5], [1, 0])).toBe(0.5);
		expect(brierScore([1, 0], [1, 0])).toBe(0);
		expect(logLoss([0.9, 0.1], [1, 0])).toBeGreaterThan(0);
		const buckets = calibrationBuckets([0.1, 0.9, 0.6, 0.51], [0, 1, 1, 0], 2);
		expect(buckets).toHaveLength(2);
		expect(buckets[0]?.count).toBe(1);
	});

	test("triple barrier uses high/low, stop-first, fee and timeout", () => {
		const bars = (high: number, low: number, close = (high + low) / 2) => ({
			high,
			low,
			close,
		});
		expect(
			evaluateTripleBarrier(100, [bars(101, 99), bars(102.1, 99)], 2, 2),
		).toMatchObject({ outcome: "target", label: 1 });
		expect(
			evaluateTripleBarrier(100, [bars(101, 99), bars(101, 97.9)], 2, 2),
		).toMatchObject({ outcome: "stop", label: 0 });
		// Same-bar target + stop is resolved conservatively as the stop.
		expect(evaluateTripleBarrier(100, [bars(103, 97)], 2, 2)).toMatchObject({
			outcome: "stop",
			label: 0,
		});
		// Neither barrier: a third outcome with the real horizon return.
		const timeout = evaluateTripleBarrier(
			100,
			[bars(101, 99, 101), bars(101, 99, 100.5)],
			2,
			2,
		);
		expect(timeout.outcome).toBe("timeout");
		expect(timeout.returnPct).toBeCloseTo(100.5 * 0.999 - 100, 6);
		// The 0.1% sale fee is charged on the exit only.
		const target = evaluateTripleBarrier(100, [bars(102.1, 99)], 2, 2);
		expect(target.returnPct).toBeCloseTo(
			100 * 1.02 * (1 - CAPITAL_SALE_FEE_PCT / 100) - 100,
			6,
		);
	});

	test("corporate actions are detected and rebased out of the series", () => {
		const base = Date.UTC(2025, 0, 1) / 1000;
		const candles = [
			{
				timestamp: base,
				open: 100,
				high: 100,
				low: 100,
				close: 100,
				shares: 1_000,
			},
			{
				timestamp: base + 86_400,
				open: 101,
				high: 101,
				low: 101,
				close: 101,
				shares: 1_000,
			},
			// 2:1 split: shares double, price halves.
			{
				timestamp: base + 2 * 86_400,
				open: 50.5,
				high: 50.5,
				low: 50.5,
				close: 50.5,
				shares: 2_000,
			},
			{
				timestamp: base + 3 * 86_400,
				open: 51,
				high: 51,
				low: 51,
				close: 51,
				shares: 2_000,
			},
		];
		const actions = detectCorporateActions(candles);
		expect(actions).toHaveLength(1);
		expect(actions[0]?.factor).toBeCloseTo(2, 6);
		// Ordinary issuance with a flat price is not a corporate action.
		const issuance = candles.map((candle, i) => ({
			...candle,
			shares: (candle.shares ?? 0) + (i === 2 ? 100 : 0),
		}));
		expect(detectCorporateActions(issuance)).toHaveLength(0);
		const adjusted = adjustForCorporateActions(candles);
		expect(adjusted.candles[0]?.close).toBeCloseTo(50, 6);
		expect(adjusted.candles[2]?.close).toBeCloseTo(50.5, 6);
		expect(adjusted.candles[0]?.shares).toBe(2_000);
		// The fake split return disappears.
		const pre = adjusted.candles[1]?.close ?? 0;
		const post = adjusted.candles[2]?.open ?? 0;
		expect(post / pre - 1).toBeLessThan(0.02);
	});
});
