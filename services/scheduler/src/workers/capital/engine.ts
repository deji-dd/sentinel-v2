import {
	and,
	applyCapitalFill,
	capitalBookConfigs,
	capitalEngineRuns,
	capitalFills,
	capitalMarketCandles,
	capitalMarketLatest,
	capitalOrders,
	capitalPositions,
	db,
	ensureCapitalBooks,
	eq,
	expireCapitalOrders,
	getActiveCapitalMlModel,
	getCapitalConfig,
	getCapitalOrders,
	getCapitalRiskContext,
	getCapitalState,
	getWorkerState,
	gte,
	insertCapitalMlPrediction,
	setWorkerInitFlag,
	sql,
	tornStocks,
	tryAcquireCapitalEngineLock,
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
	CAPITAL_CONFIDENCE,
	CAPITAL_ENTRY_STOP,
	CAPITAL_EXIT,
	CAPITAL_ML_FEATURES,
	CAPITAL_PRICE_GUARD_PCT,
	CAPITAL_SIZING,
	type CapitalCandle,
	type CapitalExitDecision,
	type CapitalExitReason,
	capitalMlFeatureVector,
	type CapitalScoringConfig,
	type CapitalSignalMode,
	type CapitalSignalScore,
	type CapitalStockFeatures,
	computeFeatures,
	computeInvestorMetrics,
	computeMarketRegime,
	computeNav,
	confidenceMultiplier,
	dailyReturnPct,
	daysBetween,
	drawdownPctFromPeak,
	entryStopDistance,
	evaluateExit,
	floorToUtcBucket,
	formatMoney,
	isPriceOutlier,
	isStopCooldownActive,
	Logger,
	type LogisticModel,
	moneyFromPriceShares,
	moneyToNumber,
	mulBps,
	mulPct,
	parseMoney,
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

interface PriceGuardEvent {
	stockId: number;
	previous: number;
	next: number;
	/** True when a second consecutive print confirmed the move. */
	confirmed: boolean;
}

/**
 * A single anomalous print is ignored; the same price on the next cycle is
 * accepted as a real gap. Without this, a legitimate >25% move would be
 * rejected forever because the last accepted price never changes.
 */
const pendingGuardedPrices = new Map<number, number>();
const PRICE_GUARD_CONFIRM_PCT = 5;

/**
 * Polls `/torn/stocks`, updates the latest snapshot and the OHLC candles.
 *
 * One call returns every tradable stock; the per-stock detail endpoint is only
 * used to seed history/performance, never for the price every minute.
 *
 * A print that moves more than `CAPITAL_PRICE_GUARD_PCT` from the last accepted
 * price is skipped for the cycle. The stock is absent from the returned market,
 * so the engine's fallback uses the last accepted quote for exits and the fresh
 * id set excludes it from entries. `guardEvents` is surfaced as a risk alert.
 */
async function fetchMarket(
	guardEvents: PriceGuardEvent[],
): Promise<MarketStock[]> {
	const payload = await requestWithPool("/torn/stocks", (key) =>
		tornApi.get("/torn/stocks", { apiKey: key.apiKey, userId: key.userId }),
	);
	const stocks = readStocks(payload);
	const previousRows = await db
		.select({
			stockId: capitalMarketLatest.stockId,
			price: capitalMarketLatest.price,
		})
		.from(capitalMarketLatest);
	const previousPrices = new Map(
		previousRows.map((row) => [row.stockId, Number(row.price)]),
	);
	const now = new Date();
	const market: MarketStock[] = [];

	for (const stock of stocks) {
		const price = toNumber(stock.market?.price);
		if (price <= 0) continue;
		const previous = previousPrices.get(stock.id);
		if (
			previous !== undefined &&
			previous > 0 &&
			isPriceOutlier(previous, price)
		) {
			const pending = pendingGuardedPrices.get(stock.id);
			const confirmed =
				pending !== undefined &&
				Math.abs(price / pending - 1) * 100 <= PRICE_GUARD_CONFIRM_PCT;
			if (!confirmed) {
				pendingGuardedPrices.set(stock.id, price);
				guardEvents.push({
					stockId: stock.id,
					previous,
					next: price,
					confirmed: false,
				});
				continue;
			}
			pendingGuardedPrices.delete(stock.id);
			guardEvents.push({
				stockId: stock.id,
				previous,
				next: price,
				confirmed: true,
			});
		} else {
			pendingGuardedPrices.delete(stock.id);
		}
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
		// Daily bars drive the reversal features. The one-time history backfill
		// seeds them, but without this upsert the newest daily bar would freeze
		// at the backfill date and every SMA/z-score would quietly drift stale.
		await recordCandle({ id: stock.id, shares, investors }, price, now, 1_440);
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

/**
 * Equal-weight market index from the stored daily closes.
 *
 * `computeMarketRegime` expects a single series. Torn has no index endpoint, so
 * the average close of every stock on each UTC day is the closest honest proxy
 * and it is what makes `regimeSmaDays` meaningful.
 */
function buildMarketIndexCandles(
	daily: Map<number, CapitalCandle[]>,
): CapitalCandle[] {
	const byDay = new Map<number, { sum: number; count: number }>();
	for (const candles of daily.values()) {
		for (const candle of candles) {
			if (!Number.isFinite(candle.close) || candle.close <= 0) continue;
			const day = Math.floor(candle.timestamp / 86_400) * 86_400;
			const bucket = byDay.get(day) ?? { sum: 0, count: 0 };
			bucket.sum += candle.close;
			bucket.count += 1;
			byDay.set(day, bucket);
		}
	}
	return [...byDay.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([timestamp, bucket]) => {
			const close = bucket.sum / Math.max(1, bucket.count);
			return {
				timestamp,
				open: close,
				high: close,
				low: close,
				close,
			};
		});
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

const CURRENT_ML_LABEL_SPEC = "first_trim_r1_v1";

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
	if (artifact.labelSpec && artifact.labelSpec !== CURRENT_ML_LABEL_SPEC) {
		logger.warn(
			`ML model ${row.id} was trained on label '${artifact.labelSpec}', not '${CURRENT_ML_LABEL_SPEC}'; ignoring it.`,
		);
		return null;
	}
	if (!artifact.labelSpec) {
		logger.warn(
			`ML model ${row.id} has no labelSpec; treating it as the legacy +2%/-2% first-trim proxy.`,
		);
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

/** Drawdown / daily-loss / cooldown state for one book's cycle. */
interface BookRiskState {
	drawdownPct: number | null;
	dailyReturnPct: number | null;
	entriesPaused: boolean;
	sizeScale: number;
	cooldownStockIds: number[];
	pauseReasons: string[];
}

function numberOrNull(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads the risk overlay inputs and turns them into entry gates.
 *
 * The drawdown and daily-loss checks use NAV per unit, so a deposit or a
 * withdrawal cannot look like performance. Exits are never paused: the point of
 * the overlay is to stop adding risk, not to trap the book in falling names.
 */
async function assessBookRisk(
	book: CapitalBook,
	config: typeof capitalBookConfigs.$inferSelect,
	navPerUnit: string,
	now: Date,
): Promise<BookRiskState> {
	const context = await getCapitalRiskContext(
		book,
		now,
		config.stopCooldownDays,
	);
	const current = numberOrNull(navPerUnit);
	const peak = numberOrNull(context.peakNavPerUnit);
	const dayStart = numberOrNull(context.dayStartNavPerUnit);
	const drawdownPct =
		current !== null && peak !== null
			? drawdownPctFromPeak(current, peak)
			: null;
	const dailyPct =
		current !== null && dayStart !== null
			? dailyReturnPct(current, dayStart)
			: null;

	const pauseReasons: string[] = [];
	if (
		drawdownPct !== null &&
		config.drawdownHaltPct > 0 &&
		drawdownPct <= -config.drawdownHaltPct
	) {
		pauseReasons.push(
			`drawdown ${drawdownPct.toFixed(2)}% reached the ${config.drawdownHaltPct}% halt`,
		);
	}
	if (
		dailyPct !== null &&
		config.dailyLossHaltPct > 0 &&
		dailyPct <= -config.dailyLossHaltPct
	) {
		pauseReasons.push(
			`daily loss ${dailyPct.toFixed(2)}% reached the ${config.dailyLossHaltPct}% halt`,
		);
	}
	const derisked =
		drawdownPct !== null &&
		config.drawdownDeriskPct > 0 &&
		drawdownPct <= -config.drawdownDeriskPct;

	return {
		drawdownPct,
		dailyReturnPct: dailyPct,
		entriesPaused: pauseReasons.length > 0,
		sizeScale: derisked ? CAPITAL_CONFIDENCE.deriskMultiplier : 1,
		cooldownStockIds: context.stoppedOutStockIds,
		pauseReasons,
	};
}

const DESK_URL = "https://stocks.blasted-labs.tech/desk";
const PAPER_DESK_URL = "https://stocks.blasted-labs.tech/desk/paper";

/** `[ACRONYM] Stock name`, falling back gracefully when either is missing. */
function stockDisplayName(acronym: string, name: string): string {
	const trimmedAcronym = acronym.trim();
	const trimmedName = name.trim();
	if (trimmedAcronym && trimmedName)
		return `[${trimmedAcronym}] ${trimmedName}`;
	if (trimmedAcronym) return `[${trimmedAcronym}]`;
	return trimmedName || "Unknown stock";
}

/** Trade notional as a percentage of NAV, or null when NAV is unusable. */
function sizePctOfNav(
	navTotal: bigint,
	price: number,
	shares: number,
): number | null {
	const nav = moneyToNumber(navTotal);
	if (!(nav > 0)) return null;
	const notional = moneyToNumber(
		moneyFromPriceShares(price.toFixed(6), shares),
	);
	return (notional / nav) * 100;
}

/**
 * One trade alert for both books.
 *
 * Paper alerts are intentional: they are the only way to see the strategy
 * working without risking capital. The mode field distinguishes the two books;
 * the title carries only the acronym, direction and size.
 */
function broadcastTradeAlert(input: {
	book: CapitalBook;
	stockId: number;
	stockAcronym: string;
	stockName: string;
	side: "buy" | "sell";
	shares: number;
	price: number;
	score: number;
	stopPrice: number | null;
	targetPrice: number | null;
	reason: string | null;
	filled: boolean;
	sizePct?: number | null;
}): void {
	const isPaper = input.book === "paper";
	const action = input.side === "buy" ? "Buy" : "Sell";
	const acronym =
		input.stockAcronym.trim() || input.stockName.trim() || "Stock";
	const title = `[${acronym}] ${action} ${input.shares.toLocaleString()} shares`;
	const body = input.reason
		? input.reason
		: input.filled
			? "Filled at market."
			: "Order placed at market.";
	const fields: CapitalAlertPayload["fields"] = [
		{ name: "Mode", value: isPaper ? "Simulation" : "Live", inline: true },
		{
			name: "Stock",
			value: stockDisplayName(input.stockAcronym, input.stockName),
			inline: true,
		},
		{
			name: "Fill",
			value: formatMoney(parseMoney(input.price.toFixed(6))),
			inline: true,
		},
		{ name: "Score", value: input.score.toFixed(1), inline: true },
	];
	if (input.sizePct !== undefined && input.sizePct !== null) {
		fields.push({
			name: "Size",
			value: `${input.sizePct.toFixed(1)}% NAV`,
			inline: true,
		});
	}
	if (input.stopPrice !== null) {
		fields.push({
			name: "Stop",
			value: input.stopPrice.toFixed(2),
			inline: true,
		});
	}
	if (input.targetPrice !== null) {
		fields.push({
			name: "Target",
			value: input.targetPrice.toFixed(2),
			inline: true,
		});
	}
	broadcastAlert({
		kind: "recommendation",
		book: input.book,
		stockId: input.stockId,
		title,
		body,
		fields,
		link: isPaper ? PAPER_DESK_URL : DESK_URL,
	});
}

const priceGuardAlertAt = new Map<number, number>();
const PRICE_GUARD_ALERT_COOLDOWN_MS = 30 * 60_000;

function alertPriceGuard(event: PriceGuardEvent): void {
	const last = priceGuardAlertAt.get(event.stockId) ?? 0;
	if (Date.now() - last < PRICE_GUARD_ALERT_COOLDOWN_MS) return;
	priceGuardAlertAt.set(event.stockId, Date.now());
	const movePct = ((event.next / event.previous - 1) * 100).toFixed(1);
	broadcastAlert({
		kind: "risk",
		book: "live",
		stockId: event.stockId,
		title: event.confirmed
			? "Gap confirmed and accepted"
			: "Suspect market print ignored",
		body: event.confirmed
			? `Stock #${event.stockId} printed ${event.next} twice after ${event.previous} (${movePct}%), so the move is being accepted as a real gap.`
			: `Stock #${event.stockId} moved ${event.previous} → ${event.next} (${movePct}%), above the ${CAPITAL_PRICE_GUARD_PCT}% guard. The last accepted price was used for exits and the name was skipped for entries this cycle.`,
		fields: [{ name: "Move", value: `${movePct}%`, inline: true }],
		link: DESK_URL,
	});
}

function broadcastRiskTransition(input: {
	book: CapitalBook;
	paused: boolean;
	reasons: string[];
}): void {
	const isPaper = input.book === "paper";
	broadcastAlert({
		kind: "risk",
		book: input.book,
		title: `${isPaper ? "TEST " : ""}${input.paused ? "New entries paused" : "Entries resumed"}`,
		body: input.paused
			? input.reasons.join("; ") || "The risk overlay paused new entries."
			: "The risk overlay no longer blocks new entries. Exits were never paused.",
		fields: input.paused
			? [{ name: "Book", value: input.book, inline: true }]
			: [],
		link: isPaper ? PAPER_DESK_URL : DESK_URL,
	});
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
	exitReason: CapitalExitReason | null;
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
			exitReason: input.exitReason,
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
}): Promise<number> {
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
			entry:
				input.order.side === "buy"
					? {
							price: fillPrice.toFixed(6),
							stopPrice: input.order.stopPrice,
							targetPrice: input.order.targetPrice,
						}
					: undefined,
			exitReason: input.order.exitReason,
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
			exitReason: input.order.exitReason,
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

	return fillPrice;
}

function idleRisk(): BookRiskState {
	return {
		drawdownPct: null,
		dailyReturnPct: null,
		entriesPaused: false,
		sizeScale: 1,
		cooldownStockIds: [],
		pauseReasons: [],
	};
}

interface BookRunResult {
	recommendations: number;
	paperFills: number;
	errors: string[];
	risk: BookRiskState;
	/** Operational detail for the engine run row; never drives status. */
	details: {
		entriesAllowed: boolean;
		entryPauseReasons: string[];
		cooldownSkips: number;
	};
}

async function runBook(
	book: CapitalBook,
	config: typeof capitalBookConfigs.$inferSelect,
	featuresByStock: Map<number, CapitalStockFeatures>,
	marketById: Map<number, MarketStock>,
	regimeOn: boolean,
	freshStockIds: Set<number>,
	dataAgeSeconds: number | null,
	marketFetchOk: boolean,
	runId: string,
	ml: LoadedMlModel | null,
): Promise<BookRunResult> {
	const errors: string[] = [];
	if (!config.engineEnabled) {
		return {
			recommendations: 0,
			paperFills: 0,
			errors,
			risk: idleRisk(),
			details: {
				entriesAllowed: false,
				entryPauseReasons: [],
				cooldownSkips: 0,
			},
		};
	}
	if (book === "live" && !config.liveEnabled) {
		return {
			recommendations: 0,
			paperFills: 0,
			errors,
			risk: idleRisk(),
			details: {
				entriesAllowed: false,
				entryPauseReasons: [],
				cooldownSkips: 0,
			},
		};
	}

	const now = new Date();

	// Regime is per book (the SMA window is a setting), so scope the shared
	// feature map instead of rebuilding features for each book.
	const scopedFeatures = new Map<number, CapitalStockFeatures>();
	for (const [stockId, features] of featuresByStock) {
		scopedFeatures.set(
			stockId,
			features.regimeOn === regimeOn ? features : { ...features, regimeOn },
		);
	}

	const stockMeta = (
		stockId: number,
	): { stockAcronym: string; stockName: string } => {
		const stock = marketById.get(stockId);
		return {
			stockAcronym: stock?.acronym ?? "",
			stockName: stock?.name ?? "",
		};
	};

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
	// Only *open* positions block a new entry. The table keeps a zero-share row
	// after a full exit for its realised P&L history; treating that row as an
	// open position would permanently ban a name the book has traded before.
	const openPositions = positions.filter((position) => position.shares > 0);
	const positionByStock = new Map(
		openPositions.map((position) => [position.stockId, position]),
	);

	const reserve =
		mulPct(nav.totalValue, CAPITAL_SIZING.minCashReservePct) +
		parseMoney(state.unpaidPayouts);
	let freeCash = parseMoney(state.cash) - reserve;
	if (freeCash < 0n) freeCash = 0n;

	const risk = await assessBookRisk(
		book,
		config,
		formatMoney(nav.navPerUnit),
		now,
	);
	const expiresAt = new Date(
		now.getTime() + config.orderValidityMinutes * 60_000,
	);
	let recommendations = 0;
	let paperFills = 0;
	let cooldownSkips = 0;

	// One query for every open order per book. The previous per-position and
	// per-candidate query made this loop O(n²) over the order table.
	const openOrders = await getCapitalOrders(book, true);
	const openOrderKeys = new Set(
		openOrders.map((order) => `${order.side}:${order.stockId}`),
	);

	// Exits first: free cash and de-risk before adding exposure.
	for (const position of positions) {
		if (position.shares <= 0) continue;
		const features = scopedFeatures.get(position.stockId);
		if (!features) {
			// A held stock with no feature snapshot means the position cannot be
			// marked, and its stop/trail would be silently off. The cycle carries
			// the last known price via the fallback market, so reaching this branch
			// means even that data is missing.
			errors.push(
				`${book}: no price/feature snapshot for held stock #${position.stockId}; exit checks skipped this cycle.`,
			);
			continue;
		}
		if (openOrderKeys.has(`sell:${position.stockId}`)) continue;

		const costBasis = parseMoney(position.costBasis);
		const avgCost =
			position.shares > 0 ? moneyToNumber(costBasis) / position.shares : 0;
		if (avgCost <= 0) continue;
		const unplanned = position.isUnplanned;
		const storedEntry = numberOrNull(position.entryPrice);
		const entryPrice =
			storedEntry !== null && storedEntry > 0 ? storedEntry : avgCost;
		let stopPrice = numberOrNull(position.stopPrice) ?? 0;
		let targetPrice = numberOrNull(position.targetPrice) ?? 0;
		let peakPrice = numberOrNull(position.peakPrice) ?? 0;

		// Freeze the stop once. Positions created before the stop columns
		// existed (or outside the recommendation flow) get one derived from the
		// entry price and today's ATR, then never recomputed.
		const needsStop =
			stopPrice === null || stopPrice <= 0 || stopPrice >= entryPrice;
		if (needsStop) {
			const distance =
				entryStopDistance({
					price: entryPrice,
					atr: features.atr,
					atrMultiplier: config.stopAtrMultiplier,
					minPct: config.stopMinPct,
					maxPct: CAPITAL_ENTRY_STOP.maxPct,
				}) * (unplanned ? 0.5 : 1);
			stopPrice = Math.max(0.01, entryPrice - Math.max(0.01, distance));
		}
		const needsTarget = targetPrice <= entryPrice;
		if (needsTarget) {
			targetPrice =
				entryPrice + (entryPrice - stopPrice) * CAPITAL_ENTRY_STOP.targetR;
		}
		const needsPeak = peakPrice <= 0;
		if (needsPeak) {
			peakPrice = Math.max(entryPrice, features.price);
		}
		// High-water mark since entry only. The old code derived a "peak" from
		// the 30-day high, which could be a pre-entry price and trigger a trail
		// on a position that never made a new high.
		const nextPeak = Math.max(peakPrice, features.price);

		const patch: Record<string, unknown> = {};
		if (position.entryPrice === null) patch.entryPrice = entryPrice.toFixed(6);
		if (needsStop) patch.stopPrice = stopPrice.toFixed(6);
		if (needsTarget) patch.targetPrice = targetPrice.toFixed(6);
		if (needsPeak || nextPeak > peakPrice + 1e-9) {
			patch.peakPrice = nextPeak.toFixed(6);
		}
		if (Object.keys(patch).length > 0) {
			await db
				.update(capitalPositions)
				.set(patch)
				.where(
					and(
						eq(capitalPositions.book, book),
						eq(capitalPositions.stockId, position.stockId),
					),
				);
		}

		const score = scoreStock(features, scoringConfigFor(config));
		const daysHeld = position.openedAt
			? daysBetween(position.openedAt, now)
			: 0;
		// `scaled_out_at` is the durable flag. The prior-sell fallback keeps
		// positions opened before that column existed from trimming twice.
		const [priorScaleOut] = position.scaledOutAt
			? [null]
			: await db
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
		const scaledOut = Boolean(position.scaledOutAt) || Boolean(priorScaleOut);
		const forcedErrorExit = unplanned && !score.eligible;
		const decision: CapitalExitDecision = forcedErrorExit
			? {
					action: "sell",
					fraction: 1,
					reason:
						"Error trade review: the setup no longer qualifies; exit to limit the loss.",
					reasonCode: "error_review",
					rMultiple:
						(features.price - entryPrice) /
						Math.max(0.01, entryPrice - stopPrice),
				}
			: evaluateExit({
					entryPrice,
					price: features.price,
					// The trailing stop must see the since-entry high, and the hard
					// stop must be the frozen entry stop.
					peakPrice: nextPeak,
					stopPrice,
					targetPrice,
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
		const sizePct = sizePctOfNav(nav.totalValue, features.price, shares);

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
			exitReason: decision.reasonCode,
			runId,
			expiresAt,
		});
		recommendations += 1;
		if (book === "paper" && config.paperAutoFill) {
			const fillPrice = await autoFillPaperOrder({
				book: "paper",
				order,
				config,
				price: features.price,
			});
			paperFills += 1;
			broadcastTradeAlert({
				book,
				stockId: order.stockId,
				...stockMeta(order.stockId),
				side: "sell",
				shares,
				price: fillPrice,
				score: score.score,
				stopPrice: null,
				targetPrice: null,
				reason: decision.reason,
				filled: true,
				sizePct,
			});
		} else {
			broadcastTradeAlert({
				book,
				stockId: order.stockId,
				...stockMeta(order.stockId),
				side: "sell",
				shares,
				price: features.price,
				score: score.score,
				stopPrice: null,
				targetPrice: null,
				reason: decision.reason,
				filled: false,
				sizePct,
			});
		}
	}

	const equityPct =
		nav.totalValue > 0n
			? (moneyToNumber(nav.positionsValue) / moneyToNumber(nav.totalValue)) *
				100
			: 0;
	const entryPauseReasons = [...risk.pauseReasons];
	if (equityPct >= CAPITAL_SIZING.maxEquityPct) {
		entryPauseReasons.push(
			`invested ${equityPct.toFixed(1)}% reached the ${CAPITAL_SIZING.maxEquityPct}% equity cap`,
		);
	}
	// Stale or missing market data pauses new risk. Exits above still ran, so a
	// stop or trail is never switched off by an outage.
	const entriesAllowed =
		marketFetchOk &&
		dataAgeSeconds !== null &&
		dataAgeSeconds <= config.staleDataSeconds;
	if (!entriesAllowed) {
		entryPauseReasons.push(
			marketFetchOk
				? `market data is ${dataAgeSeconds}s old (limit ${config.staleDataSeconds}s)`
				: "market fetch failed",
		);
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
	const candidates: Candidate[] = [...scopedFeatures.values()].map(
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

	const cooldownStockIds = new Set(risk.cooldownStockIds);
	let positionCount = openPositions.length;
	if (entriesAllowed && entryPauseReasons.length === 0) {
		for (const candidate of eligible) {
			const { features, score, probability } = candidate;
			if (positionCount >= CAPITAL_SIZING.maxPositions) break;
			if (positionByStock.has(features.stockId)) continue;
			// A fallback price exists only to evaluate exits; never open a new
			// position on a stale or missing quote.
			if (!freshStockIds.has(features.stockId)) continue;
			if (openOrderKeys.has(`buy:${features.stockId}`)) continue;
			if (cooldownStockIds.has(features.stockId)) {
				cooldownSkips += 1;
				continue;
			}

			// Size on the blended score so an enabled (non-shadow) ML model
			// affects position size, not just the ordering.
			const sizeMultiplier =
				confidenceMultiplier(blendScore(candidate)) * risk.sizeScale;
			const plan = planEntry({
				nav: formatMoney(nav.totalValue),
				freeCash: formatMoney(freeCash),
				price: features.price,
				atr: features.atr,
				// The loop already skipped every open position, so this is a new
				// name with no existing weight.
				existingWeightPct: 0,
				sizeMultiplier,
				maxSizeMultiplier: CAPITAL_CONFIDENCE.maxMultiplier,
				config: {
					riskPerTradePct: CAPITAL_SIZING.riskPerTradePct,
					maxStockWeightPct: CAPITAL_SIZING.maxStockWeightPct,
					stopAtrMultiplier: config.stopAtrMultiplier,
					stopMinPct: config.stopMinPct,
					stopMaxPct: CAPITAL_ENTRY_STOP.maxPct,
					targetR: CAPITAL_ENTRY_STOP.targetR,
					minNotional: CAPITAL_SIZING.minNotional,
				},
			});
			if (plan.shares <= 0) continue;

			const mlNote =
				probability !== null
					? ` ML p=${(probability * 100).toFixed(1)}%${mlApplied ? "" : " (shadow)"}.`
					: "";
			const sizingNote =
				` Size ${plan.positionPct.toFixed(1)}% NAV (${sizeMultiplier.toFixed(2)}x confidence), ` +
				`risk ${(plan.riskAmount / 100).toFixed(2)}% NAV.`;
			const rationale =
				mode === "reversal"
					? `Reversal score ${score.score.toFixed(1)} (stretch ${score.components.trend.toFixed(0)}, flow ${score.components.timing.toFixed(0)}, risk ${score.components.risk.toFixed(0)}). z ${features.zscore20.toFixed(2)} vs the 20-period mean ${features.sma20.toFixed(2)}; 7d shares ${(features.sharesChange7Pct ?? 0).toFixed(2)}%.${mlNote} Stop ${plan.stopPrice.toFixed(2)}, target ${plan.targetPrice.toFixed(2)}.${sizingNote}`
					: `Score ${score.score.toFixed(1)} (trend ${score.components.trend.toFixed(0)}, timing ${score.components.timing.toFixed(0)}, risk ${score.components.risk.toFixed(0)}). Stop ${plan.stopPrice.toFixed(2)}, target ${plan.targetPrice.toFixed(2)}.${sizingNote}`;
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
				exitReason: null,
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
				const fillPrice = await autoFillPaperOrder({
					book: "paper",
					order,
					config,
					price: features.price,
				});
				paperFills += 1;
				broadcastTradeAlert({
					book,
					stockId: features.stockId,
					...stockMeta(features.stockId),
					side: "buy",
					shares: plan.shares,
					price: fillPrice,
					score: score.score,
					stopPrice: plan.stopPrice,
					targetPrice: plan.targetPrice,
					reason: null,
					filled: true,
					sizePct: plan.positionPct,
				});
			} else {
				broadcastTradeAlert({
					book,
					stockId: features.stockId,
					...stockMeta(features.stockId),
					side: "buy",
					shares: plan.shares,
					price: features.price,
					score: score.score,
					stopPrice: plan.stopPrice,
					targetPrice: plan.targetPrice,
					reason: null,
					filled: false,
					sizePct: plan.positionPct,
				});
			}
		}
	}

	return {
		recommendations,
		paperFills,
		errors,
		risk,
		details: {
			entriesAllowed,
			entryPauseReasons,
			cooldownSkips,
		},
	};
}

/**
 * One synchronous capital engine cycle. Exported for the smoke-test IPC
 * handler, which runs the paper book without waiting for the cron tick.
 */
async function runCapitalEngineCycleLocked(options?: {
	books?: CapitalBook[];
	trigger?: "schedule" | "manual" | "smoke";
}): Promise<EngineRunResult> {
	const books = options?.books ?? ["live", "paper"];
	const errors: string[] = [];
	await ensureCapitalBooks();

	const guardEvents: PriceGuardEvent[] = [];
	let market: MarketStock[] = [];
	try {
		market = await fetchMarket(guardEvents);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		errors.push(`Market fetch failed: ${message}`);
		logger.error("Capital market fetch failed:", error);
	}
	for (const event of guardEvents) {
		const movePct = ((event.next / event.previous - 1) * 100).toFixed(1);
		errors.push(
			event.confirmed
				? `Confirmed gap for #${event.stockId}: ${event.previous} -> ${event.next} (${movePct}%); accepted.`
				: `Suspect market print for #${event.stockId}: ${event.previous} -> ${event.next} (${movePct}%); ignored this cycle.`,
		);
		alertPriceGuard(event);
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
	const stockReferences = await db
		.select({
			id: tornStocks.id,
			name: tornStocks.name,
			acronym: tornStocks.acronym,
		})
		.from(tornStocks);
	const stockReferenceById = new Map(
		stockReferences.map((row) => [
			Number(row.id),
			{ name: row.name, acronym: row.acronym },
		]),
	);
	const hourly = await loadCandleMap(60, 120);
	const fiveMinute = await loadCandleMap(5, 7);
	const daily = await loadCandleMap(1_440, 400);

	// Last known quotes give exits something to work with when the market fetch
	// fails or a partial response omits a held stock. Entries are gated on the
	// fresh-id set below, so a stale quote can close a position but never open
	// one.
	const marketById = new Map(market.map((stock) => [stock.id, stock]));
	for (const row of latest) {
		if (marketById.has(row.stockId)) continue;
		const price = Number(row.price);
		if (!Number.isFinite(price) || price <= 0) continue;
		const reference = stockReferenceById.get(row.stockId);
		marketById.set(row.stockId, {
			id: row.stockId,
			acronym: reference?.acronym ?? "",
			name: reference?.name ?? "",
			price,
			cap: Number(row.cap),
			shares: row.shares,
			investors: row.investors,
			history: [],
			performance: {},
		});
	}
	const featureMarket = [...marketById.values()];
	const freshStockIds = new Set(market.map((stock) => stock.id));
	const marketFetchOk = market.length > 0;

	const newest = latest.reduce(
		(latestAt, row) =>
			row.updatedAt && row.updatedAt > latestAt ? row.updatedAt : latestAt,
		new Date(0),
	);
	const dataAgeSeconds =
		newest.getTime() > 0
			? Math.max(0, Math.floor((Date.now() - newest.getTime()) / 1000))
			: null;

	/**
	 * Builds a feature map at one candle resolution. Reversal mode uses daily
	 * bars (the horizon the backtest validated); momentum mode keeps the hourly
	 * bars the original score was tuned on. Regime is applied per book in
	 * `runBook` from `regimeSmaDays`, which is why it is not baked in here.
	 */
	const buildFeatures = (
		candlesByStock: Map<number, CapitalCandle[]>,
		fallback: Map<number, CapitalCandle[]>,
	): Map<number, CapitalStockFeatures> => {
		const map = new Map<number, CapitalStockFeatures>();
		for (const stock of featureMarket) {
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
			if (features) map.set(stock.id, features);
		}
		return map;
	};

	const hourlyFeatures = buildFeatures(hourly, fiveMinute);
	const dailyFeatures = buildFeatures(daily, hourly);
	const stocksScored = Math.max(hourlyFeatures.size, dailyFeatures.size);
	const mlModel = await loadMlModel();

	// Market regime: an equal-weight index of the stored daily closes, compared
	// with its `regimeSmaDays`-day SMA. This is the setting that used to be
	// cosmetic; the engine previously used the median of 30-day returns.
	const marketIndex = buildMarketIndexCandles(daily);
	const regimeCache = new Map<number, boolean>();
	const regimeFor = (smaDays: number): boolean => {
		const cached = regimeCache.get(smaDays);
		if (cached !== undefined) return cached;
		const on = computeMarketRegime(marketIndex, smaDays).on;
		regimeCache.set(smaDays, on);
		return on;
	};

	const runId = crypto.randomUUID();
	const startedAt = new Date();
	let recommendations = 0;
	let paperFills = 0;
	const bookResults: Array<{
		book: CapitalBook;
		recommendations: number;
		paperFills: number;
		errors: string[];
		risk: BookRiskState;
		details: BookRunResult["details"];
	}> = [];
	// Expire recommendations nobody executed, for every selected book including
	// one whose engine is disabled: `getCapitalOrders(book, true)` filters by
	// status, so an old row would block that stock's entry and exit forever.
	for (const book of books) {
		try {
			const expired = await expireCapitalOrders(book);
			if (expired > 0) {
				logger.info(`${book}: expired ${expired} stale order(s).`);
			}
		} catch (error) {
			logger.warn(
				`${book}: order expiry failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const previousDetails = (state?.details ?? {}) as Record<string, unknown>;
	const previousRiskByBook =
		previousDetails.riskByBook && typeof previousDetails.riskByBook === "object"
			? (previousDetails.riskByBook as Record<string, unknown>)
			: null;
	const wasPaused = (book: CapitalBook): boolean => {
		const risk = previousRiskByBook?.[book];
		return (
			Boolean(risk) &&
			typeof risk === "object" &&
			(risk as { entriesPaused?: unknown }).entriesPaused === true
		);
	};
	for (const book of books) {
		try {
			const config = await getCapitalConfig(book);
			const result = await runBook(
				book,
				config,
				signalModeFor(config) === "reversal" ? dailyFeatures : hourlyFeatures,
				marketById,
				regimeFor(config.regimeSmaDays),
				freshStockIds,
				dataAgeSeconds,
				marketFetchOk,
				runId,
				mlModel,
			);
			recommendations += result.recommendations;
			paperFills += result.paperFills;
			errors.push(...result.errors);
			const pausedBefore = wasPaused(book);
			if (result.risk.entriesPaused && !pausedBefore) {
				broadcastRiskTransition({
					book,
					paused: true,
					reasons: result.risk.pauseReasons,
				});
			} else if (!result.risk.entriesPaused && pausedBefore) {
				broadcastRiskTransition({ book, paused: false, reasons: [] });
			}
			bookResults.push({
				book,
				recommendations: result.recommendations,
				paperFills: result.paperFills,
				errors: result.errors,
				risk: result.risk,
				details: result.details,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${book}: ${message}`);
			bookResults.push({
				book,
				recommendations: 0,
				paperFills: 0,
				errors: [message],
				risk: idleRisk(),
				details: {
					entriesAllowed: false,
					entryPauseReasons: [message],
					cooldownSkips: 0,
				},
			});
			logger.error(`Capital engine failed for ${book}:`, error);
		}
	}

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
			details: {
				runId,
				risk: result.risk,
				entriesAllowed: result.details.entriesAllowed,
				entryPauseReasons: result.details.entryPauseReasons,
				cooldownSkips: result.details.cooldownSkips,
			},
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
			riskByBook: Object.fromEntries(
				bookResults.map((result) => [result.book, result.risk]),
			),
			entryPausesByBook: Object.fromEntries(
				bookResults.map((result) => [result.book, result.details]),
			),
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

/**
 * One synchronous capital engine cycle. Exported for the smoke-test IPC
 * handler, which runs the paper book without waiting for the cron tick.
 *
 * A cross-process advisory lock makes the cron tick, the manual API trigger and
 * the smoke test mutually exclusive; a skipped cycle returns an error instead
 * of racing another one.
 */
export async function runCapitalEngineCycle(options?: {
	books?: CapitalBook[];
	trigger?: "schedule" | "manual" | "smoke";
}): Promise<EngineRunResult> {
	const lock = await tryAcquireCapitalEngineLock();
	if (!lock) {
		logger.warn("Capital engine cycle skipped: another cycle holds the lock.");
		return {
			stocksPolled: 0,
			stocksScored: 0,
			recommendations: 0,
			paperFills: 0,
			dataAgeSeconds: null,
			errors: ["Another capital engine cycle is already running; skipped."],
		};
	}
	try {
		return await runCapitalEngineCycleLocked(options);
	} finally {
		await lock.release();
	}
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
