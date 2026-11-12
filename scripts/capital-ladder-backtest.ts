/**
 * Backtests the *live* exit ladder against the stored daily candles.
 *
 * The research note in `docs/capital-ml-research.md` evaluated a weekly
 * bottom-5 rebalance with no stops. The engine does something different: it
 * enters on the reversal score and manages each name with a frozen stop, a
 * +1R trim, a +2R target, a since-entry trail, a z-score exit and a time stop.
 * This script replays that ladder with the same pure functions the scheduler
 * uses (`computeFeatures`, `scoreStock`, `planEntry`, `evaluateExit`), so the
 * numbers describe the code that actually trades.
 *
 * Usage:
 *   POSTGRES_DB=sentinel_db bun run scripts/capital-ladder-backtest.ts
 *
 * It is read-only. Daily bars are used because the reversal signal is built on
 * daily features; intraday stops are approximated with the day's low/high.
 */

import postgres from "postgres";

import {
	CAPITAL_CONFIDENCE,
	CAPITAL_ENTRY_STOP,
	CAPITAL_EXIT,
	CAPITAL_SIZING,
	type CapitalCandle,
	computeFeatures,
	confidenceMultiplier,
	entryStopDistance,
	evaluateExit,
	formatMoney,
	planEntry,
	scoreStock,
} from "../packages/utils";

const DAY = 86_400;
const SALE_FEE_BPS = 10;
const SLIPPAGE_BPS = 5;
const START_NAV = 150_000_000_000;
const MIN_HISTORY = 120;

interface Variant {
	name: string;
	stopAtrMultiplier: number;
	stopMinPct: number;
	stopMaxPct: number;
	targetR: number;
	scaleOutR: number;
	scaleOutFraction: number;
	trailingTriggerR: number;
	trailingAtrMultiplier: number;
	trailingPct: number;
	tightenTrailPct: number;
	timeStopDays: number;
	reversalExitSigma: number;
	confidence: boolean;
	maxPositions: number;
	maxStockWeightPct: number;
	riskPerTradePct: number;
}

const VARIANTS: Variant[] = [
	{
		name: "legacy (4% stop, z>=0, +2R trim)",
		stopAtrMultiplier: 2,
		stopMinPct: 4,
		stopMaxPct: 100,
		targetR: 2,
		scaleOutR: 2,
		scaleOutFraction: 0.3333,
		trailingTriggerR: 1,
		trailingAtrMultiplier: 1.5,
		trailingPct: 6,
		tightenTrailPct: 4,
		timeStopDays: 20,
		reversalExitSigma: 0,
		confidence: false,
		maxPositions: 12,
		maxStockWeightPct: 20,
		riskPerTradePct: 0.5,
	},
	{
		name: "proposed (2-2.5% stop, z>=+1, +1R trim)",
		stopAtrMultiplier: CAPITAL_ENTRY_STOP.atrMultiplier,
		stopMinPct: CAPITAL_ENTRY_STOP.minPct,
		stopMaxPct: CAPITAL_ENTRY_STOP.maxPct,
		targetR: CAPITAL_ENTRY_STOP.targetR,
		scaleOutR: CAPITAL_EXIT.scaleOutR,
		scaleOutFraction: CAPITAL_EXIT.scaleOutFraction,
		trailingTriggerR: CAPITAL_EXIT.trailingTriggerR,
		trailingAtrMultiplier: CAPITAL_EXIT.trailingAtrMultiplier,
		trailingPct: CAPITAL_EXIT.trailingPct,
		tightenTrailPct: CAPITAL_EXIT.tightenTrailPct,
		timeStopDays: CAPITAL_EXIT.timeStopDays,
		reversalExitSigma: 1,
		confidence: true,
		maxPositions: CAPITAL_SIZING.maxPositions,
		maxStockWeightPct: CAPITAL_SIZING.maxStockWeightPct,
		riskPerTradePct: CAPITAL_SIZING.riskPerTradePct,
	},
	{
		name: "proposed, no +1R trim",
		stopAtrMultiplier: CAPITAL_ENTRY_STOP.atrMultiplier,
		stopMinPct: CAPITAL_ENTRY_STOP.minPct,
		stopMaxPct: CAPITAL_ENTRY_STOP.maxPct,
		targetR: CAPITAL_ENTRY_STOP.targetR,
		scaleOutR: 5,
		scaleOutFraction: CAPITAL_EXIT.scaleOutFraction,
		trailingTriggerR: CAPITAL_EXIT.trailingTriggerR,
		trailingAtrMultiplier: CAPITAL_EXIT.trailingAtrMultiplier,
		trailingPct: CAPITAL_EXIT.trailingPct,
		tightenTrailPct: CAPITAL_EXIT.tightenTrailPct,
		timeStopDays: CAPITAL_EXIT.timeStopDays,
		reversalExitSigma: 1,
		confidence: true,
		maxPositions: CAPITAL_SIZING.maxPositions,
		maxStockWeightPct: CAPITAL_SIZING.maxStockWeightPct,
		riskPerTradePct: CAPITAL_SIZING.riskPerTradePct,
	},
	{
		name: "2% stop, +2R target, +1R trim",
		stopAtrMultiplier: 0,
		stopMinPct: 2,
		stopMaxPct: 2,
		targetR: 2,
		scaleOutR: 1,
		scaleOutFraction: CAPITAL_EXIT.scaleOutFraction,
		trailingTriggerR: CAPITAL_EXIT.trailingTriggerR,
		trailingAtrMultiplier: CAPITAL_EXIT.trailingAtrMultiplier,
		trailingPct: CAPITAL_EXIT.trailingPct,
		tightenTrailPct: CAPITAL_EXIT.tightenTrailPct,
		timeStopDays: CAPITAL_EXIT.timeStopDays,
		reversalExitSigma: 1,
		confidence: true,
		maxPositions: CAPITAL_SIZING.maxPositions,
		maxStockWeightPct: CAPITAL_SIZING.maxStockWeightPct,
		riskPerTradePct: CAPITAL_SIZING.riskPerTradePct,
	},
	{
		name: "2.5x ATR, 2-2.5% band, +2R",
		stopAtrMultiplier: 2.5,
		stopMinPct: 2,
		stopMaxPct: 2.5,
		targetR: 2,
		scaleOutR: 1,
		scaleOutFraction: CAPITAL_EXIT.scaleOutFraction,
		trailingTriggerR: CAPITAL_EXIT.trailingTriggerR,
		trailingAtrMultiplier: CAPITAL_EXIT.trailingAtrMultiplier,
		trailingPct: CAPITAL_EXIT.trailingPct,
		tightenTrailPct: CAPITAL_EXIT.tightenTrailPct,
		timeStopDays: CAPITAL_EXIT.timeStopDays,
		reversalExitSigma: 1,
		confidence: true,
		maxPositions: CAPITAL_SIZING.maxPositions,
		maxStockWeightPct: CAPITAL_SIZING.maxStockWeightPct,
		riskPerTradePct: CAPITAL_SIZING.riskPerTradePct,
	},
	{
		name: "1.5% fixed, +2R target, +1R trim",
		stopAtrMultiplier: 0,
		stopMinPct: 1.5,
		stopMaxPct: 1.5,
		targetR: 2,
		scaleOutR: 1,
		scaleOutFraction: CAPITAL_EXIT.scaleOutFraction,
		trailingTriggerR: CAPITAL_EXIT.trailingTriggerR,
		trailingAtrMultiplier: CAPITAL_EXIT.trailingAtrMultiplier,
		trailingPct: CAPITAL_EXIT.trailingPct,
		tightenTrailPct: CAPITAL_EXIT.tightenTrailPct,
		timeStopDays: CAPITAL_EXIT.timeStopDays,
		reversalExitSigma: 1,
		confidence: true,
		maxPositions: CAPITAL_SIZING.maxPositions,
		maxStockWeightPct: CAPITAL_SIZING.maxStockWeightPct,
		riskPerTradePct: CAPITAL_SIZING.riskPerTradePct,
	},
	{
		name: "2.5% fixed, +2R target, +1R trim",
		stopAtrMultiplier: 0,
		stopMinPct: 2.5,
		stopMaxPct: 2.5,
		targetR: 2,
		scaleOutR: 1,
		scaleOutFraction: CAPITAL_EXIT.scaleOutFraction,
		trailingTriggerR: CAPITAL_EXIT.trailingTriggerR,
		trailingAtrMultiplier: CAPITAL_EXIT.trailingAtrMultiplier,
		trailingPct: CAPITAL_EXIT.trailingPct,
		tightenTrailPct: CAPITAL_EXIT.tightenTrailPct,
		timeStopDays: CAPITAL_EXIT.timeStopDays,
		reversalExitSigma: 1,
		confidence: true,
		maxPositions: CAPITAL_SIZING.maxPositions,
		maxStockWeightPct: CAPITAL_SIZING.maxStockWeightPct,
		riskPerTradePct: CAPITAL_SIZING.riskPerTradePct,
	},
	{
		name: "research barrier (2% stop, 1R target)",
		stopAtrMultiplier: 0,
		stopMinPct: 2,
		stopMaxPct: 2,
		targetR: 1,
		scaleOutR: 5,
		scaleOutFraction: 0.3333,
		trailingTriggerR: 5,
		trailingAtrMultiplier: 2,
		trailingPct: 2,
		tightenTrailPct: 1.5,
		timeStopDays: 20,
		reversalExitSigma: 2,
		confidence: true,
		maxPositions: CAPITAL_SIZING.maxPositions,
		maxStockWeightPct: CAPITAL_SIZING.maxStockWeightPct,
		riskPerTradePct: CAPITAL_SIZING.riskPerTradePct,
	},
];

interface CandleRow {
	stock_id: number;
	bucket_start: Date;
	open: string;
	high: string;
	low: string;
	close: string;
	shares: number | null;
}

interface OpenPosition {
	stockId: number;
	shares: number;
	entryPrice: number;
	stopPrice: number;
	targetPrice: number;
	peakPrice: number;
	scaledOut: boolean;
	openedIndex: number;
	initialShares: number;
	riskPerShare: number;
}

interface TradeExit {
	stockId: number;
	rMultiple: number;
	pnl: number;
	reason: string;
}

interface Metrics {
	label: string;
	cagrPct: number;
	sharpe: number;
	maxDrawdownPct: number;
	trades: number;
	winRatePct: number;
	avgRPct: number;
	stops: number;
	targets: number;
	reversals: number;
	timeStops: number;
	trails: number;
}

function price(row: CandleRow, field: "open" | "high" | "low" | "close") {
	return Number(row[field]);
}

function pct(value: number): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

async function loadDailyCandles(): Promise<Map<number, CapitalCandle[]>> {
	const sql = postgres({
		host: process.env.POSTGRES_HOST || "/tmp",
		port: Number(process.env.POSTGRES_PORT || 5432),
		database: process.env.POSTGRES_DB || "sentinel_db",
		username: process.env.POSTGRES_USER || "sentinel_user",
		password:
			process.env.POSTGRES_PASSWORD ||
			"e63af385d45ae76c4a8b90b995c2cf1d8c0cf6ca444d3985",
	});
	const rows = await sql<CandleRow[]>`
		SELECT stock_id, bucket_start, open, high, low, close, shares
		FROM capital_market_candles
		WHERE interval_minutes = 1440
		ORDER BY stock_id, bucket_start
	`;
	await sql.end();
	const byStock = new Map<number, CapitalCandle[]>();
	for (const row of rows) {
		const list = byStock.get(row.stock_id) ?? [];
		list.push({
			timestamp: row.bucket_start.getTime() / 1000,
			open: price(row, "open"),
			high: price(row, "high"),
			low: price(row, "low"),
			close: price(row, "close"),
			shares: row.shares,
		});
		byStock.set(row.stock_id, list);
	}
	return byStock;
}

/** Equal-weight index of every stock's daily close, plus its regime flag. */
function buildRegimeSeries(
	byStock: Map<number, CapitalCandle[]>,
	smaDays: number,
): Map<number, boolean> {
	const sums = new Map<number, { sum: number; count: number }>();
	for (const candles of byStock.values()) {
		for (const candle of candles) {
			const day = Math.floor(candle.timestamp / DAY) * DAY;
			const bucket = sums.get(day) ?? { sum: 0, count: 0 };
			bucket.sum += candle.close;
			bucket.count += 1;
			sums.set(day, bucket);
		}
	}
	const days = [...sums.keys()].sort((a, b) => a - b);
	const closes = days.map(
		(day) => (sums.get(day)?.sum ?? 0) / Math.max(1, sums.get(day)?.count ?? 1),
	);
	const regime = new Map<number, boolean>();
	for (let i = 0; i < days.length; i++) {
		const day = days[i];
		if (day === undefined) continue;
		if (i < smaDays) {
			regime.set(day, true);
			continue;
		}
		const window = closes.slice(i - smaDays + 1, i + 1);
		const average =
			window.reduce((sum, value) => sum + value, 0) / window.length;
		regime.set(day, (closes[i] ?? 0) >= average);
	}
	return regime;
}

function simulate(
	byStock: Map<number, CapitalCandle[]>,
	variant: Variant,
): {
	metrics: Metrics;
	equity: number[];
} {
	const allDays = [
		...new Set(
			[...byStock.values()].flatMap((candles) =>
				candles.map((candle) => Math.floor(candle.timestamp / DAY) * DAY),
			),
		),
	].sort((a, b) => a - b);
	const regime = buildRegimeSeries(byStock, 50);
	// Feature computation is O(n log n) per call because the pure helpers sort
	// their input, so feed it a 120-day window instead of the full five years.
	const FEATURE_WINDOW = 120;
	const indexByStock = new Map<number, Map<number, number>>();
	const candleByDay = new Map<number, Map<number, CapitalCandle>>();
	for (const [stockId, candles] of byStock) {
		const indexes = new Map<number, number>();
		const byDay = new Map<number, CapitalCandle>();
		candles.forEach((candle, index) => {
			const day = Math.floor(candle.timestamp / DAY) * DAY;
			indexes.set(day, index);
			byDay.set(day, candle);
		});
		indexByStock.set(stockId, indexes);
		candleByDay.set(stockId, byDay);
	}

	let cash = START_NAV;
	const positions = new Map<number, OpenPosition>();
	const exits: TradeExit[] = [];
	const equity: number[] = [];
	let peakEquity = START_NAV;
	let maxDrawdown = 0;
	let stopCount = 0;
	let targetCount = 0;
	let reversalCount = 0;
	let timeCount = 0;
	let trailCount = 0;

	const priceAt = (stockId: number, day: number) =>
		candleByDay.get(stockId)?.get(day) ?? null;

	const recordExit = (
		position: OpenPosition,
		shares: number,
		exitPrice: number,
		reason: string,
		feeRate: number,
	) => {
		const gross = exitPrice * shares;
		const fee = gross * feeRate;
		cash += gross - fee;
		const pnl = (exitPrice - position.entryPrice) * shares - fee;
		const rMultiple =
			(exitPrice - position.entryPrice) / Math.max(0.01, position.riskPerShare);
		exits.push({ stockId: position.stockId, rMultiple, pnl, reason });
		position.shares -= shares;
		if (position.shares <= 0) positions.delete(position.stockId);
		if (reason === "stop") stopCount += 1;
		if (reason === "target") targetCount += 1;
		if (reason === "reversal") reversalCount += 1;
		if (reason === "time") timeCount += 1;
		if (reason === "trail" || reason === "tighten_trail") trailCount += 1;
	};

	for (let dayIndex = MIN_HISTORY; dayIndex < allDays.length; dayIndex++) {
		const day = allDays[dayIndex];
		if (day === undefined) continue;
		const regimeOn = regime.get(day) ?? true;

		// Exits first, exactly like the engine.
		for (const position of [...positions.values()]) {
			const candle = priceAt(position.stockId, day);
			if (!candle) continue;
			const features = computeFeatures({
				stockId: position.stockId,
				price: candle.close,
				candles: (byStock.get(position.stockId) ?? []).slice(-FEATURE_WINDOW),
				regimeOn,
			});
			if (!features) continue;
			position.peakPrice = Math.max(position.peakPrice, candle.high);
			const daysHeld = Math.floor(
				(day - (allDays[position.openedIndex] ?? day)) / DAY,
			);
			const config = {
				trailingTriggerR: variant.trailingTriggerR,
				trailingAtrMultiplier: variant.trailingAtrMultiplier,
				trailingPct: variant.trailingPct,
				tightenTrailPct: variant.tightenTrailPct,
				scaleOutR: variant.scaleOutR,
				scaleOutFraction: variant.scaleOutFraction,
				timeStopDays: variant.timeStopDays,
			};
			const decision = evaluateExit({
				entryPrice: position.entryPrice,
				price: candle.close,
				peakPrice: position.peakPrice,
				stopPrice: position.stopPrice,
				targetPrice: position.targetPrice,
				atr: features.atr,
				ema20: features.ema20,
				ema50: features.ema50,
				score: scoreStock(features, {
					mode: "reversal",
					minEntryScore: 65,
					maxRsi: 75,
					overboughtSigma: 2,
					reversalEntrySigma: 1,
					reversalExitSigma: variant.reversalExitSigma,
					maxVolatilityPct: 40,
				}).score,
				daysHeld,
				scaledOut: position.scaledOut,
				mode: "reversal",
				meanPrice: features.sma20,
				zscore20: features.zscore20,
				reversalExitSigma: variant.reversalExitSigma,
				config,
			});

			// Intraday barrier checks are more honest than a close-only exit.
			if (candle.low <= position.stopPrice) {
				const gapDown = candle.open < position.stopPrice;
				recordExit(
					position,
					position.shares,
					gapDown ? candle.open : position.stopPrice,
					"stop",
					(SALE_FEE_BPS + SLIPPAGE_BPS) / 10_000,
				);
				continue;
			}
			if (decision.action === "scale_out") {
				const shares = Math.max(
					1,
					Math.floor(position.shares * decision.fraction),
				);
				recordExit(
					position,
					shares,
					candle.close,
					"scale_out",
					(SALE_FEE_BPS + SLIPPAGE_BPS) / 10_000,
				);
				position.scaledOut = true;
				continue;
			}
			if (position.targetPrice > 0 && candle.high >= position.targetPrice) {
				const gapUp = candle.open > position.targetPrice;
				recordExit(
					position,
					position.shares,
					gapUp ? candle.open : position.targetPrice,
					"target",
					(SALE_FEE_BPS + SLIPPAGE_BPS) / 10_000,
				);
				continue;
			}
			if (decision.action === "sell") {
				recordExit(
					position,
					position.shares,
					candle.close,
					decision.reasonCode,
					(SALE_FEE_BPS + SLIPPAGE_BPS) / 10_000,
				);
			}
		}

		// Mark to market before sizing new entries.
		let positionsValue = 0;
		for (const position of positions.values()) {
			const candle = priceAt(position.stockId, day);
			if (candle) positionsValue += candle.close * position.shares;
		}
		const nav = cash + positionsValue;
		const equityDay = nav;
		equity.push(equityDay);
		peakEquity = Math.max(peakEquity, equityDay);
		maxDrawdown = Math.max(
			maxDrawdown,
			((peakEquity - equityDay) / peakEquity) * 100,
		);

		// Entries: respect the 15% cash reserve and the 85% equity cap, as the
		// live book does.
		const equityPct = nav > 0 ? (positionsValue / nav) * 100 : 0;
		const freeCash = Math.max(0, cash - nav * 0.15);
		const candidates: Array<{
			stockId: number;
			features: ReturnType<typeof computeFeatures>;
			score: number;
		}> = [];
		for (const [stockId, candles] of byStock) {
			if (positions.has(stockId)) continue;
			const candle = priceAt(stockId, day);
			if (!candle) continue;
			const index = indexByStock.get(stockId)?.get(day);
			if (index === undefined || index + 1 < MIN_HISTORY) continue;
			const known = candles.slice(
				Math.max(0, index + 1 - FEATURE_WINDOW),
				index + 1,
			);
			const features = computeFeatures({
				stockId,
				price: candle.close,
				candles: known,
				regimeOn,
			});
			if (!features) continue;
			const scored = scoreStock(features, {
				mode: "reversal",
				minEntryScore: 65,
				maxRsi: 75,
				overboughtSigma: 2,
				reversalEntrySigma: 1,
				reversalExitSigma: variant.reversalExitSigma,
				maxVolatilityPct: 40,
			});
			if (!scored.eligible) continue;
			candidates.push({ stockId, features, score: scored.score });
		}
		candidates.sort((a, b) => b.score - a.score);

		if (equityPct < 85) {
			for (const candidate of candidates) {
				if (positions.size >= variant.maxPositions) break;
				const features = candidate.features;
				if (!features) continue;
				const multiplier = variant.confidence
					? confidenceMultiplier(candidate.score)
					: 1;
				const plan = planEntry({
					nav: formatMoney(BigInt(Math.round(nav * 10_000))),
					freeCash: formatMoney(BigInt(Math.round(freeCash * 10_000))),
					price: features.price,
					atr: features.atr,
					existingWeightPct: 0,
					sizeMultiplier: multiplier,
					maxSizeMultiplier: CAPITAL_CONFIDENCE.maxMultiplier,
					config: {
						riskPerTradePct: variant.riskPerTradePct,
						maxStockWeightPct: variant.maxStockWeightPct,
						stopAtrMultiplier: variant.stopAtrMultiplier,
						stopMinPct: variant.stopMinPct,
						stopMaxPct: variant.stopMaxPct,
						targetR: variant.targetR,
						minNotional: CAPITAL_SIZING.minNotional,
					},
				});
				if (plan.shares <= 0) continue;
				const fillPrice = features.price * (1 + SLIPPAGE_BPS / 10_000);
				const cost = fillPrice * plan.shares;
				if (cost > cash) continue;
				cash -= cost;
				const stopDistance = entryStopDistance({
					price: features.price,
					atr: features.atr,
					atrMultiplier: variant.stopAtrMultiplier,
					minPct: variant.stopMinPct,
					maxPct: variant.stopMaxPct,
				});
				positions.set(candidate.stockId, {
					stockId: candidate.stockId,
					shares: plan.shares,
					entryPrice: fillPrice,
					stopPrice: fillPrice - stopDistance,
					targetPrice: fillPrice + stopDistance * variant.targetR,
					peakPrice: fillPrice,
					scaledOut: false,
					openedIndex: dayIndex,
					initialShares: plan.shares,
					riskPerShare: stopDistance,
				});
			}
		}
	}

	const days = Math.max(1, allDays.length - MIN_HISTORY);
	const finalNav = equity[equity.length - 1] ?? START_NAV;
	const cagrPct = (Math.pow(finalNav / START_NAV, 365 / days) - 1) * 100;
	const dailyReturns: number[] = [];
	for (let i = 1; i < equity.length; i++) {
		const previous = equity[i - 1] ?? 1;
		const current = equity[i] ?? previous;
		dailyReturns.push(current / previous - 1);
	}
	const mean =
		dailyReturns.reduce((sum, value) => sum + value, 0) /
		Math.max(1, dailyReturns.length);
	const variance =
		dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
		Math.max(1, dailyReturns.length - 1);
	const sharpe =
		variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(365) : 0;
	const wins = exits.filter((exit) => exit.pnl > 0).length;
	return {
		metrics: {
			label: variant.name,
			cagrPct,
			sharpe,
			maxDrawdownPct: maxDrawdown,
			trades: exits.length,
			winRatePct: exits.length > 0 ? (wins / exits.length) * 100 : 0,
			avgRPct:
				exits.length > 0
					? exits.reduce((sum, exit) => sum + exit.rMultiple, 0) / exits.length
					: 0,
			stops: stopCount,
			targets: targetCount,
			reversals: reversalCount,
			timeStops: timeCount,
			trails: trailCount,
		},
		equity,
	};
}

async function main() {
	const byStock = await loadDailyCandles();
	console.log(
		`Loaded ${byStock.size} stocks, ${[...byStock.values()].reduce((sum, candles) => sum + candles.length, 0).toLocaleString()} daily candles.`,
	);
	const results = VARIANTS.map((variant) => simulate(byStock, variant));
	console.log("");
	console.log(
		"variant".padEnd(44),
		"CAGR".padStart(8),
		"Sharpe".padStart(8),
		"MaxDD".padStart(8),
		"Trades".padStart(7),
		"Win%".padStart(7),
		"AvgR".padStart(7),
	);
	for (const result of results) {
		const metrics = result.metrics;
		console.log(
			metrics.label.padEnd(44),
			pct(metrics.cagrPct).padStart(8),
			metrics.sharpe.toFixed(2).padStart(8),
			pct(-metrics.maxDrawdownPct).padStart(8),
			String(metrics.trades).padStart(7),
			pct(metrics.winRatePct).padStart(7),
			metrics.avgRPct.toFixed(2).padStart(7),
		);
	}
	console.log("");
	for (const result of results) {
		const m = result.metrics;
		console.log(
			`${m.label}: stops ${m.stops}, targets ${m.targets}, reversals ${m.reversals}, trail ${m.trails}, time ${m.timeStops}`,
		);
	}
}

await main();
