import { describe, expect, it } from "bun:test";

import type { CapitalTradeContext } from "@sentinel/schemas";

import {
	buildCapitalTradeChartConfig,
	type ChartCandle,
} from "../src/lib/capital-trade-chart";
import { renderChartPng } from "../src/lib/chart-render";

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

type TradeConfig = NonNullable<ReturnType<typeof buildCapitalTradeChartConfig>>;

function annotationContent(config: TradeConfig, key: string): string {
	const annotations = config.options?.plugins?.annotation?.annotations as
		Record<string, { label?: { content?: string } }> | undefined;
	const label = annotations?.[key]?.label;
	return typeof label?.content === "string" ? label.content : "";
}

describe("Capital trade chart", () => {
	it("renders the buy signal, SMA band and frozen risk levels", () => {
		const config = buildCapitalTradeChartConfig({
			title: "[TSB] Buy 1,000 shares",
			candles: candles(),
			trade: buyTrade(),
		});

		expect(config).not.toBeNull();
		const title = config?.options?.plugins?.title?.text;
		expect(JSON.stringify(title)).toContain("[TSB] Buy 1,000 shares");
		expect(JSON.stringify(title)).toContain("Score 78");
		expect(JSON.stringify(title)).toContain("z -1.62σ");
		expect(JSON.stringify(title)).toContain("RSI 29");
		expect(annotationContent(config!, "stop")).toBe("Stop 95.55");
		expect(annotationContent(config!, "target")).toBe("Target 101.40");
		expect(annotationContent(config!, "entryThreshold")).toBe("entry −1.25σ");
		expect(annotationContent(config!, "exit")).toBe("BUY 97.50");
		expect(config?.data.datasets.some((set) => set.label === "SMA20")).toBe(
			true,
		);
	});

	it("marks both ends of a sell and states the position P/L", () => {
		const config = buildCapitalTradeChartConfig({
			title: "[TSB] Sell 1,000 shares",
			candles: candles(),
			trade: sellTrade(),
		});

		expect(config).not.toBeNull();
		expect(annotationContent(config!, "entry")).toBe("BUY 96.40");
		expect(annotationContent(config!, "exit")).toBe("SELL 101.80");
		expect(JSON.stringify(config?.options?.plugins?.title?.text)).toContain(
			"P/L +1,250.50",
		);
	});

	it("declines to chart when there is no usable price history", () => {
		expect(
			buildCapitalTradeChartConfig({
				title: "[TSB] Buy 1,000 shares",
				candles: candles(4),
				trade: buyTrade(),
			}),
		).toBeNull();
	});

	it("produces a renderable PNG for an alert attachment", () => {
		const config = buildCapitalTradeChartConfig({
			title: "[TSB] Buy 1,000 shares",
			candles: candles(),
			trade: buyTrade(),
		});
		expect(config).not.toBeNull();
		const png = renderChartPng(config!, 1200, 660);
		expect(png.length).toBeGreaterThan(1000);
	}, 20_000);
});
