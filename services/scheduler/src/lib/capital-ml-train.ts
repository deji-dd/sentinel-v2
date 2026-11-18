/**
 * Capital meta-label training.
 *
 * Shared by the `capital:ml:train` command and the `capital:ml:train` scheduler
 * worker (monthly retrain). Builds a rows-per-(day, stock) dataset from the
 * stored daily candles, keeps the production reversal candidates, labels them
 * with a fee/path-realistic triple barrier, and selects a model with a purged
 * expanding walk-forward. The final slice is an untouched holdout used once for
 * the gates. Every run is persisted in `capital_ml_runs` for reproducibility.
 */
import {
	capitalMarketCandles,
	db,
	getCapitalConfig,
	insertCapitalMlModel,
	insertCapitalMlRun,
} from "@sentinel/database";
import {
	adjustForCorporateActions,
	auc,
	backtestMetrics,
	type BarrierOutcome,
	blockSharpe,
	type BootstrapCI,
	bootstrapCI,
	brierScore,
	calibrationBuckets,
	CAPITAL_EXECUTION_DELAY_BPS,
	CAPITAL_ML_FEATURES,
	CAPITAL_ML_HORIZON_DAYS,
	CAPITAL_ML_LABEL_SPEC,
	CAPITAL_ML_RESEARCH_FEATURES,
	CAPITAL_ML_STOP_PCT,
	CAPITAL_ML_TARGET_PCT,
	CAPITAL_SALE_FEE_PCT,
	capitalMlFeatureVector,
	type CapitalMlResearchContext,
	capitalMlResearchFeatureVector,
	computeFeatures,
	deflatedSharpe,
	evaluateTripleBarrier,
	featureSpecHash,
	featureStats,
	fitLogistic,
	fitRidge,
	type LogisticModel,
	logLoss,
	predictProbability,
	predictRidge,
	probabilityOfBacktestOverfit,
	type RidgeModel,
	rSquared,
	scoreStock,
	standardise,
} from "@sentinel/utils";

export const TARGET_PCT = CAPITAL_ML_TARGET_PCT;
export const STOP_PCT = CAPITAL_ML_STOP_PCT;
export const HORIZON_DAYS = CAPITAL_ML_HORIZON_DAYS;
/**
 * The label proxies the live ladder's first decision: the +1R trim against the
 * frozen entry stop. v2 adds next-bar entry, daily high/low touches, stop-first
 * ambiguity, the 0.1% sale fee, and a distinct timeout outcome.
 */
export const LABEL_SPEC = CAPITAL_ML_LABEL_SPEC;
export const EMBARGO_DAYS = 25;
export const L2_GRID = [0.1, 0.5, 1, 2, 5] as const;
export const WALK_FORWARD_FOLDS = 5;
export const HOLDOUT_FRACTION = 0.2;
const MIN_HISTORY_DAYS = 300;
const MIN_CANDLES = 80;
const MIN_TRAIN_ROWS = 500;
const MIN_TEST_ROWS = 200;

/**
 * Pre-registered before the holdout is ever evaluated: features, label, model
 * family, search grid and the metrics used to judge the result. Changing any of
 * it requires a new registration, not a quiet edit after seeing the test slice.
 */
export const PREREGISTRATION = {
	features: [...CAPITAL_ML_FEATURES],
	labelSpec: LABEL_SPEC,
	modelFamily: "l2_logistic + platt",
	l2Grid: [...L2_GRID],
	folds: WALK_FORWARD_FOLDS,
	embargoDays: EMBARGO_DAYS,
	holdoutFraction: HOLDOUT_FRACTION,
	selectionMetric: "walk_forward_oos_auc",
	baselines: ["rule", "model", "reversal", "equal_weight", "buy_hold"],
	metrics: [
		"cagr",
		"sharpe",
		"sortino",
		"max_drawdown",
		"calmar",
		"hit_rate",
		"payoff",
		"turnover",
		"exposure",
		"brier",
		"log_loss",
	],
} as const;

export interface TrainOptions {
	activate?: boolean;
	l2?: number;
	minAuc?: number;
	force?: boolean;
	onProgress?: (line: string) => void;
}

export type BacktestSummary = ReturnType<typeof backtestMetrics>;

export interface BootstrapReport {
	cagr: BootstrapCI;
	sharpe: BootstrapCI;
	ruleCagr: BootstrapCI;
}

export interface UncertaintyReport {
	bootstrap: BootstrapReport;
	deflatedSharpe: number;
	deflatedSharpeTrials: number;
	pbo: Omit<ReturnType<typeof probabilityOfBacktestOverfit>, "pbo"> & {
		pbo: number | null;
	};
}

export interface FeatureIcReport {
	name: string;
	full: number;
	folds: number[];
	holdout: number;
}

export interface FoldBacktestReport {
	index: number;
	from: string;
	to: string;
	rule: BacktestSummary;
	model: BacktestSummary;
	reversal: BacktestSummary;
}

export interface OverlapReport {
	blocks: number;
	avgShared: number;
	sharedReturnPct: number;
	ruleOnlyReturnPct: number;
	modelOnlyReturnPct: number;
}

export interface VolatilityReport {
	/** R² of the vol20 persistence baseline on the holdout. */
	baselineRSquared: number;
	/** R² of the HAR (5/20/60) ridge on the holdout. */
	modelRSquared: number;
	foldRSquared: number[];
	equalWeight: BacktestSummary;
	volScaled: BacktestSummary;
	avgWeightSpread: number;
}

export interface DiagnosticsReport {
	featureIc: FeatureIcReport[];
	foldBacktests: FoldBacktestReport[];
	overlap: OverlapReport;
	volatility: VolatilityReport;
}

export interface CapitalMlTrainResult {
	rows: number;
	firstDate: Date;
	lastDate: Date;
	baseRate: number;
	/** train = rows before the holdout, validation = walk-forward OOS, test = holdout. */
	split: { train: number; validation: number; test: number };
	chosenL2: number;
	platt: { a: number; b: number };
	corporateActions: number;
	preregistration: { hash: string; family: string; selectionMetric: string };
	foldAucs: number[];
	diagnostics: DiagnosticsReport;
	metrics: {
		trainAuc: number;
		/** Holdout AUC. Retained name for the existing operator report. */
		testAuc: number;
		testBrier: number;
		testLogLoss: number;
		calibrationError: number;
		testBaseRate: number;
		correlationWithForwardReturn: number;
		ruleOnly: BacktestSummary;
		withModel: BacktestSummary;
		calibration: ReturnType<typeof calibrationBuckets>;
		outcomes: OutcomeCounts;
		testOutcomes: OutcomeCounts;
		oos: Evaluation;
		holdout: Evaluation;
		baselines: {
			rule: BacktestSummary;
			model: BacktestSummary;
			reversal: BacktestSummary;
			equalWeight: BacktestSummary;
			buyHold: BacktestSummary;
		};
		uncertainty: UncertaintyReport;
	};
	gates: { auc: boolean; calibration: boolean; beatsBaseRate: boolean };
	shadowSafe: boolean;
	activated: boolean;
	modelId: string | null;
	version: string | null;
	runId: string | null;
}

interface OutcomeCounts {
	target: number;
	stop: number;
	timeout: number;
}

export interface UniverseRow {
	stockId: number;
	date: number;
	forwardReturnPct: number;
	zscore20: number;
	ruleScore: number;
	eligible: boolean;
}

export interface DatasetRow extends UniverseRow {
	vector: number[];
	/** Research-only regime vector; never part of the deployed artifact. */
	researchVector: number[];
	/** Research-only HAR inputs: 5d/20d/60d realised vol, percent. */
	volVector: number[];
	/** Research-only forward 20d realised vol, percent. */
	forwardVolPct: number;
	label: 0 | 1;
	outcome: BarrierOutcome;
}

interface CorporateActionSummary {
	stockId: number;
	timestamp: number;
	factor: number;
}

export interface WalkFold {
	index: number;
	train: DatasetRow[];
	test: DatasetRow[];
	trainEnd: number;
	testStart: number;
	testEnd: number;
}

export interface WalkForwardSplit {
	folds: WalkFold[];
	oos: DatasetRow[];
	holdout: DatasetRow[];
	/** Segment edges plus the holdout start, as epoch ms. */
	boundaries: number[];
}

interface Evaluation {
	auc: number;
	brier: number;
	logLoss: number;
	baseRate: number;
	calibration: ReturnType<typeof calibrationBuckets>;
	probabilities: number[];
	labels: number[];
}

interface TrainingConfig {
	entrySigma: number;
	minEntryScore: number;
	minConfidence: number;
	signalMode: string;
}

function mean(values: number[]): number {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function std(values: number[]): number {
	if (values.length < 2) return 0;
	const m = mean(values);
	return Math.sqrt(
		values.reduce((sum, value) => sum + (value - m) ** 2, 0) /
			(values.length - 1),
	);
}

function realizedVolPct(closes: number[], end: number, window: number): number {
	if (end <= window) return 0;
	const returns: number[] = [];
	for (let i = end - window + 1; i <= end; i++) {
		const previous = closes[i - 1] ?? 0;
		const current = closes[i] ?? 0;
		if (previous > 0 && current > 0) returns.push(Math.log(current / previous));
	}
	return returns.length > 1 ? std(returns) * Math.sqrt(365) * 100 : 0;
}

function forwardVolatilityPct(
	closes: number[],
	start: number,
	horizon: number,
): number {
	const segment = closes.slice(start, start + horizon + 1);
	const returns: number[] = [];
	for (let i = 1; i < segment.length; i++) {
		const previous = segment[i - 1] ?? 0;
		const current = segment[i] ?? 0;
		if (previous > 0 && current > 0) returns.push(Math.log(current / previous));
	}
	return returns.length > 1 ? std(returns) * Math.sqrt(365) * 100 : 0;
}

function moments(values: number[]): { skew: number; kurtosis: number } {
	const n = values.length;
	if (n < 4) return { skew: 0, kurtosis: 3 };
	const m = mean(values);
	const sd = std(values);
	if (sd <= 0) return { skew: 0, kurtosis: 3 };
	let m3 = 0;
	let m4 = 0;
	for (const value of values) {
		const z = (value - m) / sd;
		m3 += z ** 3;
		m4 += z ** 4;
	}
	return { skew: m3 / n, kurtosis: m4 / n };
}

function outcomeCounts(rows: DatasetRow[]): OutcomeCounts {
	const counts: OutcomeCounts = { target: 0, stop: 0, timeout: 0 };
	for (const row of rows) counts[row.outcome] += 1;
	return counts;
}

export async function loadDataset(log: (line: string) => void): Promise<{
	rows: DatasetRow[];
	universeRows: UniverseRow[];
	priceSeries: Map<number, { date: number; close: number }[]>;
	firstDate: Date;
	lastDate: Date;
	corporateActions: CorporateActionSummary[];
	config: TrainingConfig;
}> {
	const config = await getCapitalConfig("live");
	const scoringConfig = {
		mode:
			config.signalMode === "momentum"
				? ("momentum" as const)
				: ("reversal" as const),
		minEntryScore: config.minEntryScore,
		maxRsi: config.maxRsi,
		overboughtSigma: config.overboughtSigma,
		reversalEntrySigma: config.reversalEntrySigma,
		reversalExitSigma: config.reversalExitSigma,
		maxVolatilityPct: config.maxVolatilityPct,
	};
	const candles = await db
		.select()
		.from(capitalMarketCandles)
		.orderBy(capitalMarketCandles.bucketStart);
	const byStock = new Map<number, typeof candles>();
	for (const row of candles) {
		if (row.intervalMinutes !== 1_440) continue;
		const list = byStock.get(row.stockId) ?? [];
		list.push(row);
		byStock.set(row.stockId, list);
	}
	if (byStock.size === 0) {
		throw new Error(
			"No daily candles. The scheduler's capital:history worker seeds them automatically.",
		);
	}

	const seriesByStock = new Map<
		number,
		ReturnType<typeof adjustForCorporateActions>["candles"]
	>();
	const corporateActions: CorporateActionSummary[] = [];
	for (const [stockId, list] of byStock) {
		const raw = list.map((row) => ({
			timestamp: row.bucketStart.getTime() / 1000,
			open: Number(row.open),
			high: Number(row.high),
			low: Number(row.low),
			close: Number(row.close),
			shares: row.shares ?? null,
		}));
		const adjusted = adjustForCorporateActions(raw);
		seriesByStock.set(stockId, adjusted.candles);
		for (const action of adjusted.actions) {
			corporateActions.push({
				stockId,
				timestamp: action.timestamp,
				factor: action.factor,
			});
		}
	}
	if (corporateActions.length > 0) {
		log(
			`  adjusted ${corporateActions.length} split/merge window(s) across ${new Set(corporateActions.map((action) => action.stockId)).size} stocks`,
		);
	}

	const d30ByDate = new Map<number, number[]>();
	const volByDate = new Map<number, number[]>();
	for (const list of seriesByStock.values()) {
		const closes = list.map((row) => Number(row.close));
		for (let d = 30; d < closes.length; d++) {
			const date = (list[d]?.timestamp ?? 0) as number;
			const values = d30ByDate.get(date) ?? [];
			values.push((closes[d] ?? 0) / (closes[d - 30] ?? 1) - 1);
			d30ByDate.set(date, values);
			const vols = volByDate.get(date) ?? [];
			vols.push(realizedVolPct(closes, d, 20));
			volByDate.set(date, vols);
		}
	}
	const medianD30ByDate = new Map<number, number>();
	const dispersionByDate = new Map<number, number>();
	const universeVolByDate = new Map<number, number>();
	for (const [date, values] of d30ByDate) {
		values.sort((a, b) => a - b);
		medianD30ByDate.set(date, values[Math.floor(values.length / 2)] ?? 0);
		dispersionByDate.set(date, std(values) * 100);
	}
	for (const [date, values] of volByDate) {
		const sorted = [...values].sort((a, b) => a - b);
		universeVolByDate.set(date, sorted[Math.floor(sorted.length / 2)] ?? 0);
	}

	const rows: DatasetRow[] = [];
	const universeRows: UniverseRow[] = [];
	const priceSeries = new Map<number, { date: number; close: number }[]>();
	let firstDate = new Date();
	let lastDate = new Date(0);
	let processed = 0;
	const delayMultiplier = 1 + CAPITAL_EXECUTION_DELAY_BPS / 10_000;
	for (const [stockId, series] of seriesByStock) {
		const closes = series.map((bar) => bar.close);
		priceSeries.set(
			stockId,
			series.map((bar) => ({ date: bar.timestamp * 1000, close: bar.close })),
		);
		for (let d = MIN_CANDLES; d + HORIZON_DAYS < series.length; d++) {
			const decisionBar = series[d];
			const entryBar = series[d + 1];
			if (!decisionBar || !entryBar) continue;
			if (!(entryBar.open > 0) || !(decisionBar.close > 0)) continue;
			const slice = series.slice(Math.max(0, d - MIN_HISTORY_DAYS), d + 1);
			const base = computeFeatures({
				stockId,
				price: decisionBar.close,
				candles: slice,
				regimeOn: true,
			});
			if (!base) continue;
			const features = {
				...base,
				regimeOn: (medianD30ByDate.get(decisionBar.timestamp) ?? 0) > 0,
			};
			const rule = scoreStock(features, scoringConfig);
			const forward = series.slice(d + 1, d + 1 + HORIZON_DAYS);
			if (forward.length < HORIZON_DAYS) continue;
			const entryPrice = entryBar.open * delayMultiplier;
			const barrier = evaluateTripleBarrier(
				entryPrice,
				forward,
				TARGET_PCT,
				STOP_PCT,
			);
			const date = decisionBar.timestamp * 1000;
			const universe: UniverseRow = {
				stockId,
				date,
				forwardReturnPct: barrier.returnPct,
				zscore20: features.zscore20,
				ruleScore: rule.score,
				eligible: rule.eligible,
			};
			universeRows.push(universe);
			if (rule.eligible) {
				const context: CapitalMlResearchContext = {
					dispersion30Pct: dispersionByDate.get(decisionBar.timestamp) ?? 0,
					medianD30Pct: (medianD30ByDate.get(decisionBar.timestamp) ?? 0) * 100,
					volDeltaPct:
						realizedVolPct(closes, d, 20) - realizedVolPct(closes, d, 60),
					universeVolPct: universeVolByDate.get(decisionBar.timestamp) ?? 0,
				};
				rows.push({
					...universe,
					vector: capitalMlFeatureVector(features),
					researchVector: capitalMlResearchFeatureVector(context),
					volVector: [
						realizedVolPct(closes, d, 5),
						realizedVolPct(closes, d, 20),
						realizedVolPct(closes, d, 60),
					],
					forwardVolPct: forwardVolatilityPct(closes, d + 1, HORIZON_DAYS),
					label: barrier.label,
					outcome: barrier.outcome,
				});
			}
			if (date < firstDate.getTime()) firstDate = new Date(date);
			if (date > lastDate.getTime()) lastDate = new Date(date);
		}
		processed++;
		if (processed % 10 === 0) {
			log(
				`  built ${rows.length.toLocaleString()} candidate rows (${processed}/${byStock.size} stocks)`,
			);
		}
	}
	universeRows.sort((a, b) => a.date - b.date);
	rows.sort((a, b) => a.date - b.date);
	return {
		rows,
		universeRows,
		priceSeries,
		firstDate,
		lastDate,
		corporateActions,
		config: {
			entrySigma: config.reversalEntrySigma,
			minEntryScore: config.minEntryScore,
			minConfidence: config.mlMinConfidence,
			signalMode: config.signalMode,
		},
	};
}

/**
 * Expanding walk-forward with one warm-up segment, five test segments and a
 * final untouched holdout. Each fold trains on everything before the segment,
 * skips a 25-day embargo, then tests inside the segment. The embargo is longer
 * than the 20-day label horizon, so training and test outcomes never overlap.
 */
export function walkForwardSplit(
	rows: DatasetRow[],
	folds = WALK_FORWARD_FOLDS,
	embargoDays = EMBARGO_DAYS,
	holdoutFraction = HOLDOUT_FRACTION,
): WalkForwardSplit {
	const dates = [...new Set(rows.map((row) => row.date))].sort((a, b) => a - b);
	const cutoff = Math.floor(dates.length * (1 - holdoutFraction));
	const calibrationDates = dates.slice(0, Math.max(folds + 2, cutoff));
	const edgeAt = (fraction: number): number =>
		calibrationDates[
			Math.min(
				calibrationDates.length - 1,
				Math.floor(calibrationDates.length * fraction),
			)
		] ?? 0;
	const edges = Array.from({ length: folds + 2 }, (_, i) =>
		edgeAt(i / (folds + 1)),
	);
	const embargo = embargoDays * 86_400_000;
	const holdoutStart = (edges[folds + 1] ?? 0) + embargo;
	const result: WalkFold[] = [];
	for (let i = 1; i <= folds; i++) {
		const trainEnd = edges[i] ?? 0;
		const testStart = trainEnd + embargo;
		const testEnd = (edges[i + 1] ?? 0) - embargo;
		result.push({
			index: i,
			trainEnd,
			testStart,
			testEnd,
			train: rows.filter((row) => row.date < trainEnd),
			test: rows.filter((row) => row.date >= testStart && row.date < testEnd),
		});
	}
	return {
		folds: result,
		oos: result.flatMap((fold) => fold.test),
		holdout: rows.filter((row) => row.date >= holdoutStart),
		boundaries: [...edges, holdoutStart],
	};
}

function evaluateProbabilities(
	probabilities: number[],
	labels: number[],
): Evaluation {
	return {
		auc: auc(probabilities, labels),
		brier: brierScore(probabilities, labels),
		logLoss: logLoss(probabilities, labels),
		baseRate: mean(labels),
		calibration: calibrationBuckets(probabilities, labels, 5),
		probabilities,
		labels,
	};
}

function evaluate(model: LogisticModel, rows: DatasetRow[]): Evaluation {
	return evaluateProbabilities(
		rows.map((row) => predictProbability(model, row.vector)),
		rows.map((row) => row.label),
	);
}

function plattProbability(
	probability: number,
	platt: { a: number; b: number },
): number {
	const clamped = Math.min(1 - 1e-6, Math.max(1e-6, probability));
	const logit = Math.log(clamped / (1 - clamped));
	const scaled = platt.a * logit + platt.b;
	return 1 / (1 + Math.exp(-scaled));
}

function calibrationError(
	calibration: ReturnType<typeof calibrationBuckets>,
): number {
	let weighted = 0;
	let total = 0;
	for (const bucket of calibration) {
		if (bucket.count === 0) continue;
		weighted +=
			Math.abs(bucket.meanProbability - bucket.observedRate) * bucket.count;
		total += bucket.count;
	}
	return total ? weighted / total : 0;
}

function fitFor(
	rows: DatasetRow[],
	l2: number,
): { model: LogisticModel; mean: number[]; std: number[] } {
	const stats = featureStats(rows.map((row) => row.vector));
	const scaled = standardise(
		rows.map((row) => row.vector),
		stats.mean,
		stats.std,
	);
	const { intercept, weights } = fitLogistic(
		scaled,
		rows.map((row) => row.label),
		{ l2 },
	);
	return {
		model: {
			intercept,
			weights,
			mean: stats.mean,
			std: stats.std,
			features: CAPITAL_ML_FEATURES,
			targetPct: TARGET_PCT,
			stopPct: STOP_PCT,
			horizonDays: HORIZON_DAYS,
			labelSpec: LABEL_SPEC,
		},
		mean: stats.mean,
		std: stats.std,
	};
}

function fitPlatt(
	probabilities: number[],
	labels: number[],
): { a: number; b: number } {
	const logits = probabilities.map((probability) => {
		const clamped = Math.min(1 - 1e-6, Math.max(1e-6, probability));
		return [Math.log(clamped / (1 - clamped))];
	});
	const fit = fitLogistic(logits, labels, { l2: 0, iterations: 50 });
	return { a: fit.weights[0] ?? 1, b: fit.intercept };
}

function rankIc(rows: DatasetRow[], model: LogisticModel): number {
	const xs = rows.map((row) => predictProbability(model, row.vector));
	const ys = rows.map((row) => row.forwardReturnPct);
	const mx = mean(xs);
	const my = mean(ys);
	let numerator = 0;
	let dx = 0;
	let dy = 0;
	for (let i = 0; i < xs.length; i++) {
		const a = (xs[i] ?? 0) - mx;
		const b = (ys[i] ?? 0) - my;
		numerator += a * b;
		dx += a * a;
		dy += b * b;
	}
	return dx && dy ? numerator / Math.sqrt(dx * dy) : 0;
}

function pearson(xs: number[], ys: number[]): number {
	const n = Math.min(xs.length, ys.length);
	if (n < 3) return 0;
	const mx = mean(xs.slice(0, n));
	const my = mean(ys.slice(0, n));
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

function vectorIc(rows: DatasetRow[], research: boolean): number[] {
	const width = research
		? (rows[0]?.researchVector.length ?? 0)
		: (rows[0]?.vector.length ?? 0);
	const target = rows.map((row) => row.forwardReturnPct);
	return Array.from({ length: width }, (_, index) =>
		pearson(
			rows.map((row) =>
				research ? (row.researchVector[index] ?? 0) : (row.vector[index] ?? 0),
			),
			target,
		),
	);
}

function featureIcReport(
	rows: DatasetRow[],
	folds: WalkFold[],
	holdout: DatasetRow[],
): FeatureIcReport[] {
	const names = [...CAPITAL_ML_FEATURES, ...CAPITAL_ML_RESEARCH_FEATURES];
	const ic = (sample: DatasetRow[]): number[] => [
		...vectorIc(sample, false),
		...vectorIc(sample, true),
	];
	const full = ic(rows);
	const test = ic(holdout);
	const perFold = folds.map((fold) => ic(fold.test));
	return names.map((name, index) => ({
		name,
		full: full[index] ?? 0,
		holdout: test[index] ?? 0,
		folds: perFold.map((values) => values[index] ?? 0),
	}));
}

function foldBacktestReports(
	folds: WalkFold[],
	universeRows: UniverseRow[],
	foldModels: LogisticModel[],
): FoldBacktestReport[] {
	return folds.map((fold, index) => {
		const scores = new Map<string, number>();
		const model = foldModels[index];
		if (model) {
			fold.test.forEach((row) => {
				scores.set(
					`${row.date}:${row.stockId}`,
					predictProbability(model, row.vector),
				);
			});
		}
		const dates = new Set(fold.test.map((row) => row.date));
		const universe = universeRows.filter((row) => dates.has(row.date));
		const candidates = universe.filter((row) => row.eligible);
		const rule = backtestMetrics(
			blockReturns(candidates, (row) => row.ruleScore, 5),
		);
		const withModel = backtestMetrics(
			blockReturns(
				candidates,
				(row) =>
					scores.get(`${row.date}:${row.stockId}`) ?? Number.NEGATIVE_INFINITY,
				5,
			),
		);
		const reversal = backtestMetrics(
			blockReturns(universe, (row) => -row.zscore20, 5),
		);
		return {
			index: fold.index,
			from: new Date(Math.min(...dates)).toISOString().slice(0, 10),
			to: new Date(Math.max(...dates)).toISOString().slice(0, 10),
			rule,
			model: withModel,
			reversal,
		};
	});
}

function overlapReport(
	holdout: DatasetRow[],
	universeRows: UniverseRow[],
	probabilityByKey: Map<string, number>,
): OverlapReport {
	const dates = [...new Set(holdout.map((row) => row.date))].sort(
		(a, b) => a - b,
	);
	const shared: number[] = [];
	const ruleOnly: number[] = [];
	const modelOnly: number[] = [];
	let blocks = 0;
	let sharedCount = 0;
	for (let i = 0; i < dates.length; i += HORIZON_DAYS) {
		const date = dates[i];
		if (date === undefined) continue;
		const candidates = universeRows.filter(
			(row) => row.date === date && row.eligible,
		);
		if (candidates.length === 0) continue;
		const byRule = [...candidates].sort((a, b) => b.ruleScore - a.ruleScore);
		const byModel = [...candidates].sort(
			(a, b) =>
				(probabilityByKey.get(`${b.date}:${b.stockId}`) ?? 0) -
				(probabilityByKey.get(`${a.date}:${a.stockId}`) ?? 0),
		);
		const rulePicks = byRule.slice(0, 5);
		const modelPicks = byModel.slice(0, 5);
		const ruleIds = new Set(rulePicks.map((row) => row.stockId));
		const modelIds = new Set(modelPicks.map((row) => row.stockId));
		for (const row of rulePicks) {
			if (modelIds.has(row.stockId)) shared.push(row.forwardReturnPct);
			else ruleOnly.push(row.forwardReturnPct);
		}
		for (const row of modelPicks) {
			if (!ruleIds.has(row.stockId)) modelOnly.push(row.forwardReturnPct);
		}
		sharedCount += [...ruleIds].filter((id) => modelIds.has(id)).length;
		blocks++;
	}
	return {
		blocks,
		avgShared: blocks ? sharedCount / blocks : 0,
		sharedReturnPct: mean(shared),
		ruleOnlyReturnPct: mean(ruleOnly),
		modelOnlyReturnPct: mean(modelOnly),
	};
}

function weightedBlockReturns(
	rows: UniverseRow[],
	volByKey: Map<string, number>,
	score: (row: UniverseRow) => number,
	topK: number,
	scoreFloor = Number.NEGATIVE_INFINITY,
): { returns: number[]; avgSpread: number } {
	const byDate = new Map<number, UniverseRow[]>();
	for (const row of rows) {
		const list = byDate.get(row.date) ?? [];
		list.push(row);
		byDate.set(row.date, list);
	}
	const dates = [...byDate.keys()].sort((a, b) => a - b);
	const returns: number[] = [];
	const spreads: number[] = [];
	for (let i = 0; i < dates.length; i += HORIZON_DAYS) {
		const date = dates[i];
		if (date === undefined) continue;
		const chosen = (byDate.get(date) ?? [])
			.filter((row) => score(row) >= scoreFloor)
			.sort((a, b) => score(b) - score(a))
			.slice(0, topK);
		if (chosen.length === 0) continue;
		const inverseVols = chosen.map(
			(row) =>
				1 / Math.max(5, volByKey.get(`${row.date}:${row.stockId}`) ?? 10),
		);
		const total = inverseVols.reduce((sum, value) => sum + value, 0);
		const weights = inverseVols.map((value) => value / total);
		returns.push(
			chosen.reduce(
				(sum, row, index) =>
					sum + (weights[index] ?? 0) * (row.forwardReturnPct / 100),
				0,
			),
		);
		spreads.push(Math.max(...weights) - Math.min(...weights));
	}
	return {
		returns,
		avgSpread: spreads.length ? mean(spreads) : 0,
	};
}

function volatilityReport(
	trainRows: DatasetRow[],
	holdout: DatasetRow[],
	universeRows: UniverseRow[],
	folds: WalkFold[],
	minEntryScore: number,
): VolatilityReport {
	// HAR is specified on log realised volatility, not the level: vol is
	// positive and multiplicative, and the level target is anti-persistent here.
	const logX = (row: DatasetRow): number[] =>
		row.volVector.map((value) => Math.log(Math.max(1e-9, value)));
	const x = (sample: DatasetRow[]): number[][] => sample.map(logX);
	const y = (sample: DatasetRow[]): number[] =>
		sample.map((row) => Math.log(Math.max(1e-9, row.forwardVolPct)));
	const foldRSquared = folds.map((fold) => {
		const model = fitRidge(x(fold.train), y(fold.train));
		return rSquared(
			y(fold.test),
			fold.test.map((row) => predictRidge(model, logX(row))),
		);
	});
	const har = fitRidge(x(trainRows), y(trainRows));
	const logPredicted = holdout.map((row) => predictRidge(har, logX(row)));
	const predicted = logPredicted.map((value) => Math.exp(value));
	const volByKey = new Map<string, number>();
	holdout.forEach((row, index) => {
		volByKey.set(`${row.date}:${row.stockId}`, predicted[index] ?? 10);
	});
	const holdoutDates = new Set(holdout.map((row) => row.date));
	const candidates = universeRows.filter(
		(row) => holdoutDates.has(row.date) && row.eligible,
	);
	const equalWeight = backtestMetrics(
		blockReturns(candidates, (row) => row.ruleScore, 5, minEntryScore),
	);
	const scaled = weightedBlockReturns(
		candidates,
		volByKey,
		(row) => row.ruleScore,
		5,
		minEntryScore,
	);
	return {
		baselineRSquared: rSquared(
			y(holdout),
			holdout.map((row) => Math.log(Math.max(1e-9, row.volVector[1] ?? 0))),
		),
		modelRSquared: rSquared(y(holdout), logPredicted),
		foldRSquared,
		equalWeight,
		volScaled: backtestMetrics(scaled.returns),
		avgWeightSpread: scaled.avgSpread,
	};
}

function blockReturns(
	rows: UniverseRow[],
	score: (row: UniverseRow) => number,
	topK: number,
	scoreFloor = Number.NEGATIVE_INFINITY,
): number[] {
	const byDate = new Map<number, UniverseRow[]>();
	for (const row of rows) {
		const list = byDate.get(row.date) ?? [];
		list.push(row);
		byDate.set(row.date, list);
	}
	const dates = [...byDate.keys()].sort((a, b) => a - b);
	const returns: number[] = [];
	for (let i = 0; i < dates.length; i += HORIZON_DAYS) {
		const date = dates[i];
		if (date === undefined) continue;
		const candidates = (byDate.get(date) ?? [])
			.filter((row) => score(row) >= scoreFloor)
			.sort((a, b) => score(b) - score(a))
			.slice(0, topK);
		if (candidates.length === 0) continue;
		returns.push(mean(candidates.map((row) => row.forwardReturnPct)) / 100);
	}
	return returns;
}

function buyAndHoldReturn(
	universe: UniverseRow[],
	priceSeries: Map<number, { date: number; close: number }[]>,
	minEntryScore: number,
	topK: number,
): number[] {
	if (universe.length === 0) return [];
	const first = Math.min(...universe.map((row) => row.date));
	const last = Math.max(...universe.map((row) => row.date));
	if (last <= first) return [];
	const firstBar = universe.filter((row) => row.date === first);
	const picks = [...firstBar]
		.filter((row) => row.ruleScore >= minEntryScore)
		.sort((a, b) => b.ruleScore - a.ruleScore)
		.slice(0, topK);
	if (picks.length === 0) return [];
	const returns: number[] = [];
	for (const pick of picks) {
		const series = priceSeries.get(pick.stockId) ?? [];
		const entry = series.find((bar) => bar.date >= first)?.close ?? 0;
		const exit =
			[...series].reverse().find((bar) => bar.date <= last)?.close ?? 0;
		if (entry > 0 && exit > 0) {
			returns.push(exit / entry - 1 - CAPITAL_SALE_FEE_PCT / 100);
		}
	}
	return returns.length ? [mean(returns)] : [];
}

export async function trainCapitalMlModel(
	options: TrainOptions = {},
): Promise<CapitalMlTrainResult> {
	const hash = featureSpecHash(CAPITAL_ML_FEATURES);
	if (
		hash !== featureSpecHash(PREREGISTRATION.features) ||
		LABEL_SPEC !== PREREGISTRATION.labelSpec
	) {
		throw new Error(
			"Feature/label spec differs from the pre-registered experiment; register a new run before evaluating.",
		);
	}
	const log = options.onProgress ?? (() => {});
	const minAuc = options.minAuc ?? 0.55;
	log("Building dataset from stored daily candles…");
	const {
		rows,
		universeRows,
		priceSeries,
		firstDate,
		lastDate,
		corporateActions,
		config,
	} = await loadDataset(log);
	const baseRate = mean(rows.map((row) => row.label));
	const outcomes = outcomeCounts(rows);
	log(
		`${rows.length.toLocaleString()} candidates (${config.signalMode}, entry z<=-${config.entrySigma}, score>=${config.minEntryScore}), ${firstDate.toISOString().slice(0, 10)}..${lastDate.toISOString().slice(0, 10)}, base hit rate ${(baseRate * 100).toFixed(1)}%`,
	);
	log(
		`outcomes: target ${outcomes.target.toLocaleString()}, stop ${outcomes.stop.toLocaleString()}, timeout ${outcomes.timeout.toLocaleString()}; ${corporateActions.length} split/merge adjustment(s)`,
	);

	const split = walkForwardSplit(rows);
	const preHoldout = rows.filter(
		(row) =>
			row.date < (split.boundaries.at(-1) ?? 0) - EMBARGO_DAYS * 86_400_000,
	);
	log(
		`walk-forward: ${split.folds.length} folds, ${EMBARGO_DAYS}d embargo, ${split.oos.length} OOS rows, ${split.holdout.length} untouched holdout rows`,
	);
	for (const fold of split.folds) {
		log(
			`  fold ${fold.index}: train ${fold.train.length}, test ${fold.test.length} (${new Date(fold.testStart).toISOString().slice(0, 10)}..${new Date(fold.testEnd).toISOString().slice(0, 10)})`,
		);
	}
	if (
		preHoldout.length < MIN_TRAIN_ROWS ||
		split.oos.length < MIN_TEST_ROWS ||
		split.holdout.length < MIN_TEST_ROWS
	) {
		throw new Error(
			"Not enough labelled rows for walk-forward training; waiting for more history.",
		);
	}

	// Select the l2 on walk-forward OOS only; the holdout stays untouched.
	let best: {
		l2: number;
		auc: number;
		foldAucs: number[];
		foldModels: LogisticModel[];
		predictions: DatasetRow[];
		probabilities: number[];
	} | null = null;
	for (const l2 of L2_GRID) {
		const predictions: DatasetRow[] = [];
		const probabilities: number[] = [];
		const perFoldAucs: number[] = [];
		const foldModels: LogisticModel[] = [];
		for (const fold of split.folds) {
			if (fold.train.length < MIN_TRAIN_ROWS) continue;
			const { model } = fitFor(fold.train, l2);
			foldModels.push(model);
			const foldProbabilities = fold.test.map((row) =>
				predictProbability(model, row.vector),
			);
			predictions.push(...fold.test);
			probabilities.push(...foldProbabilities);
			perFoldAucs.push(
				auc(
					foldProbabilities,
					fold.test.map((row) => row.label),
				),
			);
		}
		// Select on the mean of per-fold AUCs. Pooled AUC mixes models fitted on
		// different windows with different calibration scales and can be inflated.
		const meanFoldAuc = mean(perFoldAucs);
		const pooledBrier = brierScore(
			probabilities,
			predictions.map((row) => row.label),
		);
		log(
			`  l2=${l2}: mean fold AUC ${meanFoldAuc.toFixed(4)} (${perFoldAucs.map((value) => value.toFixed(3)).join(", ")}), pooled Brier ${pooledBrier.toFixed(4)}`,
		);
		if (!best || meanFoldAuc > best.auc) {
			best = {
				l2,
				auc: meanFoldAuc,
				foldAucs: perFoldAucs,
				foldModels,
				predictions,
				probabilities,
			};
		}
	}
	if (!best) throw new Error("Training failed.");
	const chosenL2 = options.l2 ?? best.l2;
	const final = fitFor(preHoldout, chosenL2);
	const model = final.model;
	// Platt is fitted on the fold models' true OOS probabilities, never on the
	// final model's in-sample scores.
	const platt = fitPlatt(
		best.probabilities,
		best.predictions.map((row) => row.label),
	);
	model.platt = platt;
	log(
		`Platt calibration (walk-forward OOS): a=${platt.a.toFixed(3)} b=${platt.b.toFixed(3)}`,
	);

	const trainEvaluation = evaluate(model, preHoldout);
	const oosEvaluation = evaluateProbabilities(
		best.probabilities.map((probability) =>
			plattProbability(probability, platt),
		),
		best.predictions.map((row) => row.label),
	);
	// First holdout evaluation. No parameter is tuned after this point.
	const holdoutEvaluation = evaluate(model, split.holdout);
	const calErr = calibrationError(holdoutEvaluation.calibration);
	const foldAucs =
		chosenL2 === best.l2
			? best.foldAucs
			: split.folds.map((fold) => {
					const { model: overrideModel } = fitFor(fold.train, chosenL2);
					return auc(
						fold.test.map((row) =>
							predictProbability(overrideModel, row.vector),
						),
						fold.test.map((row) => row.label),
					);
				});
	log(
		`chosen l2=${chosenL2}; fold AUCs ${foldAucs.map((value) => value.toFixed(3)).join(", ")}; train AUC ${trainEvaluation.auc.toFixed(4)}, OOS AUC ${oosEvaluation.auc.toFixed(4)}, holdout AUC ${holdoutEvaluation.auc.toFixed(4)}, holdout Brier ${holdoutEvaluation.brier.toFixed(4)}, calibration error ${calErr.toFixed(4)}, holdout base rate ${(holdoutEvaluation.baseRate * 100).toFixed(1)}%`,
	);

	const holdoutDates = new Set(split.holdout.map((row) => row.date));
	const holdoutUniverse = universeRows.filter((row) =>
		holdoutDates.has(row.date),
	);
	const probabilityByKey = new Map<string, number>();
	for (let i = 0; i < split.holdout.length; i++) {
		probabilityByKey.set(
			`${split.holdout[i]?.date}:${split.holdout[i]?.stockId}`,
			holdoutEvaluation.probabilities[i] ?? 0,
		);
	}
	const scoreProbability = (row: UniverseRow): number =>
		probabilityByKey.get(`${row.date}:${row.stockId}`) ??
		Number.NEGATIVE_INFINITY;

	const diagnostics: DiagnosticsReport = {
		featureIc: featureIcReport(rows, split.folds, split.holdout),
		foldBacktests: foldBacktestReports(
			split.folds,
			universeRows,
			best.foldModels,
		),
		overlap: overlapReport(split.holdout, universeRows, probabilityByKey),
		volatility: volatilityReport(
			preHoldout,
			split.holdout,
			universeRows,
			split.folds,
			config.minEntryScore,
		),
	};
	const vol = diagnostics.volatility;
	log(
		`Volatility research: HAR R² ${vol.modelRSquared.toFixed(3)} vs vol20 baseline ${vol.baselineRSquared.toFixed(3)}; vol-scaled sizing ${(vol.volScaled.cagr * 100).toFixed(1)}% CAGR vs equal-weight ${(vol.equalWeight.cagr * 100).toFixed(1)}%`,
	);
	const foldWins = diagnostics.foldBacktests.filter(
		(fold) => fold.model.cagr > fold.rule.cagr,
	).length;
	const topIc = [...diagnostics.featureIc]
		.sort((a, b) => Math.abs(b.holdout) - Math.abs(a.holdout))
		.slice(0, 4)
		.map((feature) => `${feature.name} ${feature.holdout.toFixed(3)}`)
		.join(", ");
	log(
		`Diagnostics: model beat rule in ${foldWins}/${diagnostics.foldBacktests.length} folds; holdout top |IC| ${topIc}; top-5 overlap ${diagnostics.overlap.avgShared.toFixed(1)}/5`,
	);

	let ruleReturns: number[];
	let modelReturns: number[];
	let reversalReturns: number[];
	let equalWeightReturns: number[];
	let buyHoldReturns: number[];
	{
		const ruleCandidates = holdoutUniverse.filter((row) => row.eligible);
		ruleReturns = blockReturns(
			ruleCandidates,
			(row) => row.ruleScore,
			5,
			config.minEntryScore,
		);
		// `ml_min_confidence` is an enable-time veto, not a ranking filter. The
		// comparison is top-5 among rule candidates, exactly like the rule arm.
		modelReturns = blockReturns(ruleCandidates, scoreProbability, 5);
		reversalReturns = blockReturns(holdoutUniverse, (row) => -row.zscore20, 5);
		equalWeightReturns = blockReturns(
			holdoutUniverse,
			() => 1,
			Math.max(1, new Set(holdoutUniverse.map((row) => row.stockId)).size),
		);
		buyHoldReturns = buyAndHoldReturn(
			holdoutUniverse,
			priceSeries,
			config.minEntryScore,
			5,
		);
	}
	const holdoutDays =
		holdoutUniverse.length > 0
			? (Math.max(...holdoutUniverse.map((row) => row.date)) -
					Math.min(...holdoutUniverse.map((row) => row.date))) /
				86_400_000
			: HORIZON_DAYS;
	const ruleOnly = backtestMetrics(ruleReturns);
	const withModel = backtestMetrics(modelReturns);
	const baselines = {
		rule: ruleOnly,
		model: withModel,
		reversal: backtestMetrics(reversalReturns),
		equalWeight: backtestMetrics(equalWeightReturns),
		buyHold: backtestMetrics(buyHoldReturns, Math.max(1, holdoutDays), 1),
	};
	const { skew, kurtosis } = moments(modelReturns);
	const uncertainty: UncertaintyReport = {
		bootstrap: {
			cagr: bootstrapCI(modelReturns, (sample) => backtestMetrics(sample).cagr),
			sharpe: bootstrapCI(
				modelReturns,
				(sample) => backtestMetrics(sample).sharpe,
			),
			ruleCagr: bootstrapCI(
				ruleReturns,
				(sample) => backtestMetrics(sample).cagr,
			),
		},
		deflatedSharpe: deflatedSharpe(
			blockSharpe(modelReturns),
			L2_GRID.length,
			modelReturns.length,
			skew,
			kurtosis,
		),
		deflatedSharpeTrials: L2_GRID.length,
		pbo: (() => {
			const result = probabilityOfBacktestOverfit(
				[ruleReturns, modelReturns, reversalReturns, equalWeightReturns],
				8,
			);
			return Number.isNaN(result.pbo) ? { ...result, pbo: null } : result;
		})(),
	};
	const ic = rankIc(split.holdout, model);
	log(
		`Holdout ${HORIZON_DAYS}d blocks: rule ${(ruleOnly.cagr * 100).toFixed(1)}% CAGR / Sharpe ${ruleOnly.sharpe.toFixed(2)} / MaxDD ${(ruleOnly.maxDrawdown * 100).toFixed(1)}%; model ${(withModel.cagr * 100).toFixed(1)}% / ${withModel.sharpe.toFixed(2)} / ${(withModel.maxDrawdown * 100).toFixed(1)}%; IC ${ic.toFixed(4)}`,
	);
	log(
		`Uncertainty: model CAGR 95% CI [${(uncertainty.bootstrap.cagr.lower * 100).toFixed(1)}%, ${(uncertainty.bootstrap.cagr.upper * 100).toFixed(1)}%], deflated Sharpe ${uncertainty.deflatedSharpe.toFixed(3)}, PBO ${uncertainty.pbo.pbo === null ? "n/a" : uncertainty.pbo.pbo.toFixed(3)} (${uncertainty.pbo.reliable ? "reliable" : "thin sample"})`,
	);

	const gates = {
		auc: holdoutEvaluation.auc >= minAuc,
		calibration: calErr <= 0.05,
		beatsBaseRate:
			holdoutEvaluation.brier <
			holdoutEvaluation.baseRate * (1 - holdoutEvaluation.baseRate),
	};
	const shadowSafe = gates.auc && gates.beatsBaseRate;
	log(
		`Gates (holdout): AUC ${gates.auc}, calibration ${gates.calibration}, beats base rate ${gates.beatsBaseRate}; shadow-safe ${shadowSafe}`,
	);

	const result: CapitalMlTrainResult = {
		rows: rows.length,
		firstDate,
		lastDate,
		baseRate,
		split: {
			train: preHoldout.length,
			validation: split.oos.length,
			test: split.holdout.length,
		},
		chosenL2,
		platt,
		corporateActions: corporateActions.length,
		preregistration: {
			hash,
			family: PREREGISTRATION.modelFamily,
			selectionMetric: PREREGISTRATION.selectionMetric,
		},
		foldAucs,
		diagnostics,
		metrics: {
			trainAuc: trainEvaluation.auc,
			testAuc: holdoutEvaluation.auc,
			testBrier: holdoutEvaluation.brier,
			testLogLoss: holdoutEvaluation.logLoss,
			calibrationError: calErr,
			testBaseRate: holdoutEvaluation.baseRate,
			correlationWithForwardReturn: ic,
			ruleOnly,
			withModel,
			calibration: holdoutEvaluation.calibration,
			outcomes,
			testOutcomes: outcomeCounts(split.holdout),
			oos: oosEvaluation,
			holdout: holdoutEvaluation,
			baselines,
			uncertainty,
		},
		gates,
		shadowSafe,
		activated: false,
		modelId: null,
		version: null,
		runId: null,
	};

	if (options.activate) {
		if (!shadowSafe && !options.force) {
			throw new Error(
				"Ranking gates failed; refusing to activate. Use --force to override.",
			);
		}
		const version = `meta_label_logistic@${new Date().toISOString()}`;
		const row = await insertCapitalMlModel(
			{
				version,
				kind: PREREGISTRATION.modelFamily,
				featureSpec: [...CAPITAL_ML_FEATURES],
				artifact: model as unknown as Record<string, unknown>,
				metrics: {
					l2: chosenL2,
					...result.metrics,
					platt,
					splits: result.split,
					foldAucs,
					baseRate,
					gates,
					preregistration: result.preregistration,
					candidateConfig: config,
				},
				dataStart: firstDate,
				dataEnd: lastDate,
				notes: `label ${LABEL_SPEC}: first +1R trim vs entry stop, target ${TARGET_PCT}% / stop ${STOP_PCT}% / ${HORIZON_DAYS}d; next-bar execution + ${CAPITAL_EXECUTION_DELAY_BPS}bps delay; daily high/low touches, stop-first; ${CAPITAL_SALE_FEE_PCT}% fee on sale only; candidates ${config.signalMode} z<=-${config.entrySigma}, score>=${config.minEntryScore}; walk-forward ${WALK_FORWARD_FOLDS} folds, embargo ${EMBARGO_DAYS}d, holdout ${HOLDOUT_FRACTION}`,
			},
			{ activate: true },
		);
		result.activated = true;
		result.modelId = row.id;
		result.version = version;
		log(
			`Activated model ${row.id} (${version})${gates.calibration ? "" : " for shadow logging only; calibration outside target"}.`,
		);
	}

	const run = await insertCapitalMlRun({
		featureSpecHash: hash,
		featureSpec: [...CAPITAL_ML_FEATURES],
		labelSpec: LABEL_SPEC,
		dataStart: firstDate,
		dataEnd: lastDate,
		rows: rows.length,
		folds: {
			count: split.folds.length,
			embargoDays: EMBARGO_DAYS,
			holdoutFraction: HOLDOUT_FRACTION,
			boundaries: split.boundaries.map((date) => new Date(date).toISOString()),
			sizes: split.folds.map((fold) => ({
				train: fold.train.length,
				test: fold.test.length,
			})),
			aucs: foldAucs,
		},
		hyperparameters: {
			l2Grid: [...L2_GRID],
			chosenL2,
			platt,
			modelFamily: PREREGISTRATION.modelFamily,
			selectionMetric: PREREGISTRATION.selectionMetric,
		},
		gates: { ...gates, shadowSafe },
		metrics: {
			trainAuc: result.metrics.trainAuc,
			oosAuc: oosEvaluation.auc,
			testAuc: result.metrics.testAuc,
			testBrier: result.metrics.testBrier,
			testLogLoss: result.metrics.testLogLoss,
			calibrationError: calErr,
			calibration: holdoutEvaluation.calibration,
			correlationWithForwardReturn: ic,
			diagnostics: diagnostics as unknown as Record<string, unknown>,
		},
		baselines: Object.fromEntries(
			Object.entries(baselines).map(([name, summary]) => [name, summary]),
		),
		uncertainty: uncertainty as unknown as Record<string, unknown>,
		modelId: result.modelId,
		activated: result.activated,
		notes: `pre-registered ${hash}; ${rows.length} candidates; outcomes ${outcomes.target}/${outcomes.stop}/${outcomes.timeout}`,
	});
	result.runId = run.id;
	log(`Recorded ML run ${run.id}.`);
	return result;
}
