/**
 * Capital meta-label training.
 *
 * Shared by the `capital:ml:train` command and the `capital:ml:train` scheduler
 * worker (monthly retrain). Builds a rows-per-(day, stock) dataset from the
 * stored daily candles, keeps reversal candidates, labels them with a triple
 * barrier, fits an L2 logistic regression with a time-ordered split and
 * embargo, and activates the result for shadow logging if it clears the gates.
 */
import {
	capitalMarketCandles,
	db,
	getCapitalConfig,
	insertCapitalMlModel,
} from "@sentinel/database";
import {
	adjustForCorporateActions,
	auc,
	type BarrierOutcome,
	brierScore,
	calibrationBuckets,
	CAPITAL_EXECUTION_DELAY_BPS,
	CAPITAL_ML_FEATURES,
	CAPITAL_ML_HORIZON_DAYS,
	CAPITAL_ML_LABEL_SPEC,
	CAPITAL_ML_STOP_PCT,
	CAPITAL_ML_TARGET_PCT,
	CAPITAL_SALE_FEE_PCT,
	capitalMlFeatureVector,
	computeFeatures,
	evaluateTripleBarrier,
	featureStats,
	fitLogistic,
	type LogisticModel,
	logLoss,
	predictProbability,
	scoreStock,
	standardise,
} from "@sentinel/utils";

export const TARGET_PCT = CAPITAL_ML_TARGET_PCT;
export const STOP_PCT = CAPITAL_ML_STOP_PCT;
export const HORIZON_DAYS = CAPITAL_ML_HORIZON_DAYS;
/**
 * The label is a proxy for the live ladder's *first* decision: the +1R trim
 * against the frozen entry stop. With a 2% stop, +1R is +2%. v2 adds the live
 * engine's execution and cost assumptions: next-bar entry, daily high/low
 * touches, stop-first on same-bar ambiguity, the 0.1% sale fee, and a distinct
 * timeout outcome.
 */
export const LABEL_SPEC = CAPITAL_ML_LABEL_SPEC;
export const EMBARGO_DAYS = 25;
const MIN_HISTORY_DAYS = 300;
const MIN_CANDLES = 80;
const MIN_TRAIN_ROWS = 500;
const MIN_TEST_ROWS = 200;

export interface TrainOptions {
	activate?: boolean;
	l2?: number;
	minAuc?: number;
	force?: boolean;
	onProgress?: (line: string) => void;
}

export interface BacktestSummary {
	blocks: number;
	cagr: number;
	sharpe: number;
	maxDrawdown: number;
	avgForward: number;
}

export interface CapitalMlTrainResult {
	rows: number;
	firstDate: Date;
	lastDate: Date;
	baseRate: number;
	split: { train: number; validation: number; test: number };
	chosenL2: number;
	platt: { a: number; b: number };
	corporateActions: number;
	metrics: {
		trainAuc: number;
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
	};
	gates: { auc: boolean; calibration: boolean; beatsBaseRate: boolean };
	shadowSafe: boolean;
	activated: boolean;
	modelId: string | null;
	version: string | null;
}

interface OutcomeCounts {
	target: number;
	stop: number;
	timeout: number;
}

interface DatasetRow {
	stockId: number;
	date: number;
	vector: number[];
	label: 0 | 1;
	outcome: BarrierOutcome;
	forwardReturnPct: number;
	ruleScore: number;
}

interface CorporateActionSummary {
	stockId: number;
	timestamp: number;
	factor: number;
}

interface Split {
	train: DatasetRow[];
	validation: DatasetRow[];
	test: DatasetRow[];
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
	if (values.length < 2) return 0;
	const m = mean(values);
	return Math.sqrt(
		values.reduce((sum, value) => sum + (value - m) ** 2, 0) /
			(values.length - 1),
	);
}

export async function loadDataset(log: (line: string) => void): Promise<{
	rows: DatasetRow[];
	firstDate: Date;
	lastDate: Date;
	corporateActions: CorporateActionSummary[];
	config: { entrySigma: number; minEntryScore: number; signalMode: string };
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

	// Re-base every series first: splits/merges would otherwise appear as fake
	// returns in features, volatility and the forward barrier labels.
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

	// Market regime per date: median 30-day return across stocks.
	const d30ByDate = new Map<number, number[]>();
	for (const list of seriesByStock.values()) {
		const closes = list.map((row) => Number(row.close));
		for (let d = 30; d < closes.length; d++) {
			const date = (list[d]?.timestamp ?? 0) as number;
			const list30 = d30ByDate.get(date) ?? [];
			list30.push((closes[d] ?? 0) / (closes[d - 30] ?? 1) - 1);
			d30ByDate.set(date, list30);
		}
	}
	const medianD30ByDate = new Map<number, number>();
	for (const [date, values] of d30ByDate) {
		values.sort((a, b) => a - b);
		medianD30ByDate.set(date, values[Math.floor(values.length / 2)] ?? 0);
	}

	const rows: DatasetRow[] = [];
	let firstDate = new Date();
	let lastDate = new Date(0);
	let processed = 0;
	const delayMultiplier = 1 + CAPITAL_EXECUTION_DELAY_BPS / 10_000;
	for (const [stockId, series] of seriesByStock) {
		for (let d = MIN_CANDLES; d + HORIZON_DAYS < series.length; d++) {
			const decisionBar = series[d];
			const entryBar = series[d + 1];
			if (!decisionBar || !entryBar) continue;
			// Features stop at the decision close. Execution is the next bar's
			// open plus the manual 1–5 minute delay cost; never the same close.
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
			// Mirror the live book's candidate filters exactly (entry sigma, RSI,
			// volatility, drawdown and score floor) instead of a training-only set.
			const rule = scoreStock(features, scoringConfig);
			if (!rule.eligible) continue;

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
			rows.push({
				stockId,
				date,
				vector: capitalMlFeatureVector(features),
				label: barrier.label,
				outcome: barrier.outcome,
				forwardReturnPct: barrier.returnPct,
				ruleScore: rule.score,
			});
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
	rows.sort((a, b) => a.date - b.date);
	return {
		rows,
		firstDate,
		lastDate,
		corporateActions,
		config: {
			entrySigma: config.reversalEntrySigma,
			minEntryScore: config.minEntryScore,
			signalMode: config.signalMode,
		},
	};
}

function timeSplit(rows: DatasetRow[]): Split {
	const dates = rows.map((row) => row.date).sort((a, b) => a - b);
	const q60 = dates[Math.floor(dates.length * 0.6)] ?? 0;
	const q80 = dates[Math.floor(dates.length * 0.8)] ?? 0;
	const embargo = EMBARGO_DAYS * 86_400_000;
	return {
		train: rows.filter((row) => row.date < q60 - embargo),
		validation: rows.filter(
			(row) => row.date >= q60 + embargo && row.date < q80 - embargo,
		),
		test: rows.filter((row) => row.date >= q80 + embargo),
	};
}

function evaluate(model: LogisticModel, rows: DatasetRow[]) {
	const probabilities = rows.map((row) =>
		predictProbability(model, row.vector),
	);
	const labels = rows.map((row) => row.label);
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

function backtest(
	rows: DatasetRow[],
	score: (row: DatasetRow) => number,
	topK: number,
): BacktestSummary {
	const byDate = new Map<number, DatasetRow[]>();
	for (const row of rows) {
		const list = byDate.get(row.date) ?? [];
		list.push(row);
		byDate.set(row.date, list);
	}
	const dates = [...byDate.keys()].sort((a, b) => a - b);
	const returns: number[] = [];
	let nav = 1;
	let peak = 1;
	let maxDrawdown = 0;
	// Non-overlapping horizon blocks: take the top-k names each block.
	for (let i = 0; i < dates.length; i += HORIZON_DAYS) {
		const date = dates[i];
		if (date === undefined) continue;
		const candidates = byDate.get(date) ?? [];
		candidates.sort((a, b) => score(b) - score(a));
		const chosen = candidates.slice(0, topK);
		if (chosen.length === 0) continue;
		// `forwardReturnPct` is already net of the 0.1% sale fee on every row.
		const net = mean(chosen.map((row) => row.forwardReturnPct)) / 100;
		returns.push(net);
		nav *= 1 + net;
		peak = Math.max(peak, nav);
		maxDrawdown = Math.max(maxDrawdown, 1 - nav / peak);
	}
	const years = (returns.length * HORIZON_DAYS) / 365;
	return {
		blocks: returns.length,
		cagr: years > 0 ? nav ** (1 / years) - 1 : 0,
		sharpe:
			returns.length > 1
				? (mean(returns) / std(returns)) * Math.sqrt(365 / HORIZON_DAYS)
				: 0,
		maxDrawdown,
		avgForward: mean(rows.map((row) => row.forwardReturnPct)),
	};
}

function outcomeCounts(rows: DatasetRow[]): OutcomeCounts {
	const counts: OutcomeCounts = { target: 0, stop: 0, timeout: 0 };
	for (const row of rows) counts[row.outcome] += 1;
	return counts;
}

export async function trainCapitalMlModel(
	options: TrainOptions = {},
): Promise<CapitalMlTrainResult> {
	const log = options.onProgress ?? (() => {});
	const minAuc = options.minAuc ?? 0.55;
	log("Building dataset from stored daily candles…");
	const { rows, firstDate, lastDate, corporateActions, config } =
		await loadDataset(log);
	const baseRate = mean(rows.map((row) => row.label));
	const outcomes = outcomeCounts(rows);
	log(
		`${rows.length.toLocaleString()} candidates (${config.signalMode}, entry z<=-${config.entrySigma}, score>=${config.minEntryScore}), ${firstDate.toISOString().slice(0, 10)}..${lastDate.toISOString().slice(0, 10)}, base hit rate ${(baseRate * 100).toFixed(1)}%`,
	);
	log(
		`outcomes: target ${outcomes.target.toLocaleString()}, stop ${outcomes.stop.toLocaleString()}, timeout ${outcomes.timeout.toLocaleString()}; ${corporateActions.length} split/merge adjustment(s)`,
	);

	const { train, validation, test } = timeSplit(rows);
	log(
		`split: train ${train.length}, validation ${validation.length}, test ${test.length} (embargo ${EMBARGO_DAYS}d)`,
	);
	if (train.length < MIN_TRAIN_ROWS || test.length < MIN_TEST_ROWS) {
		throw new Error(
			"Not enough labelled rows to train; waiting for more history.",
		);
	}

	const { mean: featureMean, std: featureStd } = featureStats(
		train.map((row) => row.vector),
	);
	const scaledTrain = standardise(
		train.map((row) => row.vector),
		featureMean,
		featureStd,
	);
	const labelsTrain = train.map((row) => row.label);

	let best: {
		l2: number;
		model: LogisticModel;
		val: ReturnType<typeof evaluate>;
	} | null = null;
	for (const l2 of [0.1, 0.5, 1, 2, 5]) {
		const { intercept, weights } = fitLogistic(scaledTrain, labelsTrain, {
			l2,
		});
		const model: LogisticModel = {
			intercept,
			weights,
			mean: featureMean,
			std: featureStd,
			features: CAPITAL_ML_FEATURES,
			targetPct: TARGET_PCT,
			stopPct: STOP_PCT,
			horizonDays: HORIZON_DAYS,
			labelSpec: LABEL_SPEC,
		};
		const val = evaluate(model, validation);
		log(
			`  l2=${l2}: val AUC ${val.auc.toFixed(4)}, Brier ${val.brier.toFixed(4)}, logLoss ${val.logLoss.toFixed(4)}`,
		);
		if (!best || val.auc > best.val.auc) best = { l2, model, val };
	}
	if (!best) throw new Error("Training failed.");

	const model = best.model;

	// Platt calibration on validation: the base rate drifts between periods, so
	// the raw scores rank well but are not trustworthy as absolutes.
	const valProbabilities = validation.map((row) =>
		predictProbability(model, row.vector),
	);
	const valLogits = valProbabilities.map((p) => {
		const clamped = Math.min(1 - 1e-6, Math.max(1e-6, p));
		return [Math.log(clamped / (1 - clamped))];
	});
	const plattFit = fitLogistic(
		valLogits,
		validation.map((row) => row.label),
		{ l2: 0, iterations: 50 },
	);
	const platt = { a: plattFit.weights[0] ?? 1, b: plattFit.intercept };
	model.platt = platt;
	log(`Platt calibration: a=${platt.a.toFixed(3)} b=${platt.b.toFixed(3)}`);

	const trainMetrics = evaluate(model, train);
	const testMetrics = evaluate(model, test);
	const calErr = calibrationError(testMetrics.calibration);
	log(
		`Chosen l2=${best.l2}; train AUC ${trainMetrics.auc.toFixed(4)}, test AUC ${testMetrics.auc.toFixed(4)}, test Brier ${testMetrics.brier.toFixed(4)}, test logLoss ${testMetrics.logLoss.toFixed(4)}, calibration error ${calErr.toFixed(4)}, test base rate ${(testMetrics.baseRate * 100).toFixed(1)}%`,
	);

	const testScores = test.map((row) => predictProbability(model, row.vector));
	const scoreMap = new Map(test.map((row, i) => [row, testScores[i] ?? 0]));
	const ruleCandidates = test.filter((row) => row.ruleScore >= 65);
	const ruleOnly = backtest(ruleCandidates, (row) => row.ruleScore, 5);
	const withModel = backtest(
		ruleCandidates,
		(row) => scoreMap.get(row) ?? 0,
		5,
	);
	const rankIc = (() => {
		const xs = test.map((row) => scoreMap.get(row) ?? 0);
		const ys = test.map((row) => row.forwardReturnPct);
		const meanX = mean(xs);
		const meanY = mean(ys);
		let num = 0;
		let dx = 0;
		let dy = 0;
		for (let i = 0; i < xs.length; i++) {
			const a = (xs[i] ?? 0) - meanX;
			const b = (ys[i] ?? 0) - meanY;
			num += a * b;
			dx += a * a;
			dy += b * b;
		}
		return dx && dy ? num / Math.sqrt(dx * dy) : 0;
	})();
	log(
		`Test 20d blocks: rule CAGR ${(ruleOnly.cagr * 100).toFixed(1)}%, model CAGR ${(withModel.cagr * 100).toFixed(1)}%, correlation(p, forward20) ${rankIc.toFixed(4)}`,
	);

	const gates = {
		auc: testMetrics.auc >= minAuc,
		calibration: calErr <= 0.05,
		beatsBaseRate: testMetrics.brier < baseRate * (1 - baseRate),
	};
	// Shadow activation only needs ranking skill: predictions are logged and do
	// not touch orders. `ml_enabled` is a separate operator decision.
	const shadowSafe = gates.auc && gates.beatsBaseRate;
	log(
		`Gates: AUC ${gates.auc}, calibration ${gates.calibration}, beats base rate ${gates.beatsBaseRate}; shadow-safe ${shadowSafe}`,
	);

	const result: CapitalMlTrainResult = {
		rows: rows.length,
		firstDate,
		lastDate,
		baseRate,
		split: {
			train: train.length,
			validation: validation.length,
			test: test.length,
		},
		chosenL2: best.l2,
		platt,
		corporateActions: corporateActions.length,
		metrics: {
			trainAuc: trainMetrics.auc,
			testAuc: testMetrics.auc,
			testBrier: testMetrics.brier,
			testLogLoss: testMetrics.logLoss,
			calibrationError: calErr,
			testBaseRate: testMetrics.baseRate,
			correlationWithForwardReturn: rankIc,
			ruleOnly,
			withModel,
			calibration: testMetrics.calibration,
			outcomes,
			testOutcomes: outcomeCounts(test),
		},
		gates,
		shadowSafe,
		activated: false,
		modelId: null,
		version: null,
	};

	if (!options.activate) return result;
	if (!shadowSafe && !options.force) {
		throw new Error(
			"Ranking gates failed; refusing to activate. Use --force to override.",
		);
	}

	const version = `meta_label_logistic@${new Date().toISOString()}`;
	const row = await insertCapitalMlModel(
		{
			version,
			kind: "meta_label_logistic",
			featureSpec: [...CAPITAL_ML_FEATURES],
			artifact: model as unknown as Record<string, unknown>,
			metrics: {
				l2: best.l2,
				...result.metrics,
				platt,
				splits: result.split,
				baseRate,
				gates,
				candidateConfig: config,
			},
			dataStart: firstDate,
			dataEnd: lastDate,
			notes: `label ${LABEL_SPEC}: first +1R trim vs entry stop, target ${TARGET_PCT}% / stop ${STOP_PCT}% / ${HORIZON_DAYS}d; next-bar execution + ${CAPITAL_EXECUTION_DELAY_BPS}bps delay; daily high/low touches, stop-first; ${CAPITAL_SALE_FEE_PCT}% fee on sale only; candidates ${config.signalMode} z<=-${config.entrySigma}, score>=${config.minEntryScore}`,
		},
		{ activate: true },
	);
	result.activated = true;
	result.modelId = row.id;
	result.version = version;
	log(
		`Activated model ${row.id} (${version})${gates.calibration ? "" : " for shadow logging only; calibration outside target"}.`,
	);
	return result;
}
