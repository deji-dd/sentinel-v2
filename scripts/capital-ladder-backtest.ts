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
	/** Minimum R before the z-score thesis exit may fire (0 = legacy). */
	zExitMinR: number;
	/** Entry requires z <= -entrySigma. */
	entrySigma: number;
	minEntryScore: number;
	confidence: boolean;
	/** Rescale confidence over minEntryScore..100 instead of 0..100. */
	confidenceRescale: boolean;
	maxPositions: number;
	maxStockWeightPct: number;
	riskPerTradePct: number;
}

const BASE: Omit<Variant, "name"> = {
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
	zExitMinR: 0,
	entrySigma: 1,
	minEntryScore: 65,
	confidence: true,
	confidenceRescale: false,
	maxPositions: CAPITAL_SIZING.minPositions,
	maxStockWeightPct: CAPITAL_SIZING.maxStockWeightPct,
	riskPerTradePct: CAPITAL_SIZING.riskPerTradePct,
};

const VARIANTS: Variant[] = [
	{
		...BASE,
		name: "legacy (4% stop, z>=0)",
		stopAtrMultiplier: 2,
		stopMinPct: 4,
		stopMaxPct: 100,
		targetR: 2,
		scaleOutR: 2,
		trailingAtrMultiplier: 1.5,
		trailingPct: 6,
		tightenTrailPct: 4,
		reversalExitSigma: 0,
		confidence: false,
		maxPositions: 12,
		maxStockWeightPct: 20,
	},
	{ ...BASE, name: "current (entry -1.0, z-exit +1.0)" },
	{
		...BASE,
		name: "current + 10 slots (8.5% weight)",
		maxPositions: 10,
		maxStockWeightPct: CAPITAL_SIZING.maxEquityPct / 10,
	},
	{
		...BASE,
		name: "current + 12 slots (7.08% weight)",
		maxPositions: CAPITAL_SIZING.maxPositions,
		maxStockWeightPct:
			CAPITAL_SIZING.maxEquityPct / CAPITAL_SIZING.maxPositions,
	},
	{ ...BASE, name: "current + z-exit only at +1R", zExitMinR: 1 },
	{ ...BASE, name: "entry -1.25", entrySigma: 1.25 },
	{
		...BASE,
		name: "entry -1.25 + score 72",
		entrySigma: 1.25,
		minEntryScore: 72,
	},
	{
		...BASE,
		name: "entry -1.25 + z-exit +1.5σ",
		entrySigma: 1.25,
		reversalExitSigma: 1.5,
	},
	{
		...BASE,
		name: "entry -1.25 + z-exit at +1R",
		entrySigma: 1.25,
		zExitMinR: 1,
	},
	{
		...BASE,
		name: "entry -1.25 + z-exit +1R + score 72",
		entrySigma: 1.25,
		zExitMinR: 1,
		minEntryScore: 72,
	},
	{
		...BASE,
		name: "entry -1.25 + z-exit +1R + rescale",
		entrySigma: 1.25,
		zExitMinR: 1,
		confidenceRescale: true,
	},
	{ ...BASE, name: "entry -1.5", entrySigma: 1.5 },
	{
		...BASE,
		name: "entry -1.5 + z-exit at +1R",
		entrySigma: 1.5,
		zExitMinR: 1,
	},
	{
		...BASE,
		name: "entry -1.5 + z-exit +1.5σ",
		entrySigma: 1.5,
		reversalExitSigma: 1.5,
	},
	{
		...BASE,
		name: "entry -1.5 + z-exit +1R + rescale",
		entrySigma: 1.5,
		zExitMinR: 1,
		confidenceRescale: true,
	},
	{
		...BASE,
		name: "entry -1.5 + z-exit +1R + 2.5% stop",
		entrySigma: 1.5,
		zExitMinR: 1,
		stopAtrMultiplier: 0,
		stopMinPct: 2.5,
		stopMaxPct: 2.5,
	},
];

/**
 * Confidence multiplier, optionally rescaled over the *eligible* score range.
 *
 * `confidenceMultiplier` maps 0..100 to 0.5..1.5, but the entry floor is 65, so
 * the live book can never size below 1.15x (9.2% of NAV). The rescaled version
 * maps the floor to 0.5x so a marginal name gets half the weight of a strong
 * one, which is what the 4-12% range in the docs actually implies.
 */
function sizeMultiplier(score: number, variant: Variant): number {
	if (!variant.confidence) return 1;
	if (!variant.confidenceRescale) return confidenceMultiplier(score);
	const span = Math.max(1, 100 - variant.minEntryScore);
	const t = Math.min(1, Math.max(0, (score - variant.minEntryScore) / span));
	return 0.5 + t;
}

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
	holdDays: number;
}

interface Metrics {
	label: string;
	cagrPct: number;
	sharpe: number;
	maxDrawdownPct: number;
	trades: number;
	winRatePct: number;
	avgRPct: number;
	avgHoldDays: number;
	avgDeployedPct: number;
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
	const deployedPct: number[] = [];

	const priceAt = (stockId: number, day: number) =>
		candleByDay.get(stockId)?.get(day) ?? null;

	const recordExit = (
		position: OpenPosition,
		shares: number,
		exitPrice: number,
		reason: string,
		feeRate: number,
		holdDays: number,
	) => {
		const gross = exitPrice * shares;
		const fee = gross * feeRate;
		cash += gross - fee;
		const pnl = (exitPrice - position.entryPrice) * shares - fee;
		const rMultiple =
			(exitPrice - position.entryPrice) / Math.max(0.01, position.riskPerShare);
		exits.push({
			stockId: position.stockId,
			rMultiple,
			pnl,
			reason,
			holdDays,
		});
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
		//
		// Live evaluates the whole ladder on the same 60-second path, so the
		// cheapest triggered level wins. The old replay booked the +2R target
		// against the daily high but the z-exit against the close, which handed
		// the target wins the engine would have taken at the (always lower)
		// thesis level. This keeps every level on one path: the open, then the
		// stop (adverse first), then each upside level in ascending price order,
		// then the close for trail/time.
		for (const position of [...positions.values()]) {
			const candle = priceAt(position.stockId, day);
			if (!candle) continue;
			const index = indexByStock.get(position.stockId)?.get(day);
			if (index === undefined) continue;
			const series = byStock.get(position.stockId) ?? [];
			// Features known at the start of the day: closes through yesterday.
			// The old code passed the last 120 candles of the *whole* series,
			// leaking the final 20-day mean and sigma into every historical bar.
			const known = series.slice(Math.max(0, index - FEATURE_WINDOW), index);
			const features = computeFeatures({
				stockId: position.stockId,
				price: candle.close,
				candles: known,
				regimeOn,
			});
			if (!features) continue;
			const daysHeld = Math.floor(
				(day - (allDays[position.openedIndex] ?? day)) / DAY,
			);
			const feeRate = (SALE_FEE_BPS + SLIPPAGE_BPS) / 10_000;
			const risk = Math.max(0.01, position.riskPerShare);
			const score = scoreStock(features, {
				mode: "reversal",
				minEntryScore: variant.minEntryScore,
				maxRsi: 75,
				overboughtSigma: 2,
				reversalEntrySigma: variant.entrySigma,
				reversalExitSigma: variant.reversalExitSigma,
				maxVolatilityPct: 40,
			}).score;
			const config = {
				trailingTriggerR: variant.trailingTriggerR,
				trailingAtrMultiplier: variant.trailingAtrMultiplier,
				trailingPct: variant.trailingPct,
				tightenTrailPct: variant.tightenTrailPct,
				scaleOutR: variant.scaleOutR,
				scaleOutFraction: variant.scaleOutFraction,
				timeStopDays: variant.timeStopDays,
				zExitMinR: variant.zExitMinR,
			};
			const zAt = (value: number) =>
				features.sd20 > 0 ? (value - features.sma20) / features.sd20 : 0;
			const decide = (price: number, peak: number) =>
				evaluateExit({
					entryPrice: position.entryPrice,
					price,
					peakPrice: peak,
					stopPrice: position.stopPrice,
					targetPrice: position.targetPrice,
					atr: features.atr,
					ema20: features.ema20,
					ema50: features.ema50,
					score,
					daysHeld,
					scaledOut: position.scaledOut,
					mode: "reversal",
					meanPrice: features.sma20,
					zscore20: zAt(price),
					reversalExitSigma: variant.reversalExitSigma,
					config,
				});

			// 1. The open. Gaps fill beyond the stop or the target.
			const openPeak = Math.max(position.peakPrice, candle.open);
			const openDecision = decide(candle.open, openPeak);
			if (openDecision.action === "sell") {
				recordExit(
					position,
					position.shares,
					candle.open,
					openDecision.reasonCode,
					feeRate,
					daysHeld,
				);
				continue;
			}
			if (openDecision.action === "scale_out") {
				recordExit(
					position,
					Math.max(1, Math.floor(position.shares * openDecision.fraction)),
					candle.open,
					"scale_out",
					feeRate,
					daysHeld,
				);
				position.scaledOut = true;
			}

			// 2. Adverse excursion first. When the low and an upside level are
			// both inside one bar, assume the stop was reached first.
			if (candle.low <= position.stopPrice) {
				recordExit(
					position,
					position.shares,
					position.stopPrice,
					"stop",
					feeRate,
					daysHeld,
				);
				continue;
			}

			// 3. Upside levels, cheapest first. The thesis exit is a price level
			// (`sma20 + sd20 * sigma`, gated by `zExitMinR`), so it can be ranked
			// against the trim and the target on the same path.
			const zLevel =
				features.sd20 > 0
					? features.sma20 + features.sd20 * variant.reversalExitSigma
					: features.sma20;
			const zGate = position.entryPrice + variant.zExitMinR * risk;
			const levels: Array<{
				price: number;
				kind: "scale_out" | "target" | "reversal";
			}> = [];
			if (!position.scaledOut && variant.scaleOutFraction > 0) {
				levels.push({
					price: position.entryPrice + variant.scaleOutR * risk,
					kind: "scale_out",
				});
			}
			if (position.targetPrice > 0) {
				levels.push({ price: position.targetPrice, kind: "target" });
			}
			levels.push({ price: Math.max(zLevel, zGate), kind: "reversal" });
			// Same priority as `evaluateExit` when two levels share a price:
			// trim, then target, then thesis.
			const rank = { scale_out: 0, target: 1, reversal: 2 } as const;
			levels.sort((a, b) => a.price - b.price || rank[a.kind] - rank[b.kind]);
			let exited = false;
			for (const level of levels) {
				if (candle.high < level.price) continue;
				if (level.kind === "scale_out") {
					recordExit(
						position,
						Math.max(1, Math.floor(position.shares * variant.scaleOutFraction)),
						level.price,
						"scale_out",
						feeRate,
						daysHeld,
					);
					position.scaledOut = true;
					continue;
				}
				recordExit(
					position,
					position.shares,
					level.price,
					level.kind,
					feeRate,
					daysHeld,
				);
				exited = true;
				break;
			}
			if (exited) continue;

			// 4. The close carries the trail, the tightened trail and the time
			// stop, with the bar high as the since-entry peak.
			const peak = Math.max(position.peakPrice, candle.open, candle.high);
			position.peakPrice = peak;
			const closeDecision = decide(candle.close, peak);
			if (closeDecision.action === "sell") {
				recordExit(
					position,
					position.shares,
					candle.close,
					closeDecision.reasonCode,
					feeRate,
					daysHeld,
				);
			} else if (closeDecision.action === "scale_out") {
				recordExit(
					position,
					Math.max(1, Math.floor(position.shares * closeDecision.fraction)),
					candle.close,
					"scale_out",
					feeRate,
					daysHeld,
				);
				position.scaledOut = true;
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
		deployedPct.push(equityPct);
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
				minEntryScore: variant.minEntryScore,
				maxRsi: 75,
				overboughtSigma: 2,
				reversalEntrySigma: variant.entrySigma,
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
				const multiplier = sizeMultiplier(candidate.score, variant);
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
	const avgHoldDays =
		exits.length > 0
			? exits.reduce((sum, exit) => sum + exit.holdDays, 0) / exits.length
			: 0;
	const avgDeployedPct =
		deployedPct.length > 0
			? deployedPct.reduce((sum, value) => sum + value, 0) / deployedPct.length
			: 0;
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
			avgHoldDays,
			avgDeployedPct,
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
		"Hold".padStart(6),
		"Deploy".padStart(7),
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
			`${metrics.avgHoldDays.toFixed(0)}d`.padStart(6),
			pct(metrics.avgDeployedPct).padStart(7),
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
