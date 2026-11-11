import { describe, expect, test } from "bun:test";

import {
	auc,
	brierScore,
	calibrationBuckets,
	CAPITAL_ML_FEATURES,
	capitalMlFeatureVector,
	featureStats,
	fitLogistic,
	logLoss,
	predictProbability,
	sigmoid,
	standardise,
	tripleBarrierLabel,
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

	test("triple barrier labels target before stop", () => {
		expect(tripleBarrierLabel(100, [101, 102.1], 2, 2)).toBe(1);
		expect(tripleBarrierLabel(100, [101, 97.9], 2, 2)).toBe(0);
		expect(tripleBarrierLabel(100, [101, 101], 2, 2)).toBe(0);
	});
});
