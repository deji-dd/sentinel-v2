/**
 * Sentinel Capital ML primitives.
 *
 * Deliberately small and dependency-free: a calibrated logistic meta-label on
 * the reversal candidate set, plus the metrics needed to decide whether it beats
 * the rule. The same feature vector is used offline (training) and online (the
 * engine), so a model can never drift from its training definition.
 *
 * No dataset, no training loop and no model file live here — those are in
 * `scripts/capital-ml-train.ts` and the `capital_ml_*` tables.
 */
import type { CapitalCandle, CapitalStockFeatures } from "./capital-signals";

/**
 * Label definition shared by training and the live outcome scorer. Bump it
 * whenever the entry, barrier, fee or timeout semantics change: a model trained
 * under one spec must never be scored (or mixed) under another.
 *
 * v2: enter on the next bar's open with a 1–5 minute delay cost, touch barriers
 * on daily high/low, assume the stop is hit first when both are touched in the
 * same bar, charge the 0.1% sale fee, and keep timeout as a third outcome.
 */
export const CAPITAL_ML_LABEL_SPEC = "first_trim_r1_v2";

/** Torn charges the seller 0.1%; the buy side is free. */
export const CAPITAL_SALE_FEE_PCT = 0.1;

/** Default first-trim barrier, mirroring +1R against a 2% entry stop. */
export const CAPITAL_ML_TARGET_PCT = 2;
export const CAPITAL_ML_STOP_PCT = 2;
export const CAPITAL_ML_HORIZON_DAYS = 20;

/**
 * Conservative cost of the 1–5 minute manual execution delay. The paper book's
 * default slippage is 5 bps; daily bars cannot resolve the actual intraday
 * move, so training charges that same assumption on the next bar's open.
 */
export const CAPITAL_EXECUTION_DELAY_BPS = 5;

/** Feature order is part of the model artifact; never reorder without retraining. */
export const CAPITAL_ML_FEATURES = [
	"zscore20",
	"drawdown30Pct",
	"drawdown90Pct",
	"returnD7",
	"returnD30",
	"returnD90",
	"volatilityPct",
	"sharesChange7Pct",
	"sharesChange30Pct",
	"rsi14",
	"distanceFromSma20Pct",
	"regimeOn",
] as const;

export type CapitalMlFeatureName = (typeof CAPITAL_ML_FEATURES)[number];

export interface LogisticModel {
	intercept: number;
	weights: number[];
	/** Training-set standardisation, applied before the weights. */
	mean: number[];
	std: number[];
	features: readonly string[];
	/** Label definition, so an old model is not scored against a new target. */
	targetPct: number;
	stopPct: number;
	horizonDays: number;
	/**
	 * Version of the live exit decision and label construction.
	 * `first_trim_r1_v2` = +1R trim vs the frozen entry stop, next-bar entry,
	 * fee-adjusted, high/low touches, stop-first on same-bar ambiguity.
	 */
	labelSpec?: string;
	/** Optional Platt scaling fitted on the validation split. */
	platt?: { a: number; b: number };
}

/** The vector the engine computes. Null flow features become 0. */
export function capitalMlFeatureVector(
	features: CapitalStockFeatures,
): number[] {
	return [
		features.zscore20,
		features.drawdown30Pct,
		features.drawdown90Pct,
		features.returns.d7 ?? 0,
		features.returns.d30 ?? 0,
		features.returns.d90 ?? 0,
		features.volatilityPct,
		features.sharesChange7Pct ?? 0,
		features.sharesChange30Pct ?? 0,
		features.rsi14,
		features.sma20 > 0 ? (features.price / features.sma20 - 1) * 100 : 0,
		features.regimeOn ? 1 : 0,
	];
}

export function sigmoid(value: number): number {
	if (value >= 40) return 1;
	if (value <= -40) return 0;
	return 1 / (1 + Math.exp(-value));
}

export function predictProbability(
	model: LogisticModel,
	raw: number[],
): number {
	if (raw.length !== model.weights.length) {
		throw new Error(
			`Feature count ${raw.length} does not match model ${model.weights.length}.`,
		);
	}
	let eta = model.intercept;
	for (let i = 0; i < raw.length; i++) {
		const value = raw[i] ?? 0;
		const mean = model.mean[i] ?? 0;
		const std = model.std[i] ?? 1;
		const scaled = std > 0 ? (value - mean) / std : 0;
		eta += (model.weights[i] ?? 0) * scaled;
	}
	const probability = sigmoid(eta);
	if (!model.platt || !Number.isFinite(model.platt.a)) return probability;
	const clamped = Math.min(1 - 1e-6, Math.max(1e-6, probability));
	const logit = Math.log(clamped / (1 - clamped));
	return sigmoid(model.platt.a * logit + model.platt.b);
}

export function standardise(
	rows: number[][],
	mean: number[],
	std: number[],
): number[][] {
	return rows.map((row) =>
		row.map((value, i) => {
			const sd = std[i] ?? 1;
			return sd > 0 ? (value - (mean[i] ?? 0)) / sd : 0;
		}),
	);
}

export function featureStats(rows: number[][]): {
	mean: number[];
	std: number[];
} {
	const width = rows[0]?.length ?? 0;
	const mean = new Array<number>(width).fill(0);
	const std = new Array<number>(width).fill(0);
	if (rows.length === 0) return { mean, std };
	for (let i = 0; i < width; i++) {
		let sum = 0;
		for (const row of rows) sum += row[i] ?? 0;
		mean[i] = sum / rows.length;
	}
	for (let i = 0; i < width; i++) {
		let sum = 0;
		for (const row of rows) {
			const delta = (row[i] ?? 0) - (mean[i] ?? 0);
			sum += delta * delta;
		}
		std[i] = rows.length > 1 ? Math.sqrt(sum / (rows.length - 1)) : 1;
		if (!(std[i] ?? 0) || (std[i] ?? 0) < 1e-9) std[i] = 1;
	}
	return { mean, std };
}

/** Solves `A x = b` for a small dense system (Gaussian elimination with pivoting). */
function solveLinear(A: number[][], b: number[]): number[] {
	const n = b.length;
	const matrix = A.map((row, i) => [...row, b[i] ?? 0]);
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let row = col + 1; row < n; row++) {
			if (
				Math.abs(matrix[row]?.[col] ?? 0) > Math.abs(matrix[pivot]?.[col] ?? 0)
			) {
				pivot = row;
			}
		}
		const current = matrix[col];
		const swap = matrix[pivot];
		if (!current || !swap) continue;
		matrix[col] = swap;
		matrix[pivot] = current;
		const diagonal = matrix[col]?.[col] ?? 0;
		if (Math.abs(diagonal) < 1e-12) continue;
		for (let row = col + 1; row < n; row++) {
			const target = matrix[row];
			if (!target) continue;
			const factor = (target[col] ?? 0) / diagonal;
			if (factor === 0) continue;
			for (let k = col; k <= n; k++) {
				target[k] = (target[k] ?? 0) - factor * (matrix[col]?.[k] ?? 0);
			}
		}
	}
	const solution = new Array<number>(n).fill(0);
	for (let row = n - 1; row >= 0; row--) {
		let sum = matrix[row]?.[n] ?? 0;
		for (let k = row + 1; k < n; k++) {
			sum -= (matrix[row]?.[k] ?? 0) * (solution[k] ?? 0);
		}
		const diagonal = matrix[row]?.[row] ?? 0;
		solution[row] = Math.abs(diagonal) < 1e-12 ? 0 : sum / diagonal;
	}
	return solution;
}

/**
 * Iteratively reweighted least squares for L2 logistic regression.
 * Standardise the rows first; the returned intercept/weights are for those.
 */
export function fitLogistic(
	rows: number[][],
	labels: number[],
	options: { l2?: number; iterations?: number } = {},
): { intercept: number; weights: number[] } {
	const width = rows[0]?.length ?? 0;
	const l2 = options.l2 ?? 1;
	const iterations = options.iterations ?? 25;
	const n = rows.length;
	if (n === 0 || width === 0) {
		return { intercept: 0, weights: new Array<number>(width).fill(0) };
	}
	// Design matrix with an intercept column first.
	const X = rows.map((row) => [1, ...row]);
	const y = labels;
	let beta = new Array<number>(width + 1).fill(0);

	for (let iter = 0; iter < iterations; iter++) {
		const eta = new Array<number>(n).fill(0);
		for (let i = 0; i < n; i++) {
			let value = 0;
			const row = X[i];
			if (!row) continue;
			for (let j = 0; j <= width; j++) value += (row[j] ?? 0) * (beta[j] ?? 0);
			eta[i] = value;
		}
		// Working response and weights.
		const z = new Array<number>(n).fill(0);
		const w = new Array<number>(n).fill(0);
		for (let i = 0; i < n; i++) {
			const p = sigmoid(eta[i] ?? 0);
			const clamped = Math.min(1 - 1e-9, Math.max(1e-9, p));
			const variance = clamped * (1 - clamped);
			w[i] = variance;
			z[i] = (eta[i] ?? 0) + ((y[i] ?? 0) - clamped) / variance;
		}
		const H: number[][] = Array.from({ length: width + 1 }, () =>
			new Array<number>(width + 1).fill(0),
		);
		const g = new Array<number>(width + 1).fill(0);
		for (let i = 0; i < n; i++) {
			const row = X[i];
			if (!row) continue;
			const weight = w[i] ?? 0;
			for (let a = 0; a <= width; a++) {
				g[a] = (g[a] ?? 0) + (row[a] ?? 0) * weight * (z[i] ?? 0);
				for (let b = a; b <= width; b++) {
					H[a]![b] = (H[a]![b] ?? 0) + (row[a] ?? 0) * weight * (row[b] ?? 0);
				}
			}
		}
		for (let a = 0; a <= width; a++) {
			for (let b = 0; b < a; b++) H[a]![b] = H[b]?.[a] ?? 0;
		}
		// Do not penalise the intercept.
		for (let a = 1; a <= width; a++) H[a]![a] = (H[a]![a] ?? 0) + l2;
		const next = solveLinear(H, g);
		let delta = 0;
		for (let j = 0; j < next.length; j++) {
			delta += Math.abs((next[j] ?? 0) - (beta[j] ?? 0));
		}
		beta = next;
		if (delta < 1e-7) break;
	}
	return { intercept: beta[0] ?? 0, weights: beta.slice(1) };
}

/** Mann-Whitney AUC; ties count as half. Returns 0.5 for a single class. */
export function auc(probabilities: number[], labels: number[]): number {
	const n = labels.length;
	const pairs = probabilities.map((p, i) => ({ p, y: labels[i] ?? 0 }));
	const positives = pairs.filter((pair) => pair.y > 0).length;
	const negatives = n - positives;
	if (positives === 0 || negatives === 0) return 0.5;
	pairs.sort((a, b) => a.p - b.p);
	// Average ranks for ties, then rank-sum of positives.
	const ranks = new Array<number>(n).fill(0);
	let i = 0;
	while (i < n) {
		let j = i;
		while (
			j + 1 < n &&
			Math.abs((pairs[j + 1]?.p ?? 0) - (pairs[i]?.p ?? 0)) < 1e-12
		) {
			j++;
		}
		const average = (i + j) / 2 + 1;
		for (let k = i; k <= j; k++) ranks[k] = average;
		i = j + 1;
	}
	let rankSum = 0;
	for (let k = 0; k < n; k++) {
		if ((pairs[k]?.y ?? 0) > 0) rankSum += ranks[k] ?? 0;
	}
	return (
		(rankSum - (positives * (positives + 1)) / 2) / (positives * negatives)
	);
}

export function brierScore(probabilities: number[], labels: number[]): number {
	if (labels.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < labels.length; i++) {
		const p = probabilities[i] ?? 0;
		sum += (p - (labels[i] ?? 0)) ** 2;
	}
	return sum / labels.length;
}

export function logLoss(probabilities: number[], labels: number[]): number {
	if (labels.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < labels.length; i++) {
		const p = Math.min(1 - 1e-9, Math.max(1e-9, probabilities[i] ?? 0));
		sum += (labels[i] ?? 0) > 0 ? Math.log(p) : Math.log(1 - p);
	}
	return -sum / labels.length;
}

export interface CalibrationBucket {
	lower: number;
	upper: number;
	count: number;
	meanProbability: number;
	observedRate: number;
}

export function calibrationBuckets(
	probabilities: number[],
	labels: number[],
	buckets = 5,
): CalibrationBucket[] {
	const out: CalibrationBucket[] = [];
	for (let b = 0; b < buckets; b++) {
		const lower = b / buckets;
		const upper = (b + 1) / buckets;
		let count = 0;
		let pSum = 0;
		let ySum = 0;
		for (let i = 0; i < probabilities.length; i++) {
			const p = probabilities[i] ?? 0;
			if (p < lower || (b < buckets - 1 && p >= upper)) continue;
			count++;
			pSum += p;
			ySum += labels[i] ?? 0;
		}
		out.push({
			lower,
			upper,
			count,
			meanProbability: count ? pSum / count : 0,
			observedRate: count ? ySum / count : 0,
		});
	}
	return out;
}

export type BarrierOutcome = "target" | "stop" | "timeout";

/** The path information the barrier needs; daily highs/lows, not closes only. */
export interface BarrierCandle {
	high: number;
	low: number;
	close: number;
}

export interface BarrierResult {
	outcome: BarrierOutcome;
	/** 1 when the target is hit first; 0 for stop or timeout (binary meta-label). */
	label: 0 | 1;
	exitPrice: number;
	/** Net return after the sale fee (the only side Torn charges). */
	returnPct: number;
	/** Gross price move, before the sale fee. */
	grossReturnPct: number;
}

/**
 * Path-realistic triple barrier.
 *
 * Enters at `entry`, which callers set to the next bar's open (plus delay), then
 * walks the forward candles in order:
 * - a bar that touches both barriers is resolved as the stop (conservative);
 * - a target or stop touch exits at the barrier price;
 * - otherwise the position times out at the final close.
 *
 * The sale fee is applied to the exit proceeds. Timeout is reported as its own
 * outcome with the real horizon return, never as a zero label/return.
 */
export function evaluateTripleBarrier(
	entry: number,
	forward: BarrierCandle[],
	targetPct: number,
	stopPct: number,
	saleFeePct = CAPITAL_SALE_FEE_PCT,
): BarrierResult {
	if (!(entry > 0) || !Number.isFinite(entry)) {
		throw new Error(`Barrier entry price must be positive; got ${entry}.`);
	}
	const target = entry * (1 + targetPct / 100);
	const stop = entry * (1 - stopPct / 100);
	let outcome: BarrierOutcome = "timeout";
	let exitPrice = forward.at(-1)?.close ?? entry;

	for (const candle of forward) {
		const high = Number.isFinite(candle.high)
			? candle.high
			: Number.isFinite(candle.close)
				? candle.close
				: entry;
		const low = Number.isFinite(candle.low)
			? candle.low
			: Number.isFinite(candle.close)
				? candle.close
				: entry;
		const hitTarget = high >= target;
		const hitStop = low <= stop;
		// Same-bar ambiguity: the engine's intrabar ordering is unknowable, so
		// assume the worse path.
		if (hitStop) {
			outcome = "stop";
			exitPrice = stop;
			break;
		}
		if (hitTarget) {
			outcome = "target";
			exitPrice = target;
			break;
		}
	}

	const grossReturnPct = (exitPrice / entry - 1) * 100;
	const netExitPrice = exitPrice * (1 - saleFeePct / 100);
	return {
		outcome,
		label: outcome === "target" ? 1 : 0,
		exitPrice,
		returnPct: (netExitPrice / entry - 1) * 100,
		grossReturnPct,
	};
}

export interface CorporateAction {
	/** Candle index the action takes effect on. */
	index: number;
	timestamp: number;
	/** Shares outstanding multiplier: >1 split, <1 reverse split/merge. */
	factor: number;
}

/**
 * Detects splits and merges from the shares-outstanding series.
 *
 * A split or merge moves shares and price in opposite directions by the same
 * ratio (shares x2, price /2). Ordinary issuance moves shares without the
 * inverse price move and is left alone: it is a valid flow feature, not a
 * corporate action.
 */
export function detectCorporateActions(
	candles: CapitalCandle[],
): CorporateAction[] {
	const actions: CorporateAction[] = [];
	// A real split/merge is a large, inverse share-count and price move. Torn
	// also sees ordinary 10–15% issuance with a flat price; that is a flow
	// feature, not a corporate action, so require a big move on both sides.
	const minimumSharesMove = 0.5;
	const minimumPriceMove = 0.25;
	const inverseTolerance = 0.05;
	for (let i = 1; i < candles.length; i++) {
		const previous = candles[i - 1];
		const current = candles[i];
		if (!previous || !current) continue;
		const previousShares = previous.shares;
		const shares = current.shares;
		if (
			previousShares === null ||
			previousShares === undefined ||
			shares === null ||
			shares === undefined ||
			!(previousShares > 0) ||
			!(shares > 0)
		) {
			continue;
		}
		const sharesRatio = shares / previousShares;
		if (Math.abs(sharesRatio - 1) < minimumSharesMove) continue;
		if (!(previous.close > 0) || !(current.open > 0)) continue;
		const priceRatio = current.open / previous.close;
		if (Math.abs(priceRatio - 1) < minimumPriceMove) continue;
		// Inverse move: sharesRatio * priceRatio stays near 1.
		if (Math.abs(sharesRatio * priceRatio - 1) > inverseTolerance) continue;
		actions.push({
			index: i,
			timestamp: current.timestamp,
			factor: sharesRatio,
		});
	}
	return actions;
}

/**
 * Re-bases a price/shares series onto the latest corporate-action basis so
 * features and barrier labels never straddle a fake split/merge return.
 *
 * Pre-action prices are divided by the cumulative action factor and shares are
 * multiplied by it, which also keeps shares-outstanding change features
 * continuous.
 */
export function adjustForCorporateActions<T extends CapitalCandle>(
	candles: T[],
): {
	candles: T[];
	actions: CorporateAction[];
} {
	const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
	const actions = detectCorporateActions(sorted);
	if (actions.length === 0) return { candles: sorted, actions };
	const byIndex = new Map(actions.map((action) => [action.index, action]));
	const factors = new Array<number>(sorted.length).fill(1);
	let cumulative = 1;
	for (let i = sorted.length - 1; i >= 0; i--) {
		factors[i] = cumulative;
		const action = byIndex.get(i);
		if (action) cumulative *= action.factor;
	}
	return {
		candles: sorted.map((candle, i) => {
			const factor = factors[i] ?? 1;
			const shares = candle.shares;
			return {
				...candle,
				open: candle.open / factor,
				high: candle.high / factor,
				low: candle.low / factor,
				close: candle.close / factor,
				shares:
					shares === null || shares === undefined
						? shares
						: Math.round(shares * factor),
			};
		}),
		actions,
	};
}
