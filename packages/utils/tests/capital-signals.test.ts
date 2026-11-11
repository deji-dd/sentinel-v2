import { describe, expect, test } from "bun:test";

import {
	type CapitalCandle,
	computeFeatures,
	computeMarketRegime,
	evaluateExit,
	planEntry,
	scoreStock,
} from "../src/capital-signals";

function makeCandles(
	count: number,
	options: {
		start?: number;
		intervalSeconds?: number;
		base?: number;
		drift?: number;
		wobble?: number;
	} = {},
): CapitalCandle[] {
	const start = options.start ?? Date.UTC(2025, 0, 1) / 1000;
	const interval = options.intervalSeconds ?? 86_400;
	const base = options.base ?? 100;
	const drift = options.drift ?? 0.1;
	const wobble = options.wobble ?? 2;
	const candles: CapitalCandle[] = [];
	let previous = base;
	for (let i = 0; i < count; i++) {
		const close = base + i * drift + Math.sin(i / 3) * wobble;
		const open = previous;
		const high = Math.max(open, close) + 1;
		const low = Math.min(open, close) - 1;
		candles.push({
			timestamp: start + i * interval,
			open,
			high,
			low,
			close,
		});
		previous = close;
	}
	return candles;
}

describe("capital signals", () => {
	test("computes features from a rising series", () => {
		const candles = makeCandles(120);
		const last = candles[candles.length - 1];
		expect(last).toBeDefined();
		const features = computeFeatures({
			stockId: 1,
			price: last?.close ?? 0,
			candles,
			regimeOn: true,
		});
		expect(features).not.toBeNull();
		if (!features) return;
		expect(features.historyDays).toBeGreaterThan(100);
		expect(features.returns.d7).not.toBeNull();
		expect(features.returns.d30).not.toBeNull();
		expect(features.ema20).toBeGreaterThan(0);
		expect(features.atr).toBeGreaterThan(0);
		expect(features.volatilityPct).toBeGreaterThan(0);
	});

	test("scores an uptrend as eligible and blocks overextension", () => {
		const candles = makeCandles(120, { drift: 0.3, wobble: 0.5 });
		const last = candles[candles.length - 1];
		const features = computeFeatures({
			stockId: 1,
			price: (last?.close ?? 0) * 1.01,
			candles,
			regimeOn: true,
		});
		expect(features).not.toBeNull();
		if (!features) return;
		const score = scoreStock(features, {
			minEntryScore: 50,
			maxRsi: 75,
			overboughtSigma: 2,
		});
		expect(score.score).toBeGreaterThan(0);
		expect(score.components.trend).toBeGreaterThan(0);

		const overbought = scoreStock(
			{
				...features,
				rsi14: 95,
				zscore20: 3,
			},
			{ minEntryScore: 50, maxRsi: 75, overboughtSigma: 2 },
		);
		expect(overbought.flags).toContain("overbought");
		expect(overbought.eligible).toBe(false);
	});

	test("reversal mode buys an oversold dip and ignores a rising series", () => {
		const candles = makeCandles(120, { drift: 0, wobble: 1 });
		for (let i = 0; i < 5; i++) {
			const candle = candles[candles.length - 5 + i];
			if (candle) candle.close = 100 - (i + 1) * 1.4;
		}
		const last = candles[candles.length - 1];
		const features = computeFeatures({
			stockId: 1,
			price: last?.close ?? 0,
			candles,
			regimeOn: true,
		});
		expect(features).not.toBeNull();
		if (!features) return;

		const dip = scoreStock(features, {
			mode: "reversal",
			minEntryScore: 50,
			maxRsi: 75,
			overboughtSigma: 2,
			reversalEntrySigma: 1,
		});
		expect(dip.eligible).toBe(true);
		expect(dip.components.trend).toBeGreaterThan(50);

		const rising = makeCandles(120, { drift: 0.3, wobble: 0.5 });
		const risingLast = rising[rising.length - 1];
		const risingFeatures = computeFeatures({
			stockId: 2,
			price: risingLast?.close ?? 0,
			candles: rising,
			regimeOn: true,
		});
		expect(risingFeatures).not.toBeNull();
		if (!risingFeatures) return;
		const notOversold = scoreStock(risingFeatures, {
			mode: "reversal",
			minEntryScore: 50,
			maxRsi: 75,
			overboughtSigma: 2,
			reversalEntrySigma: 1,
		});
		expect(notOversold.flags).toContain("not_oversold");
		expect(notOversold.eligible).toBe(false);
	});

	test("reversal mode flags overbought, volatility and falling knives", () => {
		const candles = makeCandles(120, { drift: 0.2 });
		const last = candles[candles.length - 1];
		const features = computeFeatures({
			stockId: 1,
			price: last?.close ?? 0,
			candles,
			regimeOn: true,
		});
		expect(features).not.toBeNull();
		if (!features) return;
		const config = {
			mode: "reversal" as const,
			minEntryScore: 40,
			maxRsi: 75,
			overboughtSigma: 2,
			reversalEntrySigma: 1,
		};
		const overbought = scoreStock(
			{ ...features, zscore20: -2, rsi14: 90 },
			config,
		);
		expect(overbought.flags).toContain("overbought");
		expect(overbought.eligible).toBe(false);

		const volatile = scoreStock(
			{ ...features, zscore20: -2, rsi14: 40, volatilityPct: 90 },
			config,
		);
		expect(volatile.flags).toContain("too_volatile");
		expect(volatile.eligible).toBe(false);

		const knife = scoreStock(
			{ ...features, zscore20: -2, rsi14: 40, drawdown90Pct: -70 },
			config,
		);
		expect(knife.flags).toContain("falling_knife");
		expect(knife.eligible).toBe(false);
	});

	test("reversal mode exits when price mean-reverts", () => {
		const config = {
			trailingTriggerR: 1,
			trailingAtrMultiplier: 1.5,
			trailingPct: 6,
			tightenTrailPct: 4,
			scaleOutR: 5,
			scaleOutFraction: 0.3333,
			timeStopDays: 20,
		};
		const reverted = evaluateExit({
			entryPrice: 94,
			price: 100.5,
			peakPrice: 100.5,
			stopPrice: 90,
			atr: 2,
			ema20: 99,
			ema50: 101,
			score: 40,
			daysHeld: 4,
			scaledOut: false,
			mode: "reversal",
			meanPrice: 100,
			zscore20: 0.1,
			reversalExitSigma: 0,
			config,
		});
		expect(reverted.action).toBe("sell");
		expect(reverted.reason).toContain("Mean reversion");

		const stillBelow = evaluateExit({
			entryPrice: 94,
			price: 96,
			peakPrice: 96,
			stopPrice: 90,
			atr: 2,
			ema20: 99,
			ema50: 101,
			score: 80,
			daysHeld: 4,
			scaledOut: false,
			mode: "reversal",
			meanPrice: 100,
			zscore20: -0.6,
			reversalExitSigma: 0,
			config,
		});
		expect(stillBelow.action).toBe("hold");
	});

	test("detects the market regime from daily closes", () => {
		const rising = makeCandles(60, { drift: 0.5 });
		expect(computeMarketRegime(rising, 50).on).toBe(true);

		const falling = makeCandles(60, { drift: -0.5 });
		expect(computeMarketRegime(falling, 50).on).toBe(false);
	});

	test("sizes entries by risk, weight and cash", () => {
		const plan = planEntry({
			nav: "100000000000",
			freeCash: "50000000000",
			price: 100,
			atr: 2,
			existingWeightPct: 0,
			config: {
				riskPerTradePct: 0.5,
				maxStockWeightPct: 20,
				stopAtrMultiplier: 2,
				stopMinPct: 4,
				minNotional: "10000000",
			},
		});
		expect(plan.shares).toBeGreaterThan(0);
		expect(plan.stopPrice).toBeLessThan(100);
		expect(plan.targetPrice).toBeGreaterThan(100);
		expect(plan.positionPct).toBeLessThanOrEqual(20);
		expect(plan.riskAmount / 100_000_000_000).toBeLessThanOrEqual(0.005 + 1e-9);
	});

	test("blocks a position below the minimum notional", () => {
		const plan = planEntry({
			nav: "100000000000",
			freeCash: "50000000000",
			price: 100,
			atr: 2,
			existingWeightPct: 0,
			config: {
				riskPerTradePct: 0.0001,
				maxStockWeightPct: 20,
				stopAtrMultiplier: 2,
				stopMinPct: 4,
				minNotional: "10000000",
			},
		});
		expect(plan.shares).toBe(0);
	});

	test("exits on stop, trail, scale-out and time stop", () => {
		const config = {
			trailingTriggerR: 1,
			trailingAtrMultiplier: 1.5,
			trailingPct: 6,
			tightenTrailPct: 4,
			scaleOutR: 2,
			scaleOutFraction: 0.3333,
			timeStopDays: 20,
		};

		const stop = evaluateExit({
			entryPrice: 100,
			price: 94,
			peakPrice: 105,
			stopPrice: 95,
			atr: 2,
			ema20: 98,
			ema50: 97,
			score: 70,
			daysHeld: 2,
			scaledOut: false,
			config,
		});
		expect(stop.action).toBe("sell");

		const scale = evaluateExit({
			entryPrice: 100,
			price: 112,
			peakPrice: 112,
			stopPrice: 95,
			atr: 2,
			ema20: 105,
			ema50: 102,
			score: 80,
			daysHeld: 10,
			scaledOut: false,
			config,
		});
		expect(scale.action).toBe("scale_out");
		expect(scale.fraction).toBeGreaterThan(0);

		const time = evaluateExit({
			entryPrice: 100,
			price: 101,
			peakPrice: 102,
			stopPrice: 95,
			atr: 2,
			ema20: 101,
			ema50: 100,
			score: 70,
			daysHeld: 25,
			scaledOut: false,
			config,
		});
		expect(time.action).toBe("sell");
	});
});
