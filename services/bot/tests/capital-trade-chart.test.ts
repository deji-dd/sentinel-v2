import { describe, expect, it } from "bun:test";

import { Resvg } from "@resvg/resvg-js";
import type { CapitalTradeContext } from "@sentinel/schemas";

import {
	buildCapitalTradeChartSvg,
	type ChartCandle,
} from "../src/lib/capital-trade-chart";

function candles(count = 80): ChartCandle[] {
	const start = Date.UTC(2026, 0, 1);
	return Array.from({ length: count }, (_, index) => ({
		bucketStart: new Date(start + index * 86_400_000),
		close: 100 + Math.sin(index / 8) * 4 + (index < 30 ? -index * 0.06 : 0),
	}));
}

function buyTrade(): CapitalTradeContext {
	const series = candles();
	return {
		side: "buy",
		exitPrice: 97.5,
		filled: true,
		entryPrice: 97.5,
		stopPrice: 95.55,
		targetPrice: 101.4,
		entryAt: series[series.length - 1]?.bucketStart.toISOString() ?? null,
		exitAt: series[series.length - 1]?.bucketStart.toISOString() ?? null,
		score: 78,
		zscore20: -1.62,
		sma20: 101.1,
		sd20: 2.2,
		rsi14: 29,
		sharesChange7Pct: 1.2,
		drawdown30Pct: -5.3,
	};
}

function sellTrade(): CapitalTradeContext {
	const series = candles();
	return {
		side: "sell",
		exitPrice: 101.8,
		filled: true,
		entryPrice: 96.4,
		stopPrice: 94.5,
		targetPrice: 100.3,
		entryAt: series[15]?.bucketStart.toISOString() ?? null,
		exitAt: series[series.length - 1]?.bucketStart.toISOString() ?? null,
		score: 71,
		zscore20: 1.1,
		rMultiple: 1.8,
		totalPnl: "1250.5",
		totalPnlPct: 4.2,
		heldDays: 64,
		exitReason: "reversal",
	};
}

describe("Capital trade chart", () => {
	it("renders the buy signal, SMA band and frozen risk levels", () => {
		const svg = buildCapitalTradeChartSvg({
			title: "[TSB] Buy 1,000 shares",
			candles: candles(),
			trade: buyTrade(),
		});

		expect(svg).not.toBeNull();
		expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(svg).toContain("Score 78");
		expect(svg).toContain("z -1.62σ");
		expect(svg).toContain("RSI 29");
		expect(svg).toContain("Stop 95.55");
		expect(svg).toContain("Target 101.40");
		expect(svg).toContain("-1.25");
		expect(svg).toContain("BUY 97.50");
	});

	it("marks both ends of a sell and states the position P/L", () => {
		const svg = buildCapitalTradeChartSvg({
			title: "[TSB] Sell 1,000 shares",
			candles: candles(),
			trade: sellTrade(),
		});

		expect(svg).not.toBeNull();
		expect(svg).toContain("BUY 96.40");
		expect(svg).toContain("SELL 101.80");
		expect(svg).toContain("+1.80R");
		expect(svg).toContain("P/L +1,250.50");
	});

	it("declines to chart when there is no usable price history", () => {
		expect(
			buildCapitalTradeChartSvg({
				title: "[TSB] Buy 1,000 shares",
				candles: candles(4),
				trade: buyTrade(),
			}),
		).toBeNull();
	});

	it("produces a renderable PNG for an alert attachment", () => {
		const svg = buildCapitalTradeChartSvg({
			title: "[TSB] Buy 1,000 shares",
			candles: candles(),
			trade: buyTrade(),
		});
		expect(svg).not.toBeNull();
		const png = new Resvg(svg ?? "", {
			fitTo: { mode: "width", value: 1200 },
		})
			.render()
			.asPng();
		expect(png.byteLength).toBeGreaterThan(1000);
	}, 20_000);
});
