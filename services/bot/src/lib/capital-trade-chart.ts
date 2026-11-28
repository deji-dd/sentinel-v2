import {
	and,
	capitalMarketCandles,
	db,
	desc,
	eq,
	gte,
} from "@sentinel/database";
import type { CapitalTradeContext } from "@sentinel/schemas";
import type { ChartConfiguration } from "chart.js";
import type { AnnotationOptions } from "chartjs-plugin-annotation";

import { renderChartPng } from "./chart-render";

/**
 * Trade alert charts are drawn from the scheduler's own daily candles, the same
 * series the reversal signal is computed from. Chart.js supplies the scales,
 * axes and legend; this module supplies the trading-specific overlays: the
 * SMA20 ±1σ band, the frozen stop/target and the entry/exit markers.
 */

const WIDTH = 1200;
const HEIGHT = 660;

export interface ChartCandle {
	bucketStart: Date;
	close: number;
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
	if (values.length < 2) return 0;
	const average = mean(values);
	const variance =
		values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
		values.length;
	return Math.sqrt(Math.max(0, variance));
}

function fmtPrice(value: number): string {
	return value.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

function fmtDate(date: Date): string {
	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}

/** Closest candle index to an ISO timestamp, or -1 when it cannot be matched. */
function indexForTime(
	time: string | null | undefined,
	candles: ChartCandle[],
): number {
	if (!time) return -1;
	const target = Date.parse(time);
	if (!Number.isFinite(target)) return -1;
	let best = Number.POSITIVE_INFINITY;
	let index = -1;
	for (let i = 0; i < candles.length; i++) {
		const distance = Math.abs(
			(candles[i]?.bucketStart.getTime() ?? target) - target,
		);
		if (distance < best) {
			best = distance;
			index = i;
		}
	}
	return index;
}

/**
 * Builds the Chart.js configuration for one trade alert. Kept pure so the
 * overlay logic can be tested without a database or the native renderer.
 */
export function buildCapitalTradeChartConfig(input: {
	title: string;
	candles: ChartCandle[];
	trade: CapitalTradeContext;
}): ChartConfiguration<"line", (number | null)[], string> | null {
	const candles = [...input.candles]
		.sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
		.slice(-90);
	if (candles.length < 10) return null;

	const closes = candles.map((candle) => candle.close);
	const sma: (number | null)[] = candles.map((_, index) =>
		index < 19 ? null : mean(closes.slice(index - 19, index + 1)),
	);
	const sd: (number | null)[] = candles.map((_, index) =>
		index < 19 ? null : standardDeviation(closes.slice(index - 19, index + 1)),
	);
	const bandUpper = sma.map((value, index) =>
		value !== null && sd[index] != null ? value + (sd[index] ?? 0) : null,
	);
	const bandLower = sma.map((value, index) =>
		value !== null && sd[index] != null ? value - (sd[index] ?? 0) : null,
	);
	const zscores = candles.map((candle, index) => {
		const average = sma[index];
		const deviation = sd[index];
		return average != null && deviation != null && deviation > 0
			? (candle.close - average) / deviation
			: null;
	});

	const trade = input.trade;
	const labels = candles.map((candle) => fmtDate(candle.bucketStart));
	const entryIndex = indexForTime(trade.entryAt, candles);
	const exitIndex = indexForTime(trade.exitAt, candles);

	const subtitle =
		trade.side === "buy"
			? [
					trade.score !== null && trade.score !== undefined
						? `Score ${trade.score.toFixed(0)}`
						: null,
					trade.zscore20 !== null && trade.zscore20 !== undefined
						? `z ${trade.zscore20 >= 0 ? "+" : ""}${trade.zscore20.toFixed(2)}σ`
						: null,
					trade.rsi14 !== null && trade.rsi14 !== undefined
						? `RSI ${trade.rsi14.toFixed(0)}`
						: null,
					trade.sharesChange7Pct !== null &&
					trade.sharesChange7Pct !== undefined
						? `7d shares ${trade.sharesChange7Pct >= 0 ? "+" : ""}${trade.sharesChange7Pct.toFixed(1)}%`
						: null,
				]
					.filter((value): value is string => Boolean(value))
					.join("  ·  ")
			: [
					trade.entryPrice ? `Entry ${fmtPrice(trade.entryPrice)}` : null,
					`Exit ${fmtPrice(trade.exitPrice)}`,
					trade.rMultiple !== null && trade.rMultiple !== undefined
						? `${trade.rMultiple >= 0 ? "+" : ""}${trade.rMultiple.toFixed(2)}R`
						: null,
					trade.totalPnl !== null && trade.totalPnl !== undefined
						? `P/L ${Number(trade.totalPnl) >= 0 ? "+" : ""}${fmtPrice(Number(trade.totalPnl))}`
						: null,
				]
					.filter((value): value is string => Boolean(value))
					.join("  ·  ");

	const annotations: Record<string, AnnotationOptions> = {};
	if (trade.stopPrice !== null && trade.stopPrice !== undefined) {
		annotations.stop = {
			type: "line",
			scaleID: "y",
			value: trade.stopPrice,
			borderColor: "#f87171",
			borderDash: [6, 5],
			borderWidth: 1.4,
			label: {
				display: true,
				content: `Stop ${fmtPrice(trade.stopPrice)}`,
				position: "start",
				color: "#f87171",
				backgroundColor: "transparent",
			},
		};
	}
	if (trade.targetPrice !== null && trade.targetPrice !== undefined) {
		annotations.target = {
			type: "line",
			scaleID: "y",
			value: trade.targetPrice,
			borderColor: "#34d399",
			borderDash: [6, 5],
			borderWidth: 1.4,
			label: {
				display: true,
				content: `Target ${fmtPrice(trade.targetPrice)}`,
				position: "start",
				color: "#34d399",
				backgroundColor: "transparent",
			},
		};
	}
	annotations.entryThreshold = {
		type: "line",
		scaleID: "y1",
		value: -1.25,
		borderColor: "#f59e0b",
		borderDash: [6, 5],
		borderWidth: 1.2,
		label: {
			display: true,
			content: "entry −1.25σ",
			position: "end",
			color: "#f59e0b",
			backgroundColor: "transparent",
		},
	};
	annotations.exitThreshold = {
		type: "line",
		scaleID: "y1",
		value: 1,
		borderColor: "#34d399",
		borderDash: [6, 5],
		borderWidth: 1.2,
		label: {
			display: true,
			content: "exit +1σ",
			position: "start",
			color: "#34d399",
			backgroundColor: "transparent",
		},
	};
	const entryLabel = labels[entryIndex];
	if (entryLabel && trade.side === "sell") {
		annotations.entry = {
			type: "line",
			xMin: entryLabel,
			xMax: entryLabel,
			borderColor: "#60a5fa",
			borderDash: [3, 6],
			borderWidth: 1,
			label: {
				display: true,
				content: `BUY ${fmtPrice(trade.entryPrice ?? 0)}`,
				position: "end",
				color: "#60a5fa",
				backgroundColor: "transparent",
			},
		};
	}
	const exitLabel = labels[exitIndex];
	if (exitLabel) {
		annotations.exit = {
			type: "line",
			xMin: exitLabel,
			xMax: exitLabel,
			borderColor: "#475569",
			borderDash: [3, 6],
			borderWidth: 1,
			label: {
				display: true,
				content: `${trade.side === "buy" ? "BUY" : "SELL"} ${fmtPrice(trade.exitPrice)}`,
				position: "start",
				color: trade.side === "buy" ? "#22c55e" : "#f59e0b",
				backgroundColor: "transparent",
			},
		};
	}

	return {
		type: "line",
		data: {
			labels,
			datasets: [
				{
					label: `Close · ${trade.side === "buy" ? "buy signal" : "sell result"}`,
					data: closes,
					borderColor: "#38bdf8",
					borderWidth: 2.6,
					pointRadius: 0,
					tension: 0.08,
					yAxisID: "y",
					order: 1,
				},
				{
					label: "SMA20",
					data: sma,
					borderColor: "#a78bfa",
					borderDash: [7, 4],
					borderWidth: 1.6,
					pointRadius: 0,
					yAxisID: "y",
					order: 2,
				},
				{
					label: "±1σ band",
					data: bandUpper,
					borderColor: "rgba(56, 189, 248, 0.45)",
					borderDash: [4, 5],
					borderWidth: 1,
					backgroundColor: "rgba(56, 189, 248, 0.10)",
					fill: "+1",
					pointRadius: 0,
					yAxisID: "y",
					order: 4,
				},
				{
					label: "−1σ band",
					data: bandLower,
					borderColor: "rgba(56, 189, 248, 0.45)",
					borderDash: [4, 5],
					borderWidth: 1,
					pointRadius: 0,
					yAxisID: "y",
					order: 4,
				},
				{
					label: "20-day z-score",
					data: zscores,
					borderColor: "#fbbf24",
					borderWidth: 2,
					pointRadius: 0,
					tension: 0.08,
					yAxisID: "y1",
					order: 3,
				},
			],
		},
		options: {
			responsive: false,
			animation: false,
			layout: { padding: { top: 10, right: 12 } },
			plugins: {
				title: {
					display: true,
					text: [input.title, subtitle].filter(Boolean),
					color: "#e2e8f0",
					align: "start",
					font: { size: 18, weight: "bold" },
					padding: { bottom: 12 },
				},
				legend: {
					display: true,
					position: "bottom",
					labels: { boxWidth: 12, color: "#94a3b8" },
				},
				annotation: { annotations },
			},
			scales: {
				x: {
					ticks: { color: "#94a3b8", maxTicksLimit: 8, maxRotation: 0 },
					grid: { color: "rgba(51, 65, 85, 0.4)" },
				},
				y: {
					type: "linear",
					position: "left",
					ticks: {
						color: "#94a3b8",
						callback: (value) => fmtPrice(Number(value)),
					},
					grid: { color: "rgba(51, 65, 85, 0.5)" },
				},
				y1: {
					type: "linear",
					position: "right",
					min: -3,
					max: 3,
					ticks: {
						color: "#fbbf24",
						callback: (value) =>
							`${Number(value) > 0 ? "+" : ""}${Number(value).toFixed(1)}σ`,
					},
					grid: { drawOnChartArea: false },
				},
			},
		},
	};
}

/** Fetches recent daily candles and renders the PNG attached to a trade alert. */
export async function generateCapitalTradeChartPng(input: {
	stockId: number;
	title: string;
	trade: CapitalTradeContext;
}): Promise<Buffer | null> {
	const cutoff = new Date(Date.now() - 150 * 86_400_000);
	const rows = await db
		.select({
			bucketStart: capitalMarketCandles.bucketStart,
			close: capitalMarketCandles.close,
		})
		.from(capitalMarketCandles)
		.where(
			and(
				eq(capitalMarketCandles.stockId, input.stockId),
				eq(capitalMarketCandles.intervalMinutes, 1440),
				gte(capitalMarketCandles.bucketStart, cutoff),
			),
		)
		// The most recent candles, not the oldest 120 in the window: the chart's
		// right-hand edge is where the trade marker sits.
		.orderBy(desc(capitalMarketCandles.bucketStart))
		.limit(120);
	const candles = rows.map((row) => ({
		bucketStart: row.bucketStart,
		close: Number(row.close),
	}));
	const config = buildCapitalTradeChartConfig({
		title: input.title,
		candles,
		trade: input.trade,
	});
	if (!config) return null;
	return renderChartPng(config, WIDTH, HEIGHT);
}
