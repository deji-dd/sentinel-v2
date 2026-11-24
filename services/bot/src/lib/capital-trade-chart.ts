import { Resvg } from "@resvg/resvg-js";
import { and, capitalMarketCandles, db, eq, gte } from "@sentinel/database";
import type { CapitalTradeContext } from "@sentinel/schemas";

/**
 * Trade alert charts are drawn from the scheduler's own daily candles, the same
 * series the reversal signal is computed from. The bot already owns SVG→PNG for
 * map images, so this adds no new dependency and no external chart service.
 *
 * The chart has two panels: price (with SMA20 and the ±1σ band that defines the
 * signal) and the 20-period z-score itself, with the entry (−1.25σ) and exit
 * (+1σ) thresholds drawn. A sell chart also marks entry, exit and the holding
 * window so the result is readable at a glance.
 */

const WIDTH = 1200;
const HEIGHT = 660;
const LEFT = 82;
const RIGHT = 28;
const PRICE_TOP = 104;
const PRICE_BOTTOM = 470;
const Z_TOP = 526;
const Z_BOTTOM = 610;

export interface ChartCandle {
	bucketStart: Date;
	close: number;
}

interface Point {
	x: number;
	y: number;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
	if (values.length < 2) return 0;
	const avg = mean(values);
	const variance =
		values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
	return Math.sqrt(Math.max(0, variance));
}

function fmtPrice(value: number): string {
	return value.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

function polyline(points: Point[]): string {
	return points
		.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
		.join(" ");
}

function line(
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	color: string,
	dash = "",
	width = 1,
): string {
	return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}

function text(
	x: number,
	y: number,
	value: string,
	color = "#94a3b8",
	size = 13,
	anchor = "start",
	weight = "normal",
): string {
	return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${color}" font-family="Inter, Arial, sans-serif" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`;
}

function marker(
	x: number,
	y: number,
	color: string,
	label: string,
	labelY: number,
	anchor: "start" | "middle" | "end",
): string {
	return [
		`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="${color}" stroke="#0b1220" stroke-width="2"/>`,
		text(x, labelY, label, color, 13, anchor, "bold"),
	].join("");
}

function xForTime(
	time: number | null | undefined,
	candles: ChartCandle[],
): number | null {
	if (!time || candles.length === 0) return null;
	const times = candles.map((candle) => candle.bucketStart.getTime());
	const first = times[0] ?? 0;
	const last = times[times.length - 1] ?? first;
	if (last === first) return LEFT;
	const ratio = Math.min(1, Math.max(0, (time - first) / (last - first)));
	return LEFT + ratio * (WIDTH - LEFT - RIGHT);
}

/**
 * Builds the chart as standalone SVG. Kept pure so the marker/scale logic can
 * be tested without a database or the native renderer.
 */
export function buildCapitalTradeChartSvg(input: {
	title: string;
	candles: ChartCandle[];
	trade: CapitalTradeContext;
}): string | null {
	const candles = [...input.candles]
		.sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
		.slice(-90);
	if (candles.length < 10) return null;

	const closes = candles.map((candle) => candle.close);
	const sma: (number | null)[] = candles.map((_, index) => {
		if (index < 19) return null;
		return mean(closes.slice(index - 19, index + 1));
	});
	const sd: (number | null)[] = candles.map((_, index) => {
		if (index < 19) return null;
		return standardDeviation(closes.slice(index - 19, index + 1));
	});
	const zscores = candles.map((candle, index) => {
		const average = sma[index];
		const deviation = sd[index];
		return average != null && deviation != null && deviation > 0
			? (candle.close - average) / deviation
			: null;
	});

	const trade = input.trade;
	const levels = [
		...closes,
		...sma.filter((value): value is number => value !== null),
		trade.entryPrice ?? Number.NaN,
		trade.stopPrice ?? Number.NaN,
		trade.targetPrice ?? Number.NaN,
	].filter((value) => Number.isFinite(value) && value > 0);
	let priceMin = Math.min(...levels);
	let priceMax = Math.max(...levels);
	if (!(priceMax > priceMin)) {
		priceMin *= 0.98;
		priceMax *= 1.02;
	}
	const pad = (priceMax - priceMin) * 0.08;
	priceMin -= pad;
	priceMax += pad;

	const plotWidth = WIDTH - LEFT - RIGHT;
	const xAt = (index: number): number =>
		LEFT + (index / Math.max(1, candles.length - 1)) * plotWidth;
	const yPrice = (value: number): number =>
		PRICE_BOTTOM -
		((value - priceMin) / (priceMax - priceMin)) * (PRICE_BOTTOM - PRICE_TOP);
	const zMin = -3;
	const zMax = 3;
	const yZ = (value: number): number =>
		Z_BOTTOM -
		((Math.min(zMax, Math.max(zMin, value)) - zMin) / (zMax - zMin)) *
			(Z_BOTTOM - Z_TOP);

	const entryX = xForTime(
		trade.entryAt ? Date.parse(trade.entryAt) : null,
		candles,
	);
	const exitX = xForTime(
		trade.exitAt ? Date.parse(trade.exitAt) : null,
		candles,
	);
	const parts: string[] = [];

	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
		`<rect width="100%" height="100%" fill="#0b1220"/>`,
		`<rect x="0" y="0" width="${WIDTH}" height="88" fill="#111c30"/>`,
		text(LEFT, 38, input.title, "#e2e8f0", 22, "start", "bold"),
	);

	const subtitle =
		trade.side === "buy"
			? [
					`Score ${trade.score?.toFixed(0) ?? "—"}`,
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
					.filter(Boolean)
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
					.filter(Boolean)
					.join("  ·  ");
	parts.push(text(LEFT, 66, subtitle, "#94a3b8", 14));

	// Price grid and axis labels.
	for (let step = 0; step <= 4; step++) {
		const value = priceMin + ((priceMax - priceMin) * step) / 4;
		const y = yPrice(value);
		parts.push(line(LEFT, y, WIDTH - RIGHT, y, "#1e293b", "", 1));
		parts.push(text(LEFT - 10, y + 4, fmtPrice(value), "#64748b", 12, "end"));
	}
	parts.push(
		text(
			LEFT,
			PRICE_TOP - 14,
			"PRICE · daily close",
			"#64748b",
			12,
			"start",
			"bold",
		),
	);

	// ±1σ envelope around the 20-day mean: the band the mean-reversion signal reads.
	const upper = sma.map((value, index) =>
		value != null && sd[index] != null
			? { x: xAt(index), y: yPrice(value + (sd[index] ?? 0)) }
			: null,
	);
	const lower = sma.map((value, index) =>
		value != null && sd[index] != null
			? { x: xAt(index), y: yPrice(value - (sd[index] ?? 0)) }
			: null,
	);
	const firstBand = upper.findIndex((point) => point !== null);
	if (firstBand >= 0) {
		const topPoints = upper
			.slice(firstBand)
			.filter((point): point is Point => point !== null);
		const bottomPoints = lower
			.slice(firstBand)
			.filter((point): point is Point => point !== null)
			.reverse();
		parts.push(
			`<polygon points="${polyline([...topPoints, ...bottomPoints])}" fill="#38bdf8" fill-opacity="0.10"/>`,
		);
		parts.push(
			`<polyline points="${polyline(topPoints)}" fill="none" stroke="#38bdf8" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="4 5"/>`,
		);
		parts.push(
			`<polyline points="${polyline(bottomPoints.reverse())}" fill="none" stroke="#38bdf8" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="4 5"/>`,
		);
		parts.push(
			`<polyline points="${polyline(sma.slice(firstBand).map((value, index) => ({ x: xAt(index + firstBand), y: yPrice(value ?? 0) })))}" fill="none" stroke="#a78bfa" stroke-width="1.6" stroke-dasharray="7 4"/>`,
		);
	}

	// Holding window, then the close line.
	if (trade.side === "sell" && entryX !== null && exitX !== null) {
		parts.push(
			`<rect x="${Math.min(entryX, exitX).toFixed(1)}" y="${PRICE_TOP}" width="${Math.abs(exitX - entryX).toFixed(1)}" height="${PRICE_BOTTOM - PRICE_TOP}" fill="#22c55e" fill-opacity="0.07"/>`,
		);
	}
	parts.push(
		`<polyline points="${polyline(closes.map((close, index) => ({ x: xAt(index), y: yPrice(close) })))}" fill="none" stroke="#38bdf8" stroke-width="2.6" stroke-linejoin="round"/>`,
	);

	// Frozen risk levels set at entry.
	if (trade.stopPrice !== null && trade.stopPrice !== undefined) {
		const y = yPrice(trade.stopPrice);
		parts.push(line(LEFT, y, WIDTH - RIGHT, y, "#f87171", "6 5", 1.4));
		parts.push(
			text(
				WIDTH - RIGHT - 4,
				y - 6,
				`Stop ${fmtPrice(trade.stopPrice)}`,
				"#f87171",
				12,
				"end",
			),
		);
	}
	if (trade.targetPrice !== null && trade.targetPrice !== undefined) {
		const y = yPrice(trade.targetPrice);
		parts.push(line(LEFT, y, WIDTH - RIGHT, y, "#34d399", "6 5", 1.4));
		parts.push(
			text(
				WIDTH - RIGHT - 4,
				y - 6,
				`Target ${fmtPrice(trade.targetPrice)}`,
				"#34d399",
				12,
				"end",
			),
		);
	}

	// Entry / exit markers on the price panel.
	const exitY = yPrice(trade.exitPrice);
	if (exitX !== null) {
		parts.push(
			marker(
				exitX,
				exitY,
				trade.side === "buy" ? "#22c55e" : "#f59e0b",
				`${trade.side === "buy" ? "BUY" : "SELL"} ${fmtPrice(trade.exitPrice)}`,
				PRICE_TOP + 18,
				exitX > WIDTH - 240 ? "end" : "start",
			),
		);
		parts.push(
			line(exitX, PRICE_TOP, exitX, PRICE_BOTTOM, "#475569", "3 6", 1),
		);
	}
	if (
		trade.entryPrice !== null &&
		trade.entryPrice !== undefined &&
		entryX !== null &&
		trade.side === "sell"
	) {
		parts.push(
			marker(
				entryX,
				yPrice(trade.entryPrice),
				"#60a5fa",
				`BUY ${fmtPrice(trade.entryPrice)}`,
				PRICE_BOTTOM - 12,
				entryX < LEFT + 120 ? "start" : "end",
			),
		);
		parts.push(
			line(entryX, PRICE_TOP, entryX, PRICE_BOTTOM, "#60a5fa", "3 6", 1),
		);
	}

	// Z-score panel: the exact indicator used to enter and exit.
	parts.push(
		text(
			LEFT,
			Z_TOP - 12,
			"20-DAY Z-SCORE · entry ≤ −1.25σ · exit ≥ +1σ",
			"#64748b",
			12,
			"start",
			"bold",
		),
	);
	for (const level of [1, 0, -1.25]) {
		const y = yZ(level);
		const color =
			level === -1.25 ? "#f59e0b" : level === 1 ? "#34d399" : "#475569";
		parts.push(
			line(LEFT, y, WIDTH - RIGHT, y, color, level === 0 ? "" : "6 5", 1.2),
		);
		parts.push(
			text(
				LEFT - 10,
				y + 4,
				`${level > 0 ? "+" : ""}${level}`,
				color,
				12,
				"end",
			),
		);
	}
	const zPoints = zscores.map((value, index) => ({
		x: xAt(index),
		y: yZ(value ?? 0),
	}));
	parts.push(
		`<polyline points="${polyline(zPoints)}" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linejoin="round"/>`,
	);
	if (
		entryX !== null &&
		trade.zscore20 !== null &&
		trade.zscore20 !== undefined
	) {
		parts.push(
			marker(entryX, yZ(trade.zscore20), "#60a5fa", "", Z_TOP + 12, "middle"),
		);
	}
	if (
		exitX !== null &&
		trade.zscore20 !== null &&
		trade.zscore20 !== undefined &&
		trade.side === "sell"
	) {
		parts.push(
			marker(exitX, yZ(trade.zscore20), "#f59e0b", "", Z_TOP + 12, "middle"),
		);
	}

	// Date axis and legend.
	const firstDate = candles[0]?.bucketStart;
	const lastDate = candles[candles.length - 1]?.bucketStart;
	if (firstDate && lastDate) {
		const format = (date: Date): string =>
			date.toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				timeZone: "UTC",
			});
		parts.push(
			text(LEFT, HEIGHT - 22, format(firstDate), "#64748b", 12, "start"),
		);
		parts.push(
			text(WIDTH - RIGHT, HEIGHT - 22, format(lastDate), "#64748b", 12, "end"),
		);
	}
	parts.push(
		text(
			(WIDTH - LEFT - RIGHT) / 2 + LEFT,
			HEIGHT - 22,
			"— Close    - - SMA20 / ±1σ    ● Entry    ● Exit    shaded = oversold band / holding window",
			"#475569",
			11,
			"middle",
		),
	);
	parts.push("</svg>");
	return parts.join("");
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
		.orderBy(capitalMarketCandles.bucketStart)
		.limit(120);
	const candles = rows.map((row) => ({
		bucketStart: row.bucketStart,
		close: Number(row.close),
	}));
	const svg = buildCapitalTradeChartSvg({
		title: input.title,
		candles,
		trade: input.trade,
	});
	if (!svg) return null;
	return Buffer.from(
		new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } }).render().asPng(),
	);
}
