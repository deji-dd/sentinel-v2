/**
 * Pure price-action engine for the Sentinel Capital trading book.
 *
 * This is intentionally not a dividend/block optimizer. The fund is long-only
 * and trades shares for price appreciation, so every input here is price
 * derived: returns, volatility, ATR, EMA, RSI, Bollinger z-score, drawdown and
 * relative strength. There is no volume input because Torn's API exposes none,
 * and inventing one would make the score look more informed than it is.
 *
 * The functions are pure so the scheduler can run them against a fixture and
 * the API can explain a recommendation from the same numbers.
 */

import {
	type Money,
	moneyFromPriceShares,
	moneyToNumber,
	parseMoney,
} from "./capital-money";

export interface CapitalCandle {
	/** Unix seconds. */
	timestamp: number;
	open: number;
	high: number;
	low: number;
	close: number;
	/**
	 * Shares outstanding at the candle, when the store has it. This is the only
	 * flow proxy Torn exposes: there is no volume or order book. Optional so
	 * existing fixtures and 5m/60m aggregates stay valid.
	 */
	shares?: number | null;
}

export interface CapitalReturnSet {
	h1: number | null;
	h4: number | null;
	d1: number | null;
	d3: number | null;
	d7: number | null;
	d30: number | null;
	d90: number | null;
}

export interface CapitalStockFeatures {
	stockId: number;
	price: number;
	historyDays: number;
	returns: CapitalReturnSet;
	volatilityPct: number;
	atr: number;
	ema20: number;
	ema50: number;
	/** Simple 20-period mean of closes. The reversal target. */
	sma20: number;
	rsi14: number;
	zscore20: number;
	/** Negative numbers are drawdowns from the window high. */
	drawdown30Pct: number;
	drawdown90Pct: number;
	relativeStrength30Pct: number | null;
	/** Percent change in shares outstanding; null when the candles lack it. */
	sharesChange7Pct: number | null;
	sharesChange30Pct: number | null;
	regimeOn: boolean;
}

export interface CapitalFeatureInput {
	stockId: number;
	price: number;
	candles: CapitalCandle[];
	marketCandles?: CapitalCandle[];
	regimeOn: boolean;
}

const DAY_SECONDS = 86_400;

function sortedCandles(candles: CapitalCandle[]): CapitalCandle[] {
	return [...candles]
		.filter(
			(candle) =>
				Number.isFinite(candle.timestamp) &&
				Number.isFinite(candle.close) &&
				candle.close > 0,
		)
		.sort((a, b) => a.timestamp - b.timestamp);
}

function closeAtOrBefore(
	candles: CapitalCandle[],
	target: number,
): number | null {
	let chosen: number | null = null;
	for (const candle of candles) {
		if (candle.timestamp <= target) chosen = candle.close;
		else break;
	}
	return chosen;
}

/** Percentage return from the close at `targetSeconds` to the current price. */
export function returnPct(
	candles: CapitalCandle[],
	targetSeconds: number,
	currentPrice: number,
): number | null {
	const sorted = sortedCandles(candles);
	const last = sorted[sorted.length - 1];
	if (!last) return null;
	const reference = closeAtOrBefore(sorted, last.timestamp - targetSeconds);
	if (reference === null || reference <= 0) return null;
	return ((currentPrice - reference) / reference) * 100;
}

function standardDeviation(values: number[]): number {
	if (values.length < 2) return 0;
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const variance =
		values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
		(values.length - 1);
	return Math.sqrt(variance);
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Latest shares outstanding at or before `target`, walking the sorted candles
 * backwards. Returns null when the store has no flow data for that window.
 */
function sharesAtOrBefore(
	candles: CapitalCandle[],
	target: number,
): number | null {
	for (let i = candles.length - 1; i >= 0; i--) {
		const candle = candles[i];
		if (!candle || candle.timestamp > target) continue;
		if (
			typeof candle.shares === "number" &&
			Number.isFinite(candle.shares) &&
			candle.shares > 0
		) {
			return candle.shares;
		}
	}
	return null;
}

function sharesChange(
	candles: CapitalCandle[],
	latest: number | null,
	days: number,
): number | null {
	if (latest === null) return null;
	const last = candles[candles.length - 1];
	if (!last) return null;
	const reference = sharesAtOrBefore(
		candles,
		last.timestamp - days * DAY_SECONDS,
	);
	if (reference === null || reference <= 0) return null;
	return ((latest - reference) / reference) * 100;
}

/** Exponential moving average; returns the newest value. */
export function ema(values: number[], period: number): number {
	if (values.length === 0 || period <= 0) return 0;
	const multiplier = 2 / (period + 1);
	let current = values[0] ?? 0;
	for (let i = 1; i < values.length; i++) {
		const value = values[i];
		if (value === undefined) continue;
		current = (value - current) * multiplier + current;
	}
	return current;
}

/** Wilder's RSI over the supplied closes; 50 when there is not enough data. */
export function rsi(values: number[], period = 14): number {
	if (values.length < 2) return 50;
	let gains = 0;
	let losses = 0;
	const start = Math.max(1, values.length - period);
	for (let i = start; i < values.length; i++) {
		const previous = values[i - 1];
		const current = values[i];
		if (previous === undefined || current === undefined) continue;
		const change = current - previous;
		if (change >= 0) gains += change;
		else losses -= change;
	}
	const count = Math.max(1, values.length - start);
	const averageGain = gains / count;
	const averageLoss = losses / count;
	if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
	const relativeStrength = averageGain / averageLoss;
	return 100 - 100 / (1 + relativeStrength);
}

/** Average true range over the last `period` candles. */
export function atr(candles: CapitalCandle[], period = 14): number {
	const sorted = sortedCandles(candles);
	if (sorted.length < 2) return 0;
	const ranges: number[] = [];
	for (let i = 1; i < sorted.length; i++) {
		const current = sorted[i];
		const previous = sorted[i - 1];
		if (!current || !previous) continue;
		const trueRange = Math.max(
			current.high - current.low,
			Math.abs(current.high - previous.close),
			Math.abs(current.low - previous.close),
		);
		ranges.push(trueRange);
	}
	const recent = ranges.slice(-period);
	return mean(recent);
}

function maxHigh(candles: CapitalCandle[], windowSeconds: number): number {
	const sorted = sortedCandles(candles);
	const last = sorted[sorted.length - 1];
	if (!last) return 0;
	const cutoff = last.timestamp - windowSeconds;
	let high = 0;
	for (const candle of sorted) {
		if (candle.timestamp < cutoff) continue;
		if (candle.high > high) high = candle.high;
	}
	return high;
}

/**
 * Daily market regime: is the market index above its `smaDays`-day SMA?
 *
 * When there is not enough history the function returns `on: true` with
 * `days` below the threshold; the engine labels the run low-confidence rather
 * than pretending a bear market was detected.
 */
export function computeMarketRegime(
	marketCandles: CapitalCandle[],
	smaDays: number,
): { on: boolean; days: number } {
	const sorted = sortedCandles(marketCandles);
	if (sorted.length === 0) return { on: true, days: 0 };

	const byDay = new Map<number, number>();
	for (const candle of sorted) {
		const day = Math.floor(candle.timestamp / DAY_SECONDS);
		byDay.set(day, candle.close);
	}
	const days = [...byDay.keys()].sort((a, b) => a - b);
	const closes = days
		.map((day) => byDay.get(day))
		.filter((value): value is number => value !== undefined);
	const last = closes[closes.length - 1];
	if (last === undefined) return { on: true, days: 0 };
	if (closes.length < smaDays) return { on: true, days: closes.length };

	const window = closes.slice(-smaDays);
	const average = mean(window);
	return { on: last >= average, days: closes.length };
}

/** Computes every feature the score consumes. */
export function computeFeatures(
	input: CapitalFeatureInput,
): CapitalStockFeatures | null {
	const candles = sortedCandles(input.candles);
	const last = candles[candles.length - 1];
	if (!last) return null;

	const price = input.price > 0 ? input.price : last.close;
	if (!Number.isFinite(price) || price <= 0) return null;

	const first = candles[0];
	const closes = candles.map((candle) => candle.close);
	const returns: CapitalReturnSet = {
		h1: returnPct(candles, 3_600, price),
		h4: returnPct(candles, 4 * 3_600, price),
		d1: returnPct(candles, DAY_SECONDS, price),
		d3: returnPct(candles, 3 * DAY_SECONDS, price),
		d7: returnPct(candles, 7 * DAY_SECONDS, price),
		d30: returnPct(candles, 30 * DAY_SECONDS, price),
		d90: returnPct(candles, 90 * DAY_SECONDS, price),
	};

	const recentCloses = closes.slice(
		-Math.max(3, Math.min(closes.length, 1_000)),
	);
	const pctChanges: number[] = [];
	for (let i = 1; i < recentCloses.length; i++) {
		const previous = recentCloses[i - 1];
		const current = recentCloses[i];
		if (previous === undefined || current === undefined || previous <= 0)
			continue;
		pctChanges.push(((current - previous) / previous) * 100);
	}

	const intervalSeconds =
		candles.length >= 2
			? Math.max(
					60,
					(candles[candles.length - 1]?.timestamp ?? 0) -
						(candles[candles.length - 2]?.timestamp ?? 0),
				)
			: DAY_SECONDS;
	const periodsPerYear = (365 * DAY_SECONDS) / intervalSeconds;
	const volatilityPct =
		standardDeviation(pctChanges) * Math.sqrt(periodsPerYear);

	const sma20 = mean(closes.slice(-20));
	const sd20 = standardDeviation(closes.slice(-20));
	const zscore20 = sd20 > 0 ? (price - sma20) / sd20 : 0;

	const latestShares = sharesAtOrBefore(candles, last.timestamp);
	const sharesChange7Pct = sharesChange(candles, latestShares, 7);
	const sharesChange30Pct = sharesChange(candles, latestShares, 30);

	const windowHigh30 = maxHigh(candles, 30 * DAY_SECONDS);
	const windowHigh90 = maxHigh(candles, 90 * DAY_SECONDS);
	const drawdown30Pct =
		windowHigh30 > 0 ? ((price - windowHigh30) / windowHigh30) * 100 : 0;
	const drawdown90Pct =
		windowHigh90 > 0 ? ((price - windowHigh90) / windowHigh90) * 100 : 0;

	const marketReturns = input.marketCandles
		? (() => {
				const sortedMarket = sortedCandles(input.marketCandles);
				const marketLast = sortedMarket[sortedMarket.length - 1];
				return marketLast
					? returnPct(sortedMarket, 30 * DAY_SECONDS, marketLast.close)
					: null;
			})()
		: null;
	const relativeStrength30Pct =
		returns.d30 !== null && marketReturns !== null
			? returns.d30 - marketReturns
			: null;

	return {
		stockId: input.stockId,
		price,
		historyDays:
			first && last.timestamp > first.timestamp
				? (last.timestamp - first.timestamp) / DAY_SECONDS
				: 0,
		returns,
		volatilityPct,
		atr: atr(candles, 14),
		ema20: ema(closes, 20),
		ema50: ema(closes, 50),
		sma20,
		rsi14: rsi(closes, 14),
		zscore20,
		drawdown30Pct,
		drawdown90Pct,
		relativeStrength30Pct,
		sharesChange7Pct,
		sharesChange30Pct,
		regimeOn: input.regimeOn,
	};
}

/** Which alpha the score expresses. */
export type CapitalSignalMode = "momentum" | "reversal";

export interface CapitalScoringConfig {
	/** Defaults to `momentum` so old fixtures and stored snapshots keep working. */
	mode?: CapitalSignalMode;
	minEntryScore: number;
	maxRsi: number;
	overboughtSigma: number;
	/** Enter when the 20-period z-score is at or below -entrySigma. */
	reversalEntrySigma?: number;
	/** Exit once the 20-period z-score is at or above this level. */
	reversalExitSigma?: number;
	/** Reject a reversal candidate whose annualised volatility exceeds this. */
	maxVolatilityPct?: number;
	/** Below this many days of history the engine halves size and reports low confidence. */
	minHistoryDays?: number;
}

export interface CapitalScoreComponents {
	/** Momentum mode: trend strength. Reversal mode: price stretch below the mean. */
	trend: number;
	/** Momentum mode: entry timing. Reversal mode: shares-outstanding flow. */
	timing: number;
	risk: number;
	regime: number;
}

export interface CapitalSignalScore {
	score: number;
	components: CapitalScoreComponents;
	flags: string[];
	eligible: boolean;
}

function clamp100(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}

/**
 * Scores a stock for the book's configured alpha. `momentum` follows the
 * original trend system; `reversal` buys names stretched below their 20-period
 * mean and is the default.
 */
export function scoreStock(
	features: CapitalStockFeatures,
	config: CapitalScoringConfig,
): CapitalSignalScore {
	if ((config.mode ?? "momentum") === "reversal") {
		return scoreReversalStock(features, config);
	}
	return scoreMomentumStock(features, config);
}

function scoreMomentumStock(
	features: CapitalStockFeatures,
	config: CapitalScoringConfig,
): CapitalSignalScore {
	const flags: string[] = [];

	let trend = 0;
	if (features.ema20 > features.ema50) trend += 30;
	if ((features.returns.d7 ?? 0) > 0) trend += 20;
	if ((features.returns.d30 ?? 0) > 0) trend += 20;
	if ((features.returns.d3 ?? 0) > 0) trend += 10;
	if ((features.relativeStrength30Pct ?? 0) > 0) trend += 20;
	trend = clamp100(trend);

	let timing = 55;
	if (features.rsi14 >= 40 && features.rsi14 <= 65) timing += 20;
	if (features.rsi14 > config.maxRsi) {
		timing = 100 - (features.rsi14 - config.maxRsi) * 4;
		flags.push("overbought");
	}
	if (features.zscore20 > config.overboughtSigma) {
		timing = 0;
		flags.push("overbought");
	}
	if (features.ema20 > features.ema50 && features.price < features.ema20) {
		timing += 10;
	}
	timing = clamp100(timing);

	const risk = clamp100(
		100 -
			Math.min(60, Math.abs(features.volatilityPct) * 4) -
			Math.min(30, Math.abs(features.drawdown30Pct) * 2),
	);

	const regime = features.regimeOn ? 100 : 0;
	if (!features.regimeOn) flags.push("regime_off");
	if ((features.returns.d7 ?? 0) > 20) flags.push("chasing");
	if (features.ema20 < features.ema50 && (features.returns.d30 ?? 0) < 0) {
		flags.push("negative_trend");
	}
	if (features.drawdown90Pct < -30) flags.push("deep_drawdown");
	if (features.historyDays < (config.minHistoryDays ?? 14)) {
		flags.push("low_history");
	}

	const score = clamp100(
		trend * 0.45 + timing * 0.25 + risk * 0.2 + regime * 0.1,
	);

	const eligible =
		score >= config.minEntryScore &&
		!flags.includes("overbought") &&
		!flags.includes("chasing") &&
		!flags.includes("regime_off") &&
		!flags.includes("negative_trend");

	return {
		score,
		components: { trend, timing, risk, regime },
		flags,
		eligible,
	};
}

/**
 * Reversal alpha. The 5.5-year study (docs/capital-ml-research.md) found a
 * monotonic cross-sectional reversion: the biggest 20-day losers outperform and
 * momentum is anti-predictive. This score ranks names by how far they are
 * stretched below their own mean, weighted by shares-outstanding inflow, and
 * penalises volatility that would make the stop meaningless.
 */
function scoreReversalStock(
	features: CapitalStockFeatures,
	config: CapitalScoringConfig,
): CapitalSignalScore {
	const entrySigma = Math.max(0.25, config.reversalEntrySigma ?? 1);
	const maxVolatility = config.maxVolatilityPct ?? 40;
	const flags: string[] = [];

	const oversold = features.zscore20 <= -entrySigma;
	if (!oversold) flags.push("not_oversold");
	if (
		features.zscore20 > config.overboughtSigma ||
		features.rsi14 > config.maxRsi
	) {
		flags.push("overbought");
	}
	if (features.volatilityPct > maxVolatility) flags.push("too_volatile");
	if (features.drawdown90Pct < -50) flags.push("falling_knife");
	if (features.historyDays < (config.minHistoryDays ?? 14)) {
		flags.push("low_history");
	}

	const stretch = clamp100(
		clamp100((-features.zscore20 / entrySigma) * 100) * 0.6 +
			clamp100((-features.drawdown30Pct / 8) * 100) * 0.4,
	);
	// 0.5% of 30-day shares growth is a strong inflow, -0.5% a strong outflow.
	const flow = clamp100(50 + (features.sharesChange30Pct ?? 0) * 100);
	const risk = clamp100(100 - Math.max(0, features.volatilityPct - 12) * 3);
	const regime = features.regimeOn ? 100 : 0;

	const score = clamp100(
		stretch * 0.6 + flow * 0.2 + risk * 0.15 + regime * 0.05,
	);

	const eligible =
		score >= config.minEntryScore &&
		!flags.includes("not_oversold") &&
		!flags.includes("overbought") &&
		!flags.includes("too_volatile") &&
		!flags.includes("falling_knife") &&
		!flags.includes("low_history");

	return {
		score,
		components: { trend: stretch, timing: flow, risk, regime },
		flags,
		eligible,
	};
}

export interface CapitalEntryConfig {
	riskPerTradePct: number;
	maxStockWeightPct: number;
	stopAtrMultiplier: number;
	stopMinPct: number;
	minNotional: string;
}

export interface CapitalEntryPlan {
	shares: number;
	notional: Money;
	stopPrice: number;
	targetPrice: number;
	riskPerShare: number;
	riskAmount: number;
	positionPct: number;
}

/**
 * Converts a signal into an integer share count.
 *
 * Sizing is risk-first: the stop distance sets the share count, then the
 * per-stock weight cap and free cash constrain it. There is no block/increment
 * arithmetic here — any integer share count is valid.
 */
export function planEntry(input: {
	nav: string;
	freeCash: string;
	price: number;
	atr: number;
	existingWeightPct: number;
	config: CapitalEntryConfig;
}): CapitalEntryPlan {
	const nav = Number.parseFloat(input.nav);
	const freeCash = Number.parseFloat(input.freeCash);
	const { price } = input;
	if (
		!Number.isFinite(nav) ||
		!Number.isFinite(freeCash) ||
		nav <= 0 ||
		price <= 0
	) {
		return {
			shares: 0,
			notional: 0n,
			stopPrice: 0,
			targetPrice: 0,
			riskPerShare: 0,
			riskAmount: 0,
			positionPct: 0,
		};
	}

	const stopDistance = Math.max(
		input.atr * input.config.stopAtrMultiplier,
		price * (input.config.stopMinPct / 100),
	);
	if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
		return {
			shares: 0,
			notional: 0n,
			stopPrice: 0,
			targetPrice: 0,
			riskPerShare: 0,
			riskAmount: 0,
			positionPct: 0,
		};
	}

	const riskBudget = nav * (input.config.riskPerTradePct / 100);
	const sharesByRisk = Math.floor(riskBudget / stopDistance);

	const availableWeightPct = Math.max(
		0,
		input.config.maxStockWeightPct - input.existingWeightPct,
	);
	const maxNotional = nav * (availableWeightPct / 100);
	const sharesByWeight = Math.floor(maxNotional / price);
	const sharesByCash = Math.floor(freeCash / price);

	let shares = Math.min(sharesByRisk, sharesByWeight, sharesByCash);
	if (!Number.isFinite(shares) || shares <= 0) shares = 0;

	const notional = moneyFromPriceShares(price, shares);
	const minNotional = parseMoney(input.config.minNotional);
	if (notional < minNotional) {
		return {
			shares: 0,
			notional: 0n,
			stopPrice: 0,
			targetPrice: 0,
			riskPerShare: 0,
			riskAmount: 0,
			positionPct: 0,
		};
	}

	const stopPrice = Math.max(0.01, price - stopDistance);
	return {
		shares,
		notional,
		stopPrice,
		targetPrice: price + stopDistance * 2,
		riskPerShare: stopDistance,
		riskAmount: shares * stopDistance,
		positionPct: (moneyToNumber(notional) / nav) * 100,
	};
}

export interface CapitalExitConfig {
	trailingTriggerR: number;
	trailingAtrMultiplier: number;
	trailingPct: number;
	tightenTrailPct: number;
	scaleOutR: number;
	scaleOutFraction: number;
	timeStopDays: number;
}

export interface CapitalExitDecision {
	action: "hold" | "sell" | "scale_out";
	fraction: number;
	reason: string;
	rMultiple: number;
}

/** Evaluates stop, trail, scale-out, thesis and time exits in that order. */
export function evaluateExit(input: {
	entryPrice: number;
	price: number;
	peakPrice: number;
	stopPrice: number;
	atr: number;
	ema20: number;
	ema50: number;
	score: number;
	daysHeld: number;
	scaledOut: boolean;
	config: CapitalExitConfig;
	/** Defaults to `momentum`; `reversal` exits when the price mean-reverts. */
	mode?: CapitalSignalMode;
	/** 20-period mean used as the reversal target. Falls back to `ema20`. */
	meanPrice?: number;
	zscore20?: number;
	reversalExitSigma?: number;
}): CapitalExitDecision {
	const { entryPrice, price, peakPrice, stopPrice, config } = input;
	const initialRisk = Math.max(0.01, entryPrice - stopPrice);
	const rMultiple = (price - entryPrice) / initialRisk;

	if (price <= stopPrice) {
		return {
			action: "sell",
			fraction: 1,
			reason: "Hard stop reached.",
			rMultiple,
		};
	}

	if (rMultiple >= config.trailingTriggerR) {
		const trailDistance = Math.max(
			input.atr * config.trailingAtrMultiplier,
			price * (config.trailingPct / 100),
		);
		if (price <= peakPrice - trailDistance) {
			return {
				action: "sell",
				fraction: 1,
				reason: `Trailing stop hit after +${rMultiple.toFixed(2)}R.`,
				rMultiple,
			};
		}
	}

	if (rMultiple >= config.scaleOutR && !input.scaledOut) {
		return {
			action: "scale_out",
			fraction: Math.min(1, Math.max(0, config.scaleOutFraction)),
			reason: `Take one-third off at +${rMultiple.toFixed(2)}R.`,
			rMultiple,
		};
	}

	if (
		input.scaledOut &&
		rMultiple >= config.scaleOutR &&
		price <= peakPrice * (1 - config.tightenTrailPct / 100)
	) {
		return {
			action: "sell",
			fraction: 1,
			reason: "Tightened trail on the remaining position.",
			rMultiple,
		};
	}

	if ((input.mode ?? "momentum") === "reversal") {
		// The trade thesis is "the dip reverts". Once price is back at the
		// 20-period mean (or the z-score has recovered), there is nothing left
		// to harvest and the position should be recycled into a new dip.
		const meanPrice = input.meanPrice ?? input.ema20;
		const exitSigma = input.reversalExitSigma ?? 0;
		if (
			meanPrice > 0 &&
			(input.price >= meanPrice || (input.zscore20 ?? 0) >= exitSigma)
		) {
			return {
				action: "sell",
				fraction: 1,
				reason: "Mean reversion complete: price is back at the 20-period mean.",
				rMultiple,
			};
		}
	} else if (input.ema20 < input.ema50 && input.score < 35) {
		return {
			action: "sell",
			fraction: 1,
			reason: "Thesis broke: trend flipped and the score collapsed.",
			rMultiple,
		};
	}

	if (input.daysHeld >= config.timeStopDays && rMultiple < 1) {
		return {
			action: "sell",
			fraction: 1,
			reason: "Time stop: no +1R within the holding window.",
			rMultiple,
		};
	}

	return {
		action: "hold",
		fraction: 0,
		reason: "No exit condition met.",
		rMultiple,
	};
}
