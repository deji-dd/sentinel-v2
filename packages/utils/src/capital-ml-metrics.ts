/**
 * Out-of-sample evaluation primitives for the capital meta-label model.
 *
 * Everything here operates on *block returns* (one non-overlapping horizon
 * block per point), so the annualisation factor is derived from the horizon
 * rather than hard-coded. These are report-only statistics; no trading code
 * imports them.
 */
import {
	CAPITAL_ML_HORIZON_DAYS,
	featureStats,
	standardise,
} from "./capital-ml";

export interface BacktestMetrics {
	/** Number of non-overlapping horizon blocks. */
	blocks: number;
	totalReturn: number;
	cagr: number;
	/** Annualised Sharpe (mean / sample std × sqrt(periods per year)). */
	sharpe: number;
	/** Annualised Sortino, using downside deviation about zero. */
	sortino: number;
	maxDrawdown: number;
	/** CAGR / maxDrawdown; 0 when there is no drawdown. */
	calmar: number;
	hitRate: number;
	avgWin: number;
	avgLoss: number;
	/** Average win / average absolute loss; 0 without losses. */
	payoff: number;
	/** Annualised full portfolio rotations (one per block by default). */
	turnover: number;
	/** Fraction of blocks with a non-zero invested return. */
	exposure: number;
}

function meanOf(values: number[]): number {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function sampleStdOf(values: number[]): number {
	if (values.length < 2) return 0;
	const m = meanOf(values);
	return Math.sqrt(
		values.reduce((sum, value) => sum + (value - m) ** 2, 0) /
			(values.length - 1),
	);
}

/** Pearson correlation with a small-sample guard. */
export function pearsonCorrelation(xs: number[], ys: number[]): number {
	const n = Math.min(xs.length, ys.length);
	if (n < 3) return 0;
	const mx = meanOf(xs.slice(0, n));
	const my = meanOf(ys.slice(0, n));
	let numerator = 0;
	let dx = 0;
	let dy = 0;
	for (let i = 0; i < n; i++) {
		const a = (xs[i] ?? 0) - mx;
		const b = (ys[i] ?? 0) - my;
		numerator += a * b;
		dx += a * a;
		dy += b * b;
	}
	return dx && dy ? numerator / Math.sqrt(dx * dy) : 0;
}

/** Per-observation Sharpe, used by the statistical tests below. */
export function blockSharpe(returns: number[]): number {
	return sampleStdOf(returns) > 0 ? meanOf(returns) / sampleStdOf(returns) : 0;
}

export function backtestMetrics(
	returns: number[],
	horizonDays = CAPITAL_ML_HORIZON_DAYS,
	rotationsPerBlock = 1,
): BacktestMetrics {
	const n = returns.length;
	const empty: BacktestMetrics = {
		blocks: 0,
		totalReturn: 0,
		cagr: 0,
		sharpe: 0,
		sortino: 0,
		maxDrawdown: 0,
		calmar: 0,
		hitRate: 0,
		avgWin: 0,
		avgLoss: 0,
		payoff: 0,
		turnover: 0,
		exposure: 0,
	};
	if (n === 0) return empty;

	let nav = 1;
	let peak = 1;
	let maxDrawdown = 0;
	for (const value of returns) {
		nav *= 1 + value;
		peak = Math.max(peak, nav);
		maxDrawdown = Math.max(maxDrawdown, 1 - nav / peak);
	}
	const years = (n * horizonDays) / 365;
	const cagr = years > 0 && nav > 0 ? nav ** (1 / years) - 1 : 0;
	const annualisation = Math.sqrt(365 / horizonDays);
	const downside = Math.sqrt(meanOf(returns.map((r) => Math.min(0, r) ** 2)));
	const wins = returns.filter((r) => r > 0);
	const losses = returns.filter((r) => r < 0);
	const avgWin = meanOf(wins);
	const avgLoss = meanOf(losses);

	return {
		blocks: n,
		totalReturn: nav - 1,
		cagr,
		sharpe: blockSharpe(returns) * annualisation,
		sortino: downside > 0 ? (meanOf(returns) / downside) * annualisation : 0,
		maxDrawdown,
		calmar: maxDrawdown > 0 ? cagr / maxDrawdown : 0,
		hitRate: wins.length / n,
		avgWin,
		avgLoss,
		payoff: avgLoss < 0 ? avgWin / -avgLoss : 0,
		turnover: years > 0 ? (n * rotationsPerBlock) / years : 0,
		exposure: returns.filter((r) => r !== 0).length / n,
	};
}

export interface RidgeModel {
	intercept: number;
	weights: number[];
	mean: number[];
	std: number[];
}

function solveLinearSystem(A: number[][], b: number[]): number[] {
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

/** Small L2 linear regression, used for the research-only HAR volatility model. */
export function fitRidge(
	rows: number[][],
	labels: number[],
	l2 = 1,
): RidgeModel {
	const stats = featureStats(rows);
	const scaled = standardise(rows, stats.mean, stats.std);
	const width = scaled[0]?.length ?? 0;
	const X = scaled.map((row) => [1, ...row]);
	const H = Array.from({ length: width + 1 }, () =>
		new Array<number>(width + 1).fill(0),
	);
	const g = new Array<number>(width + 1).fill(0);
	for (let i = 0; i < X.length; i++) {
		const row = X[i] ?? [];
		const y = labels[i] ?? 0;
		for (let a = 0; a <= width; a++) {
			g[a] = (g[a] ?? 0) + (row[a] ?? 0) * y;
			for (let b = a; b <= width; b++) {
				H[a]![b] = (H[a]![b] ?? 0) + (row[a] ?? 0) * (row[b] ?? 0);
			}
		}
	}
	for (let a = 0; a <= width; a++) {
		for (let b = 0; b < a; b++) H[a]![b] = H[b]?.[a] ?? 0;
	}
	for (let a = 1; a <= width; a++) H[a]![a] = (H[a]![a] ?? 0) + l2;
	const beta = solveLinearSystem(H, g);
	return {
		intercept: beta[0] ?? 0,
		weights: beta.slice(1),
		mean: stats.mean,
		std: stats.std,
	};
}

export function predictRidge(model: RidgeModel, row: number[]): number {
	let value = model.intercept;
	for (let i = 0; i < model.weights.length; i++) {
		const mean = model.mean[i] ?? 0;
		const std = model.std[i] ?? 1;
		value +=
			(model.weights[i] ?? 0) * (std > 0 ? ((row[i] ?? 0) - mean) / std : 0);
	}
	return value;
}

export function rSquared(actual: number[], predicted: number[]): number {
	const n = Math.min(actual.length, predicted.length);
	if (n < 3) return 0;
	const meanActual = meanOf(actual.slice(0, n));
	let ssRes = 0;
	let ssTot = 0;
	for (let i = 0; i < n; i++) {
		const error = (actual[i] ?? 0) - (predicted[i] ?? 0);
		ssRes += error * error;
		const deviation = (actual[i] ?? 0) - meanActual;
		ssTot += deviation * deviation;
	}
	return ssTot > 0 ? 1 - ssRes / ssTot : 0;
}

export interface BootstrapCI {
	point: number;
	lower: number;
	upper: number;
	samples: number;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Percentile bootstrap CI for any statistic computed from block returns. */
export function bootstrapCI(
	values: number[],
	statistic: (sample: number[]) => number,
	iterations = 1000,
	seed = 42,
): BootstrapCI {
	const point = statistic(values);
	if (values.length < 2 || iterations < 1) {
		return { point, lower: point, upper: point, samples: 0 };
	}
	const random = mulberry32(seed);
	const draws: number[] = [];
	for (let iteration = 0; iteration < iterations; iteration++) {
		const sample = new Array<number>(values.length);
		for (let i = 0; i < values.length; i++) {
			sample[i] = values[Math.floor(random() * values.length)] ?? 0;
		}
		draws.push(statistic(sample));
	}
	draws.sort((a, b) => a - b);
	const lowIndex = Math.floor(iterations * 0.025);
	const highIndex = Math.min(iterations - 1, Math.ceil(iterations * 0.975));
	return {
		point,
		lower: draws[lowIndex] ?? point,
		upper: draws[highIndex] ?? point,
		samples: iterations,
	};
}

/** Abramowitz & Stegun 7.1.26; accurate to ~1.5e-7. */
function erf(x: number): number {
	const sign = x < 0 ? -1 : 1;
	const ax = Math.abs(x);
	const t = 1 / (1 + 0.3275911 * ax);
	const y =
		1 -
		((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
			t +
			0.254829592) *
			t *
			Math.exp(-ax * ax);
	return sign * y;
}

export function normalCdf(x: number): number {
	return 0.5 * (1 + erf(x / Math.SQRT2));
}

function normalQuantile(p: number): number {
	let low = -12;
	let high = 12;
	for (let i = 0; i < 80; i++) {
		const mid = (low + high) / 2;
		if (normalCdf(mid) < p) low = mid;
		else high = mid;
	}
	return (low + high) / 2;
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado), returned as a probability.
 *
 * `sharpe` must be the *per-block* Sharpe, not the annualised figure, and
 * `trials` is the number of configurations that were compared in selection.
 */
export function deflatedSharpe(
	sharpe: number,
	trials: number,
	observations: number,
	skew = 0,
	kurtosis = 3,
): number {
	if (trials < 1 || observations < 2) return 0;
	const gamma = 0.5772156649015329;
	const z1 = normalQuantile(1 - 1 / trials);
	const z2 = normalQuantile(1 - 1 / (trials * Math.E));
	const expectedMax = ((1 - gamma) * z1 + gamma * z2) / Math.sqrt(observations);
	const variance =
		(1 - sharpe * skew + ((sharpe * sharpe) / 6) * (kurtosis - 1)) /
		(observations - 1);
	const sd = Math.sqrt(Math.max(variance, 1e-12));
	return normalCdf((sharpe - expectedMax) / sd);
}

export interface PboResult {
	/** Probability that the IS-best strategy underperforms the median OOS. */
	pbo: number;
	combinations: number;
	slices: number;
	/** False when too few blocks exist for the estimate to mean anything. */
	reliable: boolean;
}

function combinationsOf<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	const current: T[] = [];
	const walk = (start: number): void => {
		if (current.length === size) {
			out.push([...current]);
			return;
		}
		for (let i = start; i <= items.length - (size - current.length); i++) {
			current.push(items[i] as T);
			walk(i + 1);
			current.pop();
		}
	};
	walk(0);
	return out;
}

/**
 * Combinatorially symmetric cross-validation probability of backtest overfitting.
 *
 * Rows are strategies, columns are consecutive period blocks. In each split,
 * half the slices are in-sample and half out-of-sample; PBO is how often the
 * IS-best strategy lands in the bottom half OOS.
 */
export function probabilityOfBacktestOverfit(
	returnsByStrategy: number[][],
	slices = 8,
): PboResult {
	const strategyCount = returnsByStrategy.length;
	const length = returnsByStrategy[0]?.length ?? 0;
	if (
		strategyCount < 2 ||
		length < slices ||
		slices < 2 ||
		slices % 2 !== 0 ||
		returnsByStrategy.some((row) => row.length !== length)
	) {
		return { pbo: Number.NaN, combinations: 0, slices, reliable: false };
	}
	const groups = new Array<number[]>(slices);
	for (let s = 0; s < slices; s++) {
		groups[s] = [];
		for (let i = 0; i < length; i++) {
			if (Math.floor((i * slices) / length) === s) {
				(groups[s] as number[]).push(i);
			}
		}
	}
	const indices = Array.from({ length: slices }, (_, i) => i);
	const splits = combinationsOf(indices, slices / 2);
	let underperform = 0;
	let evaluated = 0;
	for (const isGroups of splits) {
		const oosGroups = indices.filter((i) => !isGroups.includes(i));
		const isIndices = isGroups.flatMap((g) => groups[g] ?? []);
		const oosIndices = oosGroups.flatMap((g) => groups[g] ?? []);
		if (isIndices.length === 0 || oosIndices.length === 0) continue;
		const isScores = returnsByStrategy.map((row) =>
			blockSharpe(isIndices.map((i) => row[i] ?? 0)),
		);
		const oosScores = returnsByStrategy.map((row) =>
			blockSharpe(oosIndices.map((i) => row[i] ?? 0)),
		);
		const best = isScores.indexOf(Math.max(...isScores));
		const ranked = [...oosScores].sort((a, b) => a - b);
		const rank = ranked.indexOf(oosScores[best] ?? 0);
		if (rank < strategyCount / 2) underperform++;
		evaluated++;
	}
	return {
		pbo: evaluated ? underperform / evaluated : Number.NaN,
		combinations: evaluated,
		slices,
		reliable: evaluated >= 20 && length >= 40,
	};
}

/** Stable, dependency-free hash for a versioned feature list. */
export function featureSpecHash(features: readonly string[]): string {
	let hash = 2166136261;
	for (const feature of features) {
		for (let i = 0; i < feature.length; i++) {
			hash ^= feature.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		hash ^= 0x2c; // comma separator, matching the artifact's join(",")
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
