import { describe, expect, test } from "bun:test";

import {
	backtestMetrics,
	bootstrapCI,
	deflatedSharpe,
	featureSpecHash,
	normalCdf,
	probabilityOfBacktestOverfit,
} from "../src/capital-ml-metrics";

describe("capital ML evaluation metrics", () => {
	test("block returns produce the whole reported set", () => {
		const metrics = backtestMetrics([0.02, -0.01, 0.03, 0.01], 20);
		expect(metrics.blocks).toBe(4);
		expect(metrics.hitRate).toBe(0.75);
		expect(metrics.avgWin).toBeCloseTo(0.02, 10);
		expect(metrics.avgLoss).toBeCloseTo(-0.01, 10);
		expect(metrics.payoff).toBeCloseTo(2, 10);
		expect(metrics.sharpe).toBeGreaterThan(0);
		expect(metrics.sortino).toBeGreaterThan(0);
		expect(metrics.maxDrawdown).toBeGreaterThan(0);
		expect(metrics.calmar).toBeGreaterThan(0);
		expect(metrics.turnover).toBeGreaterThan(0);
		expect(metrics.exposure).toBe(1);
	});

	test("cash blocks reduce exposure and turnover", () => {
		const metrics = backtestMetrics([0, 0, 0], 20, 0);
		expect(metrics.exposure).toBe(0);
		expect(metrics.turnover).toBe(0);
		expect(metrics.maxDrawdown).toBe(0);
	});

	test("bootstrap CI brackets the point estimate", () => {
		const ci = bootstrapCI(
			[0.01, 0.02, -0.01, 0.03, 0, 0.015],
			(sample) => sample.reduce((a, b) => a + b, 0) / sample.length,
			500,
			7,
		);
		expect(ci.lower).toBeLessThanOrEqual(ci.point);
		expect(ci.upper).toBeGreaterThanOrEqual(ci.point);
		expect(ci.samples).toBe(500);
	});

	test("normal CDF and deflated Sharpe behave at the limits", () => {
		expect(normalCdf(0)).toBeCloseTo(0.5, 6);
		expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
		const single = deflatedSharpe(1, 1, 100);
		const many = deflatedSharpe(1, 100, 100);
		expect(single).toBeGreaterThan(many);
		expect(many).toBeGreaterThanOrEqual(0);
		expect(many).toBeLessThanOrEqual(1);
	});

	test("PBO is reliable only with enough splits and blocks", () => {
		const thin = probabilityOfBacktestOverfit([
			[0.01, 0.02],
			[0.03, 0.01],
		]);
		expect(thin.reliable).toBe(false);
		expect(Number.isNaN(thin.pbo)).toBe(true);

		const returns = Array.from({ length: 4 }, (_, strategy) =>
			Array.from(
				{ length: 64 },
				(_, i) => 0.01 + strategy * 0.002 + (i % 5) * 0.001,
			),
		);
		const result = probabilityOfBacktestOverfit(returns, 8);
		expect(result.combinations).toBe(70);
		expect(result.reliable).toBe(true);
		expect(result.pbo).toBeGreaterThanOrEqual(0);
		expect(result.pbo).toBeLessThanOrEqual(1);
	});

	test("feature spec hash is stable and order-sensitive", () => {
		const features = ["zscore20", "rsi14"];
		expect(featureSpecHash(features)).toBe(featureSpecHash([...features]));
		expect(featureSpecHash(features)).not.toBe(
			featureSpecHash(["rsi14", "zscore20"]),
		);
	});
});
