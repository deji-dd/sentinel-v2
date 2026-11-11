import {
	and,
	applyCapitalFill,
	capitalBookConfigs,
	capitalEngineRuns,
	capitalFills,
	capitalInvestments,
	capitalMarketCandles,
	capitalMarketLatest,
	capitalOrders,
	capitalPositions,
	capitalTransactions,
	db,
	ensureCapitalBooks,
	eq,
	getActiveCapitalMlModel,
	getCapitalConfig,
	getCapitalInvestments,
	getCapitalOrders,
	getCapitalState,
	getWorkerState,
	gte,
	insertCapitalMlPrediction,
	resetCapitalPaperBook,
	setWorkerInitFlag,
	sql,
	upsertWorkerState,
	withCapitalTransaction,
	WORKER_STATE_IDS,
} from "@sentinel/database";
import type {
	CapitalAlertPayload,
	CapitalBook,
	TornSchema,
} from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
import {
	CAPITAL_ML_FEATURES,
	type CapitalCandle,
	type CapitalExitDecision,
	capitalMlFeatureVector,
	type CapitalScoringConfig,
	type CapitalSignalMode,
	type CapitalSignalScore,
	type CapitalStockFeatures,
	computeFeatures,
	computeInvestorMetrics,
	computeMarketRegime,
	computeNav,
	daysBetween,
	evaluateExit,
	floorToUtcBucket,
	formatMoney,
	Logger,
	type LogisticModel,
	maxMoney,
	moneyFromPriceShares,
	moneyToNumber,
	mulBps,
	mulPct,
	parseMoney,
	parseUnits,
	planEntry,
	predictProbability,
	scoreStock,
} from "@sentinel/utils";

import { getActiveIpcServer } from "../../lib/ipc/server";
import { mapWithPool, requestWithPool } from "../../lib/pool-key-request";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "capital:engine";
const logger = new Logger("Scheduler", "CapitalEngine");

type TornStockWire = TornSchema<"TornStock">;
type TornStockDetailedWire = TornSchema<"TornStockDetailed">;

interface MarketStock {
	id: number;
	acronym: string;
	name: string;
	price: number;
	cap: number;
	shares: number;
	investors: number;
	history: Array<{ timestamp: number; price: number }>;
	performance: Record<string, unknown>;
}

interface EngineRunResult {
	stocksPolled: number;
	stocksScored: number;
	recommendations: number;
	paperFills: number;
	dataAgeSeconds: number | null;
	errors: string[];
}

function toNumber(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function readStocks(payload: unknown): TornStockWire[] {
	if (!payload || typeof payload !== "object") return [];
	const stocks = (payload as { stocks?: unknown }).stocks;
	return Array.isArray(stocks) ? (stocks as TornStockWire[]) : [];
}

function readDetailed(payload: unknown): TornStockDetailedWire | null {
	if (!payload || typeof payload !== "object") return null;
	const stocks = (payload as { stocks?: unknown }).stocks;
	if (!stocks || typeof stocks !== "object" || Array.isArray(stocks))
		return null;
	return stocks as TornStockDetailedWire;
}

async function recordCandle(
	stock: { id: number; shares: number; investors: number },
	price: number,
	at: Date,
	intervalMinutes: number,
): Promise<void> {
	const bucket = floorToUtcBucket(at, intervalMinutes);
	const priceString = String(price);
	await db
		.insert(capitalMarketCandles)
		.values({
			stockId: stock.id,
			intervalMinutes,
			bucketStart: bucket,
			open: priceString,
			high: priceString,
			low: priceString,
			close: priceString,
			shares: stock.shares,
			investors: stock.investors,
			samples: 1,
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [
				capitalMarketCandles.stockId,
				capitalMarketCandles.intervalMinutes,
				capitalMarketCandles.bucketStart,
			],
			set: {
				high: sql`GREATEST(${capitalMarketCandles.high}, ${priceString}::numeric)`,
				low: sql`LEAST(${capitalMarketCandles.low}, ${priceString}::numeric)`,
				close: priceString,
				shares: stock.shares,
				investors: stock.investors,
				samples: sql`${capitalMarketCandles.samples} + 1`,
				updatedAt: new Date(),
			},
		});
}

/**
 * Polls `/torn/stocks`, updates the latest snapshot and the OHLC candles.
 *
 * One call returns every tradable stock; the per-stock detail endpoint is only
 * used to seed history/performance, never for the price every minute.
 */
async function fetchMarket(): Promise<MarketStock[]> {
	const payload = await requestWithPool("/torn/stocks", (key) =>
		tornApi.get("/torn/stocks", { apiKey: key.apiKey, userId: key.userId }),
	);
	const stocks = readStocks(payload);
	const now = new Date();
	const market: MarketStock[] = [];

	for (const stock of stocks) {
		const price = toNumber(stock.market?.price);
		if (price <= 0) continue;
		const shares = Math.trunc(toNumber(stock.market?.shares));
		const investors = Math.trunc(toNumber(stock.market?.investors));
		const cap = toNumber(stock.market?.cap);
		market.push({
			id: stock.id,
			acronym: stock.acronym,
			name: stock.name,
			price,
			cap,
			shares,
			investors,
			history: [],
			performance: {},
		});

		await db
			.insert(capitalMarketLatest)
			.values({
				stockId: stock.id,
				price: String(price),
				cap: String(cap),
				shares,
				investors,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: capitalMarketLatest.stockId,
				set: {
					price: String(price),
					cap: String(cap),
					shares,
					investors,
					updatedAt: now,
				},
			});

		await recordCandle({ id: stock.id, shares, investors }, price, now, 1);
		await recordCandle({ id: stock.id, shares, investors }, price, now, 5);
		await recordCandle({ id: stock.id, shares, investors }, price, now, 60);
	}

	return market;
}

/** Seeds the one-minute detail history into 5m/60m candles on first run. */
async function bootstrapDetailHistory(market: MarketStock[]): Promise<void> {
	const results = await mapWithPool(
		market,
		"/torn/{stockId}/stocks",
		async (stock, key) => {
			const payload = await tornApi.get("/torn/{stockId}/stocks", {
				apiKey: key.apiKey,
				userId: key.userId,
				pathParams: { stockId: stock.id },
			});
			return readDetailed(payload);
		},
		{
			onError: (item, error) => {
				const stock = item as MarketStock;
				logger.warn(
					`Detail seed failed for ${stock.acronym}: ${error instanceof Error ? error.message : String(error)}`,
				);
			},
		},
	);

	for (let i = 0; i < results.length; i++) {
		const detail = results[i];
		const stock = market[i];
		if (!detail || !stock) continue;
		const performance = detail.chart?.performance;
		await db
			.update(capitalMarketLatest)
			.set({
				performance:
					performance && typeof performance === "object"
						? (performance as Record<string, unknown>)
						: {},
				detailUpdatedAt: new Date(),
			})
			.where(eq(capitalMarketLatest.stockId, stock.id));

		const history = detail.chart?.history ?? [];
		for (const point of history) {
			if (
				!Number.isFinite(point.timestamp) ||
				!Number.isFinite(point.price) ||
				point.price <= 0
			) {
				continue;
			}
			const at = new Date(point.timestamp * 1000);
			await recordCandle(stock, point.price, at, 1);
			await recordCandle(stock, point.price, at, 5);
			await recordCandle(stock, point.price, at, 60);
		}
	}
}

/**
 * Refreshes one stock's detail response per cycle.
 *
 * The first boot seeds all 35; after that a single rotating call per minute is
 * enough to keep performance windows and the one-minute history current without
 * spending 35 requests every cycle.
 */
async function refreshOneDetail(stock: MarketStock): Promise<void> {
	try {
		const detail = await requestWithPool(`/torn/${stock.id}/stocks`, (key) =>
			tornApi.get("/torn/{stockId}/stocks", {
				apiKey: key.apiKey,
				userId: key.userId,
				pathParams: { stockId: stock.id },
			}),
		);
		const parsed = readDetailed(detail);
		if (!parsed) return;
		const performance = parsed.chart?.performance;
		await db
			.update(capitalMarketLatest)
			.set({
				performance:
					performance && typeof performance === "object"
						? (performance as Record<string, unknown>)
						: {},
				detailUpdatedAt: new Date(),
			})
			.where(eq(capitalMarketLatest.stockId, stock.id));
		for (const point of parsed.chart?.history ?? []) {
			if (
				!Number.isFinite(point.timestamp) ||
				!Number.isFinite(point.price) ||
				point.price <= 0
			) {
				continue;
			}
			const at = new Date(point.timestamp * 1000);
			await recordCandle(stock, point.price, at, 1);
			await recordCandle(stock, point.price, at, 5);
			await recordCandle(stock, point.price, at, 60);
		}
	} catch (error) {
		logger.warn(
			`Detail refresh failed for ${stock.acronym}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function loadCandleMap(
	intervalMinutes: number,
	days: number,
): Promise<Map<number, CapitalCandle[]>> {
	const cutoff = new Date(Date.now() - days * 86_400_000);
	const rows = await db
		.select()
		.from(capitalMarketCandles)
		.where(
			and(
				eq(capitalMarketCandles.intervalMinutes, intervalMinutes),
				gte(capitalMarketCandles.bucketStart, cutoff),
			),
		)
		.orderBy(capitalMarketCandles.bucketStart);
	const map = new Map<number, CapitalCandle[]>();
	for (const row of rows) {
		const list = map.get(row.stockId) ?? [];
		list.push({
			timestamp: row.bucketStart.getTime() / 1000,
			open: Number(row.open),
			high: Number(row.high),
			low: Number(row.low),
			close: Number(row.close),
			shares: row.shares ?? null,
		});
		map.set(row.stockId, list);
	}
	return map;
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const a = sorted[mid] ?? 0;
	const b = sorted[mid - 1] ?? a;
	return sorted.length % 2 === 0 ? (a + b) / 2 : a;
}

type BookConfig = typeof capitalBookConfigs.$inferSelect;

function signalModeFor(config: BookConfig): CapitalSignalMode {
	return config.signalMode === "momentum" ? "momentum" : "reversal";
}

function scoringConfigFor(config: BookConfig): CapitalScoringConfig {
	return {
		mode: signalModeFor(config),
		minEntryScore: config.minEntryScore,
		maxRsi: config.maxRsi,
		overboughtSigma: config.overboughtSigma,
		reversalEntrySigma: config.reversalEntrySigma,
		reversalExitSigma: config.reversalExitSigma,
		maxVolatilityPct: config.maxVolatilityPct,
	};
}

interface LoadedMlModel {
	id: string;
	trainedAt: Date;
	model: LogisticModel;
}

/** Loads and validates the active model; a shape mismatch disables it safely. */
async function loadMlModel(): Promise<LoadedMlModel | null> {
	const row = await getActiveCapitalMlModel();
	if (!row) return null;
	const artifact = row.artifact as Partial<LogisticModel>;
	const features = artifact.features;
	if (
		!Array.isArray(features) ||
		features.join(",") !== CAPITAL_ML_FEATURES.join(",") ||
		!Array.isArray(artifact.weights) ||
		!Array.isArray(artifact.mean) ||
		!Array.isArray(artifact.std) ||
		artifact.weights.length !== CAPITAL_ML_FEATURES.length
	) {
		logger.warn(
			`ML model ${row.id} does not match the current feature spec; ignoring it.`,
		);
		return null;
	}
	return {
		id: row.id,
		trainedAt: row.trainedAt,
		model: artifact as LogisticModel,
	};
}

function featureSnapshot(
	features: CapitalStockFeatures,
): Record<string, unknown> {
	return {
		price: features.price,
		historyDays: features.historyDays,
		returns: features.returns,
		volatilityPct: features.volatilityPct,
		atr: features.atr,
		ema20: features.ema20,
		ema50: features.ema50,
		sma20: features.sma20,
		rsi14: features.rsi14,
		zscore20: features.zscore20,
		drawdown30Pct: features.drawdown30Pct,
		drawdown90Pct: features.drawdown90Pct,
		relativeStrength30Pct: features.relativeStrength30Pct,
		sharesChange7Pct: features.sharesChange7Pct,
		sharesChange30Pct: features.sharesChange30Pct,
		regimeOn: features.regimeOn,
	};
}

function broadcastAlert(payload: CapitalAlertPayload): void {
	const server = getActiveIpcServer();
	if (!server) return;
	server.broadcast({ action: "capital_alert", data: payload });
}

async function hasOpenOrder(
	book: CapitalBook,
	stockId: number,
	side: "buy" | "sell",
): Promise<boolean> {
	const rows = await getCapitalOrders(book, true);
	return rows.some(
		(order) =>
			order.stockId === stockId &&
			order.side === side &&
			(order.status === "recommended" ||
				order.status === "accepted" ||
				order.status === "partially_filled"),
	);
}

async function createOrder(input: {
	book: CapitalBook;
	stockId: number;
	side: "buy" | "sell";
	shares: number;
	price: number;
	score: number;
	rationale: string;
	factors: Record<string, unknown>;
	riskFlags: string[];
	stopPrice: number | null;
	targetPrice: number | null;
	runId: string;
	expiresAt: Date;
}): Promise<typeof capitalOrders.$inferSelect> {
	const [order] = await db
		.insert(capitalOrders)
		.values({
			book: input.book,
			stockId: input.stockId,
			side: input.side,
			status: "recommended",
			recommendedShares: input.shares,
			priceGuide: String(input.price),
			recommendedPrice: String(input.price),
			minPrice: input.side === "buy" ? String(input.price * 0.995) : null,
			maxPrice: input.side === "buy" ? String(input.price * 1.01) : null,
			score: input.score,
			rationale: input.rationale,
			factorSnapshot: input.factors,
			riskFlags: input.riskFlags,
			stopPrice: input.stopPrice !== null ? String(input.stopPrice) : null,
			targetPrice:
				input.targetPrice !== null ? String(input.targetPrice) : null,
			runId: input.runId,
			expiresAt: input.expiresAt,
			generatedAt: new Date(),
		})
		.returning();
	if (!order) throw new Error("Failed to create capital order.");
	return order;
}

async function autoFillPaperOrder(input: {
	book: "paper";
	order: typeof capitalOrders.$inferSelect;
	config: typeof capitalBookConfigs.$inferSelect;
	price: number;
}): Promise<void> {
	const now = new Date();
	const slippage = input.config.paperSlippageBps / 10_000;
	const fillPrice =
		input.order.side === "buy"
			? input.price * (1 + slippage)
			: input.price * (1 - slippage);
	const notional = moneyFromPriceShares(
		fillPrice.toFixed(6),
		input.order.recommendedShares,
	);
	const fees =
		input.order.side === "sell"
			? mulBps(notional, input.config.saleFeeBps)
			: 0n;
	const cashDelta =
		input.order.side === "buy" ? -(notional + fees) : notional - fees;
	const totalCost = notional + fees;

	await withCapitalTransaction("paper", async (tx) => {
		await applyCapitalFill(tx, {
			book: "paper",
			stockId: input.order.stockId,
			side: input.order.side === "sell" ? "sell" : "buy",
			shares: input.order.recommendedShares,
			price: fillPrice.toFixed(6),
			notional: formatMoney(notional),
			fees: formatMoney(fees),
			cashDelta: formatMoney(cashDelta),
			totalCost: formatMoney(totalCost),
			source: "paper",
			occurredAt: now,
		});

		await tx.insert(capitalFills).values({
			book: "paper",
			orderId: input.order.id,
			stockId: input.order.stockId,
			side: input.order.side,
			shares: input.order.recommendedShares,
			price: fillPrice.toFixed(6),
			notional: formatMoney(notional),
			fees: formatMoney(fees),
			source: "paper",
			occurredAt: now,
		});

		await tx
			.update(capitalOrders)
			.set({
				status: "filled",
				filledShares: input.order.recommendedShares,
				averageFillPrice: fillPrice.toFixed(6),
				acceptedAt: now,
				updatedAt: now,
			})
			.where(eq(capitalOrders.id, input.order.id));
	});
}

async function runBook(
	book: CapitalBook,
	config: typeof capitalBookConfigs.$inferSelect,
	market: MarketStock[],
	featuresByStock: Map<number, CapitalStockFeatures>,
	runId: string,
	ml: LoadedMlModel | null,
): Promise<{ recommendations: number; paperFills: number; errors: string[] }> {
	const errors: string[] = [];
	if (!config.engineEnabled) {
		return { recommendations: 0, paperFills: 0, errors };
	}
	if (book === "live" && !config.liveEnabled) {
		return { recommendations: 0, paperFills: 0, errors };
	}

	const state = await getCapitalState(book);
	const nav = computeNav({
		cash: state.cash,
		units: state.units,
		positions: state.positions.map((position) => ({
			shares: position.shares,
			price: position.price,
		})),
	});
	const positions = await db
		.select()
		.from(capitalPositions)
		.where(eq(capitalPositions.book, book));
	const positionByStock = new Map(
		positions.map((position) => [position.stockId, position]),
	);

	const reserve =
		mulPct(nav.totalValue, config.minCashReservePct) +
		parseMoney(state.unpaidPayouts);
	let freeCash = parseMoney(state.cash) - reserve;
	if (freeCash < 0n) freeCash = 0n;

	const now = new Date();
	const expiresAt = new Date(
		now.getTime() + config.orderValidityMinutes * 60_000,
	);
	let recommendations = 0;
	let paperFills = 0;

	// Exits first: free cash and de-risk before adding exposure.
	for (const position of positions) {
		if (position.shares <= 0) continue;
		const features = featuresByStock.get(position.stockId);
		if (!features) continue;
		if (await hasOpenOrder(book, position.stockId, "sell")) continue;

		const costBasis = parseMoney(position.costBasis);
		const avgCost =
			position.shares > 0 ? moneyToNumber(costBasis) / position.shares : 0;
		const unplanned = position.isUnplanned;
		const stopDistance =
			Math.max(
				features.atr * config.stopAtrMultiplier,
				avgCost * (config.stopMinPct / 100),
			) * (unplanned ? 0.5 : 1);
		const stopPrice = Math.max(0.01, avgCost - stopDistance);
		const peakPrice =
			features.drawdown30Pct < 0
				? features.price / (1 + features.drawdown30Pct / 100)
				: features.price;
		const score = scoreStock(features, scoringConfigFor(config));
		const daysHeld = position.openedAt
			? daysBetween(position.openedAt, now)
			: 0;
		// The position row has no scale-out flag. A prior partial sell on this
		// open position is the durable signal that the +2R trim already ran;
		// without it the engine would trim a third every cycle.
		const [priorSell] = await db
			.select({ id: capitalFills.id })
			.from(capitalFills)
			.where(
				and(
					eq(capitalFills.book, book),
					eq(capitalFills.stockId, position.stockId),
					eq(capitalFills.side, "sell"),
					gte(capitalFills.occurredAt, position.openedAt ?? new Date(0)),
				),
			)
			.limit(1);
		const scaledOut = Boolean(priorSell);
		const forcedErrorExit = unplanned && !score.eligible;
		const decision: CapitalExitDecision = forcedErrorExit
			? {
					action: "sell",
					fraction: 1,
					reason:
						"Error trade review: the setup no longer qualifies; exit to limit the loss.",
					rMultiple: 0,
				}
			: evaluateExit({
					entryPrice: avgCost,
					price: features.price,
					peakPrice,
					stopPrice,
					atr: features.atr,
					ema20: features.ema20,
					ema50: features.ema50,
					score: score.score,
					daysHeld,
					scaledOut,
					mode: signalModeFor(config),
					meanPrice: features.sma20,
					zscore20: features.zscore20,
					reversalExitSigma: config.reversalExitSigma,
					config: {
						trailingTriggerR: config.trailingTriggerR,
						trailingAtrMultiplier: config.trailingAtrMultiplier,
						trailingPct: config.trailingPct,
						tightenTrailPct: config.tightenTrailPct,
						scaleOutR: config.scaleOutR,
						scaleOutFraction: config.scaleOutFraction,
						timeStopDays: config.timeStopDays,
					},
				});
		if (decision.action === "hold") continue;

		const shares =
			decision.action === "scale_out"
				? Math.max(
						1,
						Math.min(
							position.shares,
							Math.floor(position.shares * decision.fraction),
						),
					)
				: position.shares;
		if (shares <= 0) continue;

		const order = await createOrder({
			book,
			stockId: position.stockId,
			side: "sell",
			shares,
			price: features.price,
			score: score.score,
			rationale: unplanned
				? `${decision.reason} (recorded as an error trade; stop is tightened.)`
				: decision.reason,
			factors: featureSnapshot(features),
			riskFlags: unplanned ? [...score.flags, "error_trade"] : score.flags,
			stopPrice: null,
			targetPrice: null,
			runId,
			expiresAt,
		});
		recommendations += 1;
		if (book === "paper" && config.paperAutoFill) {
			await autoFillPaperOrder({
				book: "paper",
				order,
				config,
				price: features.price,
			});
			paperFills += 1;
		} else {
			broadcastAlert({
				kind: "recommendation",
				book,
				stockId: order.stockId,
				title: `SELL ${shares.toLocaleString()} shares`,
				body: `${order.stockId} at market. ${decision.reason}`,
				fields: [
					{
						name: "Price",
						value: formatMoney(parseMoney(features.price.toFixed(6))),
						inline: true,
					},
					{ name: "Score", value: score.score.toFixed(1), inline: true },
				],
				link: "https://stocks.blasted-labs.tech/desk",
			});
		}
	}

	const equityPct =
		nav.totalValue > 0n
			? (moneyToNumber(nav.positionsValue) / moneyToNumber(nav.totalValue)) *
				100
			: 0;
	if (equityPct >= config.maxEquityPct) {
		return { recommendations, paperFills, errors };
	}

	// Entries: rank eligible names, size by risk/cash, stop at max positions.
	// The ML meta-label re-ranks the rule's candidates when enabled; in shadow
	// mode it is still scored and logged, it just does not change the order.
	const mode = signalModeFor(config);
	const mlAgeDays = ml
		? (now.getTime() - ml.trainedAt.getTime()) / 86_400_000
		: Number.POSITIVE_INFINITY;
	const mlActive = mode === "reversal" && ml !== null;
	const mlApplied =
		mlActive && config.mlEnabled && mlAgeDays <= config.mlMaxModelAgeDays;
	if (mlActive && config.mlEnabled && !mlApplied) {
		errors.push(
			`ML model is older than ${config.mlMaxModelAgeDays} days; ignoring it.`,
		);
	}

	interface Candidate {
		features: CapitalStockFeatures;
		score: CapitalSignalScore;
		probability: number | null;
	}
	const candidates: Candidate[] = [...featuresByStock.values()].map(
		(features) => {
			const score = scoreStock(features, scoringConfigFor(config));
			const probability = mlActive
				? predictProbability(ml.model, capitalMlFeatureVector(features))
				: null;
			return { features, score, probability };
		},
	);
	const blendScore = (candidate: Candidate): number =>
		mlApplied
			? candidate.score.score * (1 - config.mlWeight) +
				(candidate.probability ?? 0) * 100 * config.mlWeight
			: candidate.score.score;
	const eligible = candidates
		.filter((candidate) => {
			if (!candidate.score.eligible) return false;
			if (mlApplied && (candidate.probability ?? 0) < config.mlMinConfidence) {
				return false;
			}
			return true;
		})
		.sort((a, b) => blendScore(b) - blendScore(a));

	let positionCount = positions.filter(
		(position) => position.shares > 0,
	).length;
	for (const candidate of eligible) {
		const { features, score, probability } = candidate;
		if (positionCount >= config.maxPositions) break;
		if (positionByStock.has(features.stockId)) continue;
		if (await hasOpenOrder(book, features.stockId, "buy")) continue;

		const existing = positionByStock.get(features.stockId);
		const existingWeight =
			existing && nav.totalValue > 0n
				? (moneyToNumber(parseMoney(existing.costBasis)) /
						moneyToNumber(nav.totalValue)) *
					100
				: 0;
		const plan = planEntry({
			nav: formatMoney(nav.totalValue),
			freeCash: formatMoney(freeCash),
			price: features.price,
			atr: features.atr,
			existingWeightPct: existingWeight,
			config: {
				riskPerTradePct: config.riskPerTradePct,
				maxStockWeightPct: config.maxStockWeightPct,
				stopAtrMultiplier: config.stopAtrMultiplier,
				stopMinPct: config.stopMinPct,
				minNotional: "10000000",
			},
		});
		if (plan.shares <= 0) continue;

		const mlNote =
			probability !== null
				? ` ML p=${(probability * 100).toFixed(1)}%${mlApplied ? "" : " (shadow)"}.`
				: "";
		const rationale =
			mode === "reversal"
				? `Reversal score ${score.score.toFixed(1)} (stretch ${score.components.trend.toFixed(0)}, flow ${score.components.timing.toFixed(0)}, risk ${score.components.risk.toFixed(0)}). z ${features.zscore20.toFixed(2)} vs the 20-period mean ${features.sma20.toFixed(2)}; 30d shares ${(features.sharesChange30Pct ?? 0).toFixed(2)}%.${mlNote} Stop ${plan.stopPrice.toFixed(2)}, target ${plan.targetPrice.toFixed(2)}.`
				: `Score ${score.score.toFixed(1)} (trend ${score.components.trend.toFixed(0)}, timing ${score.components.timing.toFixed(0)}, risk ${score.components.risk.toFixed(0)}). Stop ${plan.stopPrice.toFixed(2)}, target ${plan.targetPrice.toFixed(2)}.`;
		const order = await createOrder({
			book,
			stockId: features.stockId,
			side: "buy",
			shares: plan.shares,
			price: features.price,
			score: score.score,
			rationale,
			factors: featureSnapshot(features),
			riskFlags: score.flags,
			stopPrice: plan.stopPrice,
			targetPrice: plan.targetPrice,
			runId,
			expiresAt,
		});
		if (mlActive && probability !== null) {
			// Shadow logging must never be able to block a real recommendation.
			try {
				const values = capitalMlFeatureVector(features);
				await insertCapitalMlPrediction({
					book,
					stockId: features.stockId,
					modelId: ml.id,
					horizonDays: ml.model.horizonDays,
					entryPrice: features.price,
					probability,
					ruleScore: score.score,
					eligible: score.eligible,
					features: Object.fromEntries(
						CAPITAL_ML_FEATURES.map((name, index) => [
							name,
							values[index] ?? 0,
						]),
					),
				});
			} catch (error) {
				errors.push(
					`ML prediction log failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		recommendations += 1;
		positionCount += 1;
		freeCash -= plan.notional;

		if (book === "paper" && config.paperAutoFill) {
			await autoFillPaperOrder({
				book: "paper",
				order,
				config,
				price: features.price,
			});
			paperFills += 1;
		} else {
			broadcastAlert({
				kind: "recommendation",
				book,
				stockId: features.stockId,
				title: `BUY ${plan.shares.toLocaleString()} shares`,
				body: `${features.stockId} at market. ${order.rationale}`,
				fields: [
					{
						name: "Price",
						value: formatMoney(parseMoney(features.price.toFixed(6))),
						inline: true,
					},
					{ name: "Score", value: score.score.toFixed(1), inline: true },
					{ name: "Stop", value: plan.stopPrice.toFixed(2), inline: true },
				],
				link: "https://stocks.blasted-labs.tech/desk",
			});
		}
	}

	return { recommendations, paperFills, errors };
}

/**
 * One synchronous capital engine cycle. Exported for the smoke-test IPC
 * handler, which runs the paper book without waiting for the cron tick.
 */
export async function runCapitalEngineCycle(options?: {
	books?: CapitalBook[];
	trigger?: "schedule" | "manual" | "smoke";
}): Promise<EngineRunResult> {
	const books = options?.books ?? ["live", "paper"];
	const errors: string[] = [];
	await ensureCapitalBooks();

	let market: MarketStock[] = [];
	try {
		market = await fetchMarket();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		errors.push(`Market fetch failed: ${message}`);
		logger.error("Capital market fetch failed:", error);
	}

	const state = await getWorkerState(WORKER_STATE_IDS.capitalEngine);
	let seededAll = false;
	if (market.length > 0 && !state?.init) {
		try {
			await bootstrapDetailHistory(market);
			seededAll = true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`Detail bootstrap failed: ${message}`);
			logger.warn("Capital detail bootstrap failed:", error);
		} finally {
			// Even a partial seed is a one-time best effort: the per-minute market
			// poll keeps candles growing, and a failed detail fetch must not cause
			// all 35 detail calls to be retried every 60 seconds.
			await setWorkerInitFlag(WORKER_STATE_IDS.capitalEngine, true);
		}
	}

	if (market.length > 0 && !seededAll) {
		const rotation = market[Math.floor(Date.now() / 60_000) % market.length];
		if (rotation) await refreshOneDetail(rotation);
	}

	const latest = await db.select().from(capitalMarketLatest);
	const hourly = await loadCandleMap(60, 120);
	const fiveMinute = await loadCandleMap(5, 7);
	const daily = await loadCandleMap(1_440, 400);

	/**
	 * Builds a feature map at one candle resolution. Reversal mode uses daily
	 * bars (the horizon the backtest validated); momentum mode keeps the hourly
	 * bars the original score was tuned on. Regime is per-resolution so a book
	 * only sees the market context its own signal uses.
	 */
	const buildFeatures = (
		candlesByStock: Map<number, CapitalCandle[]>,
		fallback: Map<number, CapitalCandle[]>,
	): Map<number, CapitalStockFeatures> => {
		const map = new Map<number, CapitalStockFeatures>();
		const provisional: CapitalStockFeatures[] = [];
		for (const stock of market) {
			const candles =
				(candlesByStock.get(stock.id)?.length ?? 0) >= 2
					? (candlesByStock.get(stock.id) ?? [])
					: (fallback.get(stock.id) ?? []);
			if (candles.length === 0) continue;
			const features = computeFeatures({
				stockId: stock.id,
				price: stock.price,
				candles,
				regimeOn: true,
			});
			if (!features) continue;
			provisional.push(features);
			map.set(stock.id, features);
		}
		const d30Returns = provisional
			.map((features) => features.returns.d30)
			.filter((value): value is number => value !== null);
		const regimeOn = d30Returns.length === 0 ? true : median(d30Returns) > 0;
		for (const [stockId, features] of map) {
			map.set(stockId, { ...features, regimeOn });
		}
		return map;
	};

	const hourlyFeatures = buildFeatures(hourly, fiveMinute);
	const dailyFeatures = buildFeatures(daily, hourly);
	const stocksScored = Math.max(hourlyFeatures.size, dailyFeatures.size);
	const mlModel = await loadMlModel();

	const runId = crypto.randomUUID();
	const startedAt = new Date();
	let recommendations = 0;
	let paperFills = 0;
	const bookResults: Array<{
		book: CapitalBook;
		recommendations: number;
		paperFills: number;
		errors: string[];
	}> = [];
	for (const book of books) {
		try {
			const config = await getCapitalConfig(book);
			if (book === "paper") {
				const paperState = await getCapitalState("paper");
				const [txCount] = await db
					.select({ total: sql<number>`COUNT(*)` })
					.from(capitalTransactions)
					.where(eq(capitalTransactions.book, "paper"));
				if (
					Number(txCount?.total ?? 0) === 0 &&
					parseMoney(paperState.cash) === 0n
				) {
					await resetCapitalPaperBook(config.paperStartingCash, null);
				}
			}
			const result = await runBook(
				book,
				config,
				market,
				signalModeFor(config) === "reversal" ? dailyFeatures : hourlyFeatures,
				runId,
				mlModel,
			);
			recommendations += result.recommendations;
			paperFills += result.paperFills;
			errors.push(...result.errors);
			bookResults.push({
				book,
				recommendations: result.recommendations,
				paperFills: result.paperFills,
				errors: result.errors,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${book}: ${message}`);
			bookResults.push({
				book,
				recommendations: 0,
				paperFills: 0,
				errors: [message],
			});
			logger.error(`Capital engine failed for ${book}:`, error);
		}
	}

	const newest = latest.reduce(
		(latestAt, row) =>
			row.updatedAt && row.updatedAt > latestAt ? row.updatedAt : latestAt,
		new Date(0),
	);
	const dataAgeSeconds =
		newest.getTime() > 0
			? Math.max(0, Math.floor((Date.now() - newest.getTime()) / 1000))
			: null;

	const finishedAt = new Date();
	for (const result of bookResults) {
		await db.insert(capitalEngineRuns).values({
			book: result.book,
			trigger: options?.trigger ?? "schedule",
			status: result.errors.length > 0 ? "error" : "completed",
			startedAt,
			finishedAt,
			durationMs: finishedAt.getTime() - startedAt.getTime(),
			dataAgeSeconds,
			stocksScored,
			recommendations: result.recommendations,
			paperFills: result.paperFills,
			errors: result.errors,
			details: { runId },
		});
	}

	await upsertWorkerState({
		workerId: WORKER_STATE_IDS.capitalEngine,
		status: errors.length > 0 ? "degraded" : "idle",
		lastError: errors[0] ?? null,
		lastRunAt: new Date(),
		details: {
			lastSuccessAt: new Date().toISOString(),
			dataAgeSeconds,
			stocksScored,
			recommendations,
			paperFills,
			trigger: options?.trigger ?? "schedule",
		},
	});

	return {
		stocksPolled: market.length,
		stocksScored,
		recommendations,
		paperFills,
		dataAgeSeconds,
		errors,
	};
}

export function startCapitalEngine(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "* * * * *", timezone: "Etc/UTC" },
		initialDelayMs: options?.initialDelayMs,
		handler: async () => {
			await runCapitalEngineCycle({ trigger: "schedule" });
		},
	});
}
