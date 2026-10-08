// Type-only, and deliberately relative: `@sentinel/utils` is a leaf package with
// no workspace dependencies, so the shared contract is reached by path at compile
// time only — nothing from it can reach a bundle.
import type {
	StockBenefit,
	StockBenefitProgress,
	StockBenefitValuation,
	StockBlock,
	StockClosedTerm,
	StockHolding,
	StockPortfolioResponse,
	StockPortfolioTotals,
	StockReconciliation,
	StockResourceUnit,
	StockTerm,
	StockTermDividend,
	StockTermLot,
	StockTermSell,
} from "../../schemas/src/stocks";
import {
	catalogStock,
	STOCK_CATALOG,
	valueCatalogBenefit,
} from "./stock-catalog";

/**
 * Current-term stock portfolio analytics.
 *
 * THE ONE IDEA
 *
 * A stock holding is a *term*: it opens when the position goes from flat to
 * non-flat and closes when it goes back to flat. Everything a reader wants to
 * judge a holding — what was paid in, what has been collected, what it is worth
 * now, whether it was worth doing and whether doing more is worth it — only means
 * something inside the open term. A lifetime total silently blends a closed term
 * that has already been banked with the one still running, which is exactly the
 * "I bought Feathery Hotels, collected coupons, sold, came back a year later"
 * case that makes naive ROI nonsense.
 *
 * WHAT IT REPLAYS
 *
 * The personal log records the whole story for each stock: buys (5510), sells
 * (5511) including Torn's own realised profit, splits (5520) and merges (5521),
 * and every dividend (5530-5537) with the money, item or resource it paid. The
 * replay walks those events in order with average-cost accounting, so a partial
 * sell reduces the cost basis proportionally and a full sell closes the term.
 *
 * The live `/user/stocks` position is authoritative for the share count, and the
 * replay is only trusted when it lands on that same count; otherwise the
 * function says so (`reconciliation.reconciled === false`) and falls back to the
 * purchase list Torn reports alongside the position, rather than quietly
 * reporting a cost basis the logs cannot support.
 *
 * WHAT IT REFUSES TO DO
 *
 * Invent prices. Dividends paid in energy, nerve or happiness cannot be sold for
 * cash at any price, ammo packs and random properties have no single market price,
 * and passive benefits pay nothing at all. Those payouts carry `priced: false` and
 * contribute nothing to the money totals, and the response lists them so the
 * reader can see the shape of what is missing instead of reading a zero as "this
 * stock pays nothing". Points are the exception: they trade on the points market,
 * so they are priced at what it costs to buy one.
 *
 * WHAT ROI IS, AND IS NOT
 *
 * ROI is the return on capital committed to a position that can actually earn:
 * one complete benefit block, a priceable payout, and a known cost basis. A
 * passive block pays no dividend, and an active holding below its block size
 * accrues nothing, so neither has a stock return — reporting the share-price
 * movement as "ROI" for those would describe a return the stock never made. They
 * still show market value, unrealised movement and a flat income of zero.
 *
 * INCREMENTS ARE CUMULATIVE
 *
 * Each block costs twice the previous one ON TOP of the previous one, so `n`
 * blocks cost `(2^n − 1) × blockShares` shares. The catalogue's block table is
 * built on that: the block being worked toward starts at `(2^n − 1) × blockShares`
 * shares, which is what makes "I am 90% of the way to my second block" a number
 * this module can produce.
 */

const DAY_SECONDS = 86_400;
/** Shares are whole numbers; anything below this is float dust from a replay. */
const SHARE_EPSILON = 0.5;
/** Annualising a term younger than this says more about luck than about the stock. */
const MIN_DAYS_TO_ANNUALISE = 7;
/** Guards `2 ** increments` against a nonsense payload. */
const MAX_INCREMENTS = 20;

export const STOCK_BUY_LOG_ID = 5510;
export const STOCK_SELL_LOG_ID = 5511;
export const STOCK_SPLIT_LOG_ID = 5520;
export const STOCK_MERGE_LOG_ID = 5521;
/** Pre-2018 stock purchases and sales, logged as "listing add/remove". */
export const STOCK_LEGACY_BUY_LOG_ID = 5500;
export const STOCK_LEGACY_SELL_LOG_ID = 5501;
export const STOCK_DIVIDEND_LOG_IDS = [
	5530, 5531, 5532, 5533, 5534, 5535, 5536, 5537,
] as const;
export const STOCK_LOG_IDS: readonly number[] = [
	STOCK_BUY_LOG_ID,
	STOCK_SELL_LOG_ID,
	STOCK_SPLIT_LOG_ID,
	STOCK_MERGE_LOG_ID,
	STOCK_LEGACY_BUY_LOG_ID,
	STOCK_LEGACY_SELL_LOG_ID,
	...STOCK_DIVIDEND_LOG_IDS,
];

const DIVIDEND_LOG_ID_SET = new Set<number>(STOCK_DIVIDEND_LOG_IDS);

/** `*_increased` keys Torn uses when a dividend pays in a resource. */
const RESOURCE_KEYS: ReadonlyArray<readonly [string, StockResourceUnit]> = [
	["energy_increased", "energy"],
	["nerve_increased", "nerve"],
	["happy_increased", "happy"],
	["points_increased", "points"],
];

// ─── Payload narrowing ───────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function num(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

/** Like `num`, but distinguishes "absent" from "zero" — sells can legitimately report 0 profit. */
function optionalNum(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number.parseFloat(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function bool(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

// ─── Events ──────────────────────────────────────────────────────────────────

/** What a dividend actually paid, before it is priced. */
export type DividendPayment =
	| { kind: "cash"; amount: number }
	| { kind: "item"; itemId: number; quantity: number }
	| { kind: "resource"; unit: StockResourceUnit; quantity: number }
	| { kind: "unknown" };

export type StockEvent =
	| {
			kind: "buy";
			stockId: number;
			timestamp: number;
			logId: string;
			shares: number;
			worth: number;
			price: number;
	  }
	| {
			kind: "sell";
			stockId: number;
			timestamp: number;
			logId: string;
			shares: number;
			worth: number;
			price: number;
			fees: number;
			/** Torn's own realised profit for this sale, null when the log omits it. */
			profit: number | null;
	  }
	| {
			/**
			 * A stock split (5520) or merge (5521). `shares` is the RESULTING TOTAL
			 * share count, not a delta.
			 *
			 * Verified against every stock on a live account: replaying buys and sells
			 * with the split/merge totals assigned lands exactly on the share count
			 * Torn reports for 19 of 20 stocks (the twentieth is missing a buy log).
			 * Reading them as deltas instead leaves four positions impossible, one of
			 * them off by 1.2 million shares, which is how this was caught.
			 *
			 * These events move shares between the holding and a benefit block, in both
			 * directions, without any cash changing hands.
			 */
			kind: "split" | "merge";
			stockId: number;
			timestamp: number;
			logId: string;
			shares: number;
	  }
	| {
			kind: "dividend";
			stockId: number;
			timestamp: number;
			logId: string;
			payment: DividendPayment;
	  };

/** A personal log row, as much of it as this module needs. */
export interface StockLogRow {
	id: string;
	log: number;
	/** Unix seconds. */
	timestamp: number;
	data: unknown;
}

/**
 * Parses the `item` field of a dividend log. Torn has shipped all three shapes at
 * some point: `{"370": 1}`, a bare id, and `{id, quantity}`.
 */
function readItemPayload(
	value: unknown,
): { itemId: number; quantity: number } | null {
	const direct = optionalNum(value);
	if (direct !== null && direct > 0) {
		return { itemId: Math.trunc(direct), quantity: 1 };
	}

	const record = asRecord(value);
	if (!record) return null;

	const explicitId = optionalNum(record.id ?? record.item);
	if (explicitId !== null && explicitId > 0) {
		const quantity =
			optionalNum(record.quantity) ??
			optionalNum(record.amount) ??
			optionalNum(record.qty) ??
			1;
		return { itemId: Math.trunc(explicitId), quantity: Math.max(1, quantity) };
	}

	for (const [key, rawQuantity] of Object.entries(record)) {
		const itemId = Number.parseInt(key, 10);
		if (!Number.isFinite(itemId) || itemId <= 0) continue;
		const quantity = optionalNum(rawQuantity) ?? 1;
		return { itemId, quantity: Math.max(1, quantity) };
	}

	return null;
}

function readDividendPayment(inner: Record<string, unknown>): DividendPayment {
	const money = optionalNum(inner.money);
	if (money !== null && money > 0) {
		return { kind: "cash", amount: money };
	}

	const item = readItemPayload(inner.item);
	if (item) {
		return { kind: "item", itemId: item.itemId, quantity: item.quantity };
	}

	for (const [key, unit] of RESOURCE_KEYS) {
		const quantity = optionalNum(inner[key]);
		if (quantity !== null && quantity > 0) {
			return { kind: "resource", unit, quantity };
		}
	}

	return { kind: "unknown" };
}

/**
 * Normalises one personal log row into a portfolio event.
 *
 * The stored row may be the whole log envelope (`{details, data}`) or the inner
 * payload depending on which ingestion path wrote it, so both nestings are read —
 * the same tolerance the stocks ledger worker applies.
 */
export function normalizeStockLog(row: StockLogRow): StockEvent | null {
	const outer = asRecord(row.data);
	if (!outer) return null;
	const inner = asRecord(outer.data) ?? outer;

	const stockId = Math.trunc(num(inner.stock ?? outer.stock));
	if (stockId <= 0) return null;

	const timestamp = row.timestamp;
	const logId = row.id;

	switch (row.log) {
		case STOCK_BUY_LOG_ID:
		case STOCK_LEGACY_BUY_LOG_ID: {
			const shares = num(inner.amount);
			const worth = num(inner.worth);
			const price = num(inner.price);
			if (shares <= 0) return null;
			return {
				kind: "buy",
				stockId,
				timestamp,
				logId,
				shares,
				worth: worth > 0 ? worth : shares * price,
				price: price > 0 ? price : worth / shares,
			};
		}
		case STOCK_SELL_LOG_ID:
		case STOCK_LEGACY_SELL_LOG_ID: {
			const shares = num(inner.amount);
			if (shares <= 0) return null;
			return {
				kind: "sell",
				stockId,
				timestamp,
				logId,
				shares,
				worth: num(inner.worth),
				price: num(inner.price),
				fees: num(inner.fees),
				profit: optionalNum(inner.profit),
			};
		}
		case STOCK_SPLIT_LOG_ID:
		case STOCK_MERGE_LOG_ID: {
			const shares = num(inner.amount);
			if (shares <= 0) return null;
			return {
				kind: row.log === STOCK_SPLIT_LOG_ID ? "split" : "merge",
				stockId,
				timestamp,
				logId,
				shares,
			};
		}
		default: {
			if (!DIVIDEND_LOG_ID_SET.has(row.log)) return null;
			return {
				kind: "dividend",
				stockId,
				timestamp,
				logId,
				payment: readDividendPayment(inner),
			};
		}
	}
}

/** Buys are applied before sells when both land in the same second. */
const EVENT_RANK: Record<StockEvent["kind"], number> = {
	buy: 0,
	split: 1,
	merge: 2,
	sell: 3,
	dividend: 4,
};

function sortEvents(events: StockEvent[]): StockEvent[] {
	return events.sort((a, b) => {
		if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
		return EVENT_RANK[a.kind] - EVENT_RANK[b.kind];
	});
}

// ─── Replay ──────────────────────────────────────────────────────────────────

export interface StockReplayOptions {
	asOfSeconds: number;
	/** Dollar value already recorded for a dividend log id, when the ledger has one. */
	recordedDividendValues: ReadonlyMap<string, number>;
	/** Points-market price per point, used to value a points payout. */
	pointsPrice: number;
	itemPricesById: ReadonlyMap<number, number>;
	itemNamesById: ReadonlyMap<number, string>;
}

export interface StockReplay {
	shares: number;
	invested: number;
	costBasis: number;
	realized: number;
	termStart: number | null;
	lots: StockTermLot[];
	sells: StockTermSell[];
	dividends: StockTermDividend[];
	previousTerm: StockClosedTerm | null;
	/** Dividends found in the log that could not be attributed to the open term. */
	orphanDividendCount: number;
	/** A split or merge moved shares, so the average cost is an approximation. */
	adjustedBySplitOrMerge: boolean;
	/** Shares appeared with no purchase on record, so the basis is incomplete. */
	basisIncomplete: boolean;
}

function priceDividend(
	event: Extract<StockEvent, { kind: "dividend" }>,
	options: StockReplayOptions,
): StockTermDividend {
	const { payment } = event;
	if (payment.kind === "cash") {
		return {
			timestamp: event.timestamp,
			value: payment.amount,
			priced: true,
			kind: "cash",
		};
	}

	if (payment.kind === "item") {
		const recorded = options.recordedDividendValues.get(event.logId) ?? 0;
		const unitPrice = options.itemPricesById.get(payment.itemId) ?? 0;
		const value = recorded > 0 ? recorded : unitPrice * payment.quantity;
		return {
			timestamp: event.timestamp,
			value,
			priced: value > 0,
			kind: "item",
			itemId: payment.itemId,
			itemName: options.itemNamesById.get(payment.itemId),
			resourceQuantity: payment.quantity,
		};
	}

	if (payment.kind === "resource") {
		// Points trade on the points market, so they have a real price. Energy,
		// nerve and happiness cannot be sold for cash, so they stay unpriced rather
		// than being valued at whatever the reader guesses.
		const value =
			payment.unit === "points" && options.pointsPrice > 0
				? options.pointsPrice * payment.quantity
				: 0;
		return {
			timestamp: event.timestamp,
			value,
			priced: value > 0,
			kind: "resource",
			resourceUnit: payment.unit,
			resourceQuantity: payment.quantity,
		};
	}

	return { timestamp: event.timestamp, value: 0, priced: false, kind: "item" };
}

/**
 * Replays one stock's events and returns the open term plus the term it replaced.
 *
 * Average-cost accounting: a sale removes `sharesSold × (costBasis / shares)` from
 * the basis and banks Torn's recorded profit (falling back to
 * `proceeds − fees − costRemoved` when the log omits it). A full sale closes the
 * term and starts a clean slate, so the next buy opens a genuinely new one.
 */
export function replayStockEvents(
	events: readonly StockEvent[],
	options: StockReplayOptions,
): StockReplay {
	const ordered = sortEvents([...events]);

	let shares = 0;
	let invested = 0;
	let costBasis = 0;
	let realized = 0;
	let termStart: number | null = null;
	let lots: StockTermLot[] = [];
	let sells: StockTermSell[] = [];
	let dividends: StockTermDividend[] = [];
	let previousTerm: StockClosedTerm | null = null;
	let orphanDividendCount = 0;
	let adjustedBySplitOrMerge = false;
	let basisIncomplete = false;

	const closeTerm = (endTimestamp: number): void => {
		if (termStart !== null) {
			const dividendsValue = dividends.reduce((sum, d) => sum + d.value, 0);
			const profit = realized + dividendsValue;
			previousTerm = {
				start: termStart,
				end: endTimestamp,
				days: Math.max(0, (endTimestamp - termStart) / DAY_SECONDS),
				invested,
				profit,
				roiPct: invested > 0 ? (profit / invested) * 100 : null,
			};
		}
		shares = 0;
		invested = 0;
		costBasis = 0;
		realized = 0;
		termStart = null;
		lots = [];
		sells = [];
		dividends = [];
		// These describe the open term, so they reset with it.
		adjustedBySplitOrMerge = false;
		basisIncomplete = false;
	};

	for (const event of ordered) {
		switch (event.kind) {
			case "buy": {
				if (termStart === null) termStart = event.timestamp;
				shares += event.shares;
				invested += event.worth;
				costBasis += event.worth;
				lots.push({
					timestamp: event.timestamp,
					shares: event.shares,
					price: event.price,
					worth: event.worth,
				});
				break;
			}

			case "sell": {
				// Selling shares the log never showed being bought (a position that
				// predates the log archive) carries no basis to remove.
				if (shares <= SHARE_EPSILON) break;

				const sold = Math.min(event.shares, shares);
				const averageCost = costBasis / shares;
				const costRemoved = averageCost * sold;
				const derivedProfit = event.worth - event.fees - costRemoved;
				const loggedProfit = event.profit;
				const realizedHere = loggedProfit ?? derivedProfit;

				realized += realizedHere;
				costBasis = Math.max(0, costBasis - costRemoved);
				shares -= sold;
				sells.push({
					timestamp: event.timestamp,
					shares: sold,
					proceeds: event.worth,
					fees: event.fees,
					realized: realizedHere,
					fromLog: loggedProfit !== null,
				});

				if (shares <= SHARE_EPSILON) closeTerm(event.timestamp);
				break;
			}

			case "split":
			case "merge": {
				// The log reports the resulting total, and no cash moves, so the
				// average cost per share is preserved: shares entering the holding are
				// treated as costing what the existing ones cost, and shares leaving it
				// take their share of the basis with them. Recognising either direction
				// as profit would invent a gain the account never received.
				const newTotal = Math.max(0, event.shares);
				const delta = newTotal - shares;
				if (Math.abs(delta) > SHARE_EPSILON) {
					if (shares > SHARE_EPSILON) {
						const averageCost = costBasis / shares;
						costBasis = Math.max(0, costBasis + delta * averageCost);
					} else if (delta > 0) {
						// Shares appearing with no purchase on record: no basis can be
						// attributed to them, which is reported rather than hidden.
						basisIncomplete = true;
					}
					shares = newTotal;
					adjustedBySplitOrMerge = true;
				}
				break;
			}

			case "dividend": {
				if (termStart === null) {
					orphanDividendCount++;
					break;
				}
				dividends.push(priceDividend(event, options));
				break;
			}
		}
	}

	return {
		shares,
		invested,
		costBasis,
		realized,
		termStart,
		lots,
		sells,
		dividends,
		previousTerm,
		orphanDividendCount,
		adjustedBySplitOrMerge,
		basisIncomplete,
	};
}

/**
 * Prices every dividend collected since a timestamp.
 *
 * Used directly rather than read off the replay whenever the term start comes
 * from somewhere other than the log replay, so a term reconstructed from Torn's
 * purchase list still shows the dividends it collected.
 */
export function collectDividends(
	events: readonly StockEvent[],
	since: number | null,
	options: StockReplayOptions,
): StockTermDividend[] {
	const dividends: StockTermDividend[] = [];
	for (const event of events) {
		if (event.kind !== "dividend") continue;
		if (since !== null && event.timestamp < since) continue;
		dividends.push(priceDividend(event, options));
	}
	return dividends.sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Fallback: the purchase list Torn reports with the position ──────────────

export interface TransactionLot {
	timestamp: number;
	shares: number;
	price: number;
	worth: number;
}

/**
 * Reads `/user/stocks`' `transactions` array into purchase lots.
 *
 * Those entries are purchases with a price and a timestamp; they are the second
 * best source for a cost basis and are used only when the log replay cannot
 * support the live share count.
 */
export function readTransactionLots(transactions: unknown): TransactionLot[] {
	const list = Array.isArray(transactions)
		? transactions
		: asRecord(transactions)
			? Object.values(transactions as Record<string, unknown>)
			: [];
	const lots: TransactionLot[] = [];

	for (const entry of list) {
		const record = asRecord(entry);
		if (!record) continue;
		const shares = num(record.shares);
		const price = num(record.price);
		const timestamp = Math.trunc(num(record.timestamp));
		if (shares <= 0) continue;
		const worth = optionalNum(record.worth) ?? shares * price;
		lots.push({ timestamp, shares, price, worth });
	}

	return lots.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Cost basis of the shares still held, treating the most recent purchases as the
 * ones that survived (FIFO consumption), which is the only defensible reading when
 * only purchases are on record.
 */
export function lotsForHeldShares(
	lots: readonly TransactionLot[],
	heldShares: number,
): { lots: TransactionLot[]; costBasis: number; completed: boolean } {
	const total = lots.reduce((sum, lot) => sum + lot.shares, 0);
	if (total <= heldShares) {
		return {
			lots: [...lots],
			costBasis: lots.reduce((sum, lot) => sum + lot.worth, 0),
			completed: Math.abs(total - heldShares) <= SHARE_EPSILON,
		};
	}

	const kept: TransactionLot[] = [];
	let remaining = heldShares;
	for (let i = lots.length - 1; i >= 0 && remaining > SHARE_EPSILON; i--) {
		const lot = lots[i];
		if (!lot) continue;
		const take = Math.min(lot.shares, remaining);
		kept.unshift({
			timestamp: lot.timestamp,
			shares: take,
			price: lot.price,
			worth: take * lot.price,
		});
		remaining -= take;
	}

	return {
		lots: kept,
		costBasis: kept.reduce((sum, lot) => sum + lot.worth, 0),
		completed: true,
	};
}

// ─── Benefit resolution ──────────────────────────────────────────────────────

/** A stock row as stored by the reference sync, or as supplied live. */
export interface StockReferenceRow {
	stockId: number;
	name: string;
	acronym: string;
	price: number;
	requirementShares?: number | null;
	passive?: boolean | null;
	frequencyDays?: number | null;
	description?: string | null;
}

export interface BenefitPricingContext {
	pointsPrice: number;
	itemPricesById: ReadonlyMap<number, number>;
	itemPricesByName: ReadonlyMap<string, number>;
}

/**
 * Merges Torn's live stock record with the catalogue.
 *
 * Torn wins on anything it actually reports (a refresh of the row beats a
 * hardcoded copy), the catalogue supplies the valuation and fills any gap, and a
 * stock present in neither is reported as unpriceable rather than assumed.
 */
export function resolveStockBenefit(
	stockId: number,
	reference: StockReferenceRow | undefined,
	pricing: BenefitPricingContext,
): StockBenefit {
	const catalog = catalogStock(stockId);
	const requirementShares =
		reference?.requirementShares && reference.requirementShares > 0
			? reference.requirementShares
			: (catalog?.requirementShares ?? 0);
	const passive =
		typeof reference?.passive === "boolean"
			? reference.passive
			: (catalog?.passive ?? false);
	const frequencyDays = passive
		? 7
		: reference?.frequencyDays && reference.frequencyDays > 0
			? reference.frequencyDays
			: (catalog?.frequencyDays ?? 7);
	const description =
		reference?.description?.trim() ||
		catalog?.description ||
		"Benefit not described";

	const source: StockBenefit["source"] =
		reference?.requirementShares && reference.description ? "torn" : "catalog";

	if (!catalog) {
		// A stock Torn has added but this build has never heard of. Calling the
		// payout passive is the safe reading: it contributes no money to any total
		// and says so, instead of inventing a cash figure.
		const valuation: StockBenefitValuation = {
			kind: "passive",
			valuePerCycle: 0,
			priced: false,
			pricingNote:
				"This stock is not in the benefit catalogue yet, so its payout cannot be priced.",
		};
		return {
			kind: valuation.kind,
			passive,
			frequencyDays: passive ? null : frequencyDays,
			requirementShares,
			description,
			increments: 0,
			source,
			valuation,
			maxIncrements: null,
		};
	}

	const valuation = valueCatalogBenefit(
		catalog.valuation,
		pricing.pointsPrice,
		pricing.itemPricesById,
		pricing.itemPricesByName,
	);

	return {
		kind: valuation.kind,
		passive,
		frequencyDays: passive ? null : frequencyDays,
		requirementShares,
		description,
		increments: 0,
		source,
		valuation,
		maxIncrements: catalog.maxIncrements ?? null,
		note: catalog.note,
	};
}

// ─── Progress toward the next payout ─────────────────────────────────────────

interface TornBonus {
	available: boolean | null;
	increment: number | null;
	progress: number | null;
	frequency: number | null;
}

function readTornBonus(bonus: unknown): TornBonus {
	const record = asRecord(bonus);
	return {
		available: record ? bool(record.available) : null,
		increment: record ? optionalNum(record.increment) : null,
		progress: record ? optionalNum(record.progress) : null,
		frequency: record ? optionalNum(record.frequency) : null,
	};
}

export function buildBenefitProgress(input: {
	bonus: TornBonus;
	benefit: StockBenefit;
	shares: number;
	daysHeld: number | null;
	lastDividendAt: number | null;
	asOfSeconds: number;
}): StockBenefitProgress | null {
	const { bonus, benefit, shares, daysHeld, lastDividendAt, asOfSeconds } =
		input;
	const inactive =
		benefit.requirementShares > 0 && shares < benefit.requirementShares;

	if (benefit.passive) {
		const holdDays = daysHeld ?? 0;
		const reportedDays = bonus.progress ?? holdDays;
		// Torn reports `available: true` once a passive block has been held for its
		// week; when it reports nothing, fall back to the hold clock we replayed.
		const active =
			bonus.available === true ? !inactive : !inactive && reportedDays >= 7;
		const daysUntil = active ? null : Math.max(0, Math.ceil(7 - reportedDays));
		return {
			available: active,
			frequencyDays: 7,
			days: reportedDays,
			daysUntil,
			passiveActive: active,
			note: inactive
				? "Below the block size, so the passive benefit is not active."
				: active
					? "Passive benefit active."
					: `Activates after 7 days of holding (${daysUntil}d to go).`,
		};
	}

	const frequency = benefit.frequencyDays ?? bonus.frequency ?? 7;
	if (frequency <= 0) return null;

	let progressed = bonus.progress;
	let estimated = false;
	if (progressed === null && lastDividendAt !== null) {
		// No progress reported by Torn: estimate from when the last dividend landed.
		progressed = Math.max(
			0,
			Math.min(frequency, (asOfSeconds - lastDividendAt) / DAY_SECONDS),
		);
		estimated = true;
	}
	const days = progressed ?? null;
	const available = bonus.available ?? false;
	const daysUntil =
		days === null
			? null
			: available
				? 0
				: Math.max(0, Math.ceil(frequency - days));

	return {
		available,
		frequencyDays: frequency,
		days,
		daysUntil,
		passiveActive: null,
		note: available
			? "Dividend ready: collect it before the next midnight cron or the cycle does not advance."
			: estimated
				? "Estimated from the last dividend; Torn has not reported progress for this position."
				: inactive
					? "Below the block size, so no dividend is accruing."
					: undefined,
	};
}

// ─── Torn payload readers ────────────────────────────────────────────────────

/** A position as `/user/stocks` reports it. */
export interface UserStockPosition {
	stockId: number;
	shares: number;
	transactions: unknown;
	bonus: unknown;
}

/**
 * Reads `/user?selections=stocks`. Torn has returned this both as an array and as
 * an object keyed by stock id, and the stored `user_stocks` rows carry the same
 * per-stock shape, so one reader serves both.
 */
export function readUserStocksPayload(payload: unknown): UserStockPosition[] {
	const record = asRecord(payload);
	const raw = record ? (record.stocks ?? payload) : payload;
	const list: unknown[] = Array.isArray(raw)
		? raw
		: asRecord(raw)
			? Object.values(raw as Record<string, unknown>)
			: [];

	const positions: UserStockPosition[] = [];
	for (const entry of list) {
		const item = asRecord(entry);
		if (!item) continue;
		const stockId = Math.trunc(num(item.id ?? item.stock_id));
		if (stockId <= 0) continue;
		positions.push({
			stockId,
			shares: Math.trunc(num(item.shares)),
			transactions: item.transactions ?? null,
			bonus: item.bonus ?? null,
		});
	}

	return positions;
}

/**
 * Reads `GET /torn/stocks` (or the `stocks` selection of `GET /torn`) into the
 * shape the portfolio engine prices from.
 */
export function readTornStocksPayload(payload: unknown): StockReferenceRow[] {
	const record = asRecord(payload);
	const raw = record ? (record.stocks ?? payload) : payload;
	const list: unknown[] = Array.isArray(raw)
		? raw
		: asRecord(raw)
			? Object.values(raw as Record<string, unknown>)
			: [];

	const stocks: StockReferenceRow[] = [];
	for (const entry of list) {
		const item = asRecord(entry);
		if (!item) continue;
		const stockId = Math.trunc(num(item.id));
		if (stockId <= 0) continue;

		const market = asRecord(item.market);
		const bonus = asRecord(item.bonus);
		const frequency = bonus ? optionalNum(bonus.frequency) : null;

		stocks.push({
			stockId,
			name: typeof item.name === "string" ? item.name : `Stock ${stockId}`,
			acronym: typeof item.acronym === "string" ? item.acronym : "",
			price: market ? num(market.price) : 0,
			requirementShares: bonus ? optionalNum(bonus.requirement) : null,
			passive: bonus ? bool(bonus.passive) : null,
			frequencyDays: frequency,
			description:
				bonus && typeof bonus.description === "string"
					? bonus.description
					: null,
		});
	}

	return stocks;
}

// ─── Portfolio assembly ──────────────────────────────────────────────────────

export interface StockHoldingInput {
	stockId: number;
	shares: number;
	transactions: unknown;
	bonus: unknown;
	updatedAt: string | null;
}

export interface StockPortfolioInput {
	asOfSeconds: number;
	holdings: readonly StockHoldingInput[];
	events: readonly StockEvent[];
	/** Dollar values the ledger already recorded, keyed by dividend log id. */
	recordedDividendValues: ReadonlyMap<string, number>;
	stocks: readonly StockReferenceRow[];
	/** Points-market price per point; 0 leaves points payouts unpriced. */
	pointsPrice?: number;
	itemPricesById: ReadonlyMap<number, number>;
	itemPricesByName: ReadonlyMap<string, number>;
	itemNamesById?: ReadonlyMap<number, string>;
	positionAsOfIso?: string | null;
	pricesAsOfIso?: string | null;
}

/** How many increments of one stock the block table lists. */
const MAX_BLOCK_ROWS = 4;
/** Blocks already held, plus the one being worked toward and the one after it. */
const BLOCK_ROWS_AHEAD = 2;

/**
 * Shares needed to hold `increments` complete blocks.
 *
 * Increments are cumulative and each costs double the last: one block is `B`
 * shares, two is `B + 2B = 3B`, three is `7B`, and so on. This is why "shares ÷
 * block size" is the wrong way to count blocks — 6,000,000 of a 2,000,000-share
 * block is two increments, not three.
 */
export function sharesForIncrements(
	blockShares: number,
	increments: number,
): number {
	if (blockShares <= 0 || increments <= 0) return 0;
	return (2 ** Math.min(increments, MAX_INCREMENTS) - 1) * blockShares;
}

/**
 * Complete increments a share count supports: the largest `n` with
 * `(2^n − 1) × blockShares ≤ shares`.
 */
export function incrementsFromShares(
	shares: number,
	blockShares: number,
): number {
	if (blockShares <= 0 || shares < blockShares) return 0;
	const ratio = shares / blockShares + 1;
	const derived = Math.floor(Math.log2(ratio) + 1e-9);
	return Math.max(0, Math.min(derived, MAX_INCREMENTS));
}

/** Annual income of one block paying `valuePerCycle` every `frequencyDays`. */
function annualIncomeOf(
	valuation: StockBenefitValuation,
	frequencyDays: number | null,
): number | null {
	if (!valuation.priced || !frequencyDays || frequencyDays <= 0) return null;
	return valuation.valuePerCycle * (365 / frequencyDays);
}

/**
 * Annualised return of buying one more block, as a percentage.
 *
 * Each increment pays its own dividend, so the payout of the next block is one
 * cycle's benefit while its cost doubles with every block already held. That
 * spread — constant payout, doubling cost — is the whole reason a second block is
 * usually a worse deal than the first. Null when the payout has no dollar figure,
 * when the block is capped, or when there is no price to cost it at.
 */
function forwardAprPct(
	benefit: StockBenefit,
	blockShares: number,
	price: number,
	increments: number,
): { aprPct: number | null; note?: string } {
	if (benefit.passive) {
		return { aprPct: null, note: "A passive block pays no dividend." };
	}
	if (benefit.maxIncrements !== null && increments >= benefit.maxIncrements) {
		return {
			aprPct: null,
			note: `Capped at ${benefit.maxIncrements} blocks; no further increment can be bought.`,
		};
	}
	if (blockShares <= 0 || price <= 0) {
		return {
			aprPct: null,
			note: "No share price on record to cost the block at.",
		};
	}
	const annualIncome = annualIncomeOf(benefit.valuation, benefit.frequencyDays);
	if (annualIncome === null) {
		return {
			aprPct: null,
			note: (
				benefit.valuation.pricingNote ?? "This payout has no dollar value."
			).replace(/\.?$/, "."),
		};
	}
	const cost = blockShares * 2 ** Math.min(increments, MAX_INCREMENTS) * price;
	if (cost <= 0) return { aprPct: null, note: "No share price on record." };
	return { aprPct: (annualIncome / cost) * 100 };
}

/** One line describing what a payout is, e.g. "1× Drug Pack" or "100 points". */
export function describePayout(benefit: StockBenefit): string {
	const { valuation } = benefit;
	if (valuation.kind === "cash" && valuation.cashPerCycle) {
		return `$${valuation.cashPerCycle.toLocaleString("en-US")}`;
	}
	if (valuation.kind === "resource" && valuation.resourceUnit) {
		return `${(valuation.resourceQuantity ?? 0).toLocaleString("en-US")} ${valuation.resourceUnit}`;
	}
	if (valuation.kind === "item" && valuation.itemName) {
		return `${valuation.itemQuantity ?? 1}× ${valuation.itemName}`;
	}
	if (valuation.kind === "passive") return "Passive — no dividend";
	return benefit.description;
}

/**
 * Builds the per-increment rows for one stock: the block being worked toward,
 * the blocks already held, and the next couple of blocks after that.
 *
 * `nextToBuyAprPct` is set on exactly one row — the block a purchase can advance
 * right now — and is computed against the cash still outstanding rather than the
 * whole block, so a block that is 90% bought reads as the cheapest way to buy
 * income today rather than as an almost-finished also-ran.
 */
function buildStockBlocks(input: {
	stockId: number;
	name: string;
	acronym: string;
	benefit: StockBenefit;
	price: number;
	shares: number;
	increments: number;
}): StockBlock[] {
	const { stockId, name, acronym, benefit, price, shares, increments } = input;
	const blockShares = benefit.requirementShares;
	const payoutValue = benefit.valuation.priced
		? benefit.valuation.valuePerCycle
		: null;
	const annualIncome = annualIncomeOf(benefit.valuation, benefit.frequencyDays);
	const capped =
		benefit.maxIncrements !== null && increments >= benefit.maxIncrements;
	const payoutLabel = describePayout(benefit);

	// Nothing to list when the game does not say how many shares a block needs.
	if (blockShares <= 0) {
		return [];
	}

	// A capped stock has no buyable increment left, so only the blocks held are
	// listed rather than rows nobody could ever purchase.
	const rowsAhead = capped ? 0 : BLOCK_ROWS_AHEAD;
	const lastRow = Math.min(MAX_BLOCK_ROWS, Math.max(1, increments + rowsAhead));
	const blocks: StockBlock[] = [];

	for (let increment = 1; increment <= lastRow; increment++) {
		const blockSize = blockShares * 2 ** (increment - 1);
		const held = increments >= increment;
		const heldBefore = sharesForIncrements(blockShares, increment - 1);
		const sharesHeld = Math.max(0, Math.min(blockSize, shares - heldBefore));
		const sharesRemaining = held ? 0 : blockSize - sharesHeld;
		const cost = price > 0 ? blockSize * price : null;
		const costRemaining =
			price > 0 && sharesRemaining > 0 ? sharesRemaining * price : null;

		// The one block a purchase can advance: the next unbought increment.
		const actionable = increment === increments + 1;
		const nextToBuyAprPct =
			actionable && annualIncome !== null && costRemaining !== null
				? (annualIncome / costRemaining) * 100
				: null;

		blocks.push({
			stockId,
			name,
			acronym,
			increment,
			shares: blockSize,
			blockShares,
			price,
			cost,
			frequencyDays: benefit.frequencyDays,
			payoutValue,
			payoutLabel,
			payoutNote: benefit.valuation.priced
				? benefit.note
				: benefit.valuation.pricingNote,
			annualIncome,
			annualizedAprPct:
				annualIncome !== null && cost !== null && cost > 0
					? (annualIncome / cost) * 100
					: null,
			sharesHeld,
			progressPct: (sharesHeld / blockSize) * 100,
			sharesRemaining,
			costRemaining,
			nextToBuyAprPct,
			held,
			capped,
			passive: benefit.passive,
			benefit: { ...benefit, increments },
		});
	}

	return blocks;
}

export function computeStockPortfolio(
	input: StockPortfolioInput,
): StockPortfolioResponse {
	const {
		asOfSeconds,
		holdings,
		events,
		recordedDividendValues,
		stocks,
		pointsPrice = 0,
		itemPricesById,
		itemPricesByName,
		itemNamesById = new Map<number, string>(),
	} = input;

	const pricesAsOfIso = input.pricesAsOfIso ?? null;
	const referenceById = new Map<number, StockReferenceRow>();
	for (const stock of stocks) {
		if (stock.price > 0 || stock.requirementShares) {
			referenceById.set(stock.stockId, stock);
		}
	}

	const eventsByStock = new Map<number, StockEvent[]>();
	for (const event of events) {
		const bucket = eventsByStock.get(event.stockId);
		if (bucket) {
			bucket.push(event);
		} else {
			eventsByStock.set(event.stockId, [event]);
		}
	}

	const replayOptions: StockReplayOptions = {
		asOfSeconds,
		recordedDividendValues,
		pointsPrice,
		itemPricesById,
		itemNamesById,
	};

	const portfolioWarnings: string[] = [];
	const holdingsOut: StockHolding[] = [];

	for (const holding of holdings) {
		const shares = Math.max(0, Math.trunc(holding.shares));
		if (shares <= 0) continue;

		const reference = referenceById.get(holding.stockId);
		const benefit = resolveStockBenefit(holding.stockId, reference, {
			pointsPrice,
			itemPricesById,
			itemPricesByName,
		});
		const price = reference?.price ?? 0;
		const stockEvents = eventsByStock.get(holding.stockId) ?? [];
		const replay = replayStockEvents(stockEvents, replayOptions);
		const bonus = readTornBonus(holding.bonus);
		// Torn only bumps `increment` on payout day, so a fresh purchase can be
		// ahead of it; and a holding that dropped below a block can lag behind it.
		// Taking the larger of the two is right in both directions: shares justify at
		// least this many blocks, and Torn confirms at least that many are live.
		//
		// The derivation counts CUMULATIVE increments, not `shares ÷ blockShares`:
		// two 2,000,000-share blocks of FHG cost 6,000,000 shares, not 4,000,000, so
		// 6,000,000 shares is two increments however tempting the division is.
		const derivedIncrements = incrementsFromShares(
			shares,
			benefit.requirementShares,
		);
		const increments = Math.max(
			0,
			Math.trunc(bonus.increment ?? 0),
			derivedIncrements,
		);
		const warnings: string[] = [];

		// ── Which cost basis to trust ────────────────────────────────────────
		let term: StockTerm;
		let reconciliation: StockReconciliation;
		const replayMatches = Math.abs(replay.shares - shares) <= SHARE_EPSILON;

		const transactionLots = readTransactionLots(holding.transactions);
		const transactionTotal = transactionLots.reduce(
			(sum, lot) => sum + lot.shares,
			0,
		);
		// Usable when the purchase list can account for every share held: either it
		// matches exactly, or it records more than is held (shares were sold, and
		// FIFO keeps the most recent lots).
		const transactionsMatch =
			transactionTotal > 0 &&
			(Math.abs(transactionTotal - shares) <= SHARE_EPSILON ||
				transactionTotal > shares);

		if (stockEvents.length === 0 || !replayMatches) {
			if (transactionLots.length > 0 && transactionsMatch) {
				if (stockEvents.length > 0) {
					warnings.push(
						`Log replay lands on ${Math.round(replay.shares).toLocaleString()} shares but Torn reports ${shares.toLocaleString()}; the cost basis below comes from the purchase list instead. Sales before the log archive are not counted.`,
					);
				}
				const held = lotsForHeldShares(transactionLots, shares);
				const termStart = held.lots[0]?.timestamp ?? null;
				// Priced straight from the dividend events: this term start does not
				// come from the replay, so the replay's own window does not apply.
				const dividendsSince = collectDividends(
					stockEvents,
					termStart,
					replayOptions,
				);
				const costBasis = held.costBasis;
				term = {
					start: termStart,
					days:
						termStart === null
							? null
							: Math.max(0, (asOfSeconds - termStart) / DAY_SECONDS),
					invested: costBasis,
					costBasis,
					realized: 0,
					dividendsValue: dividendsSince.reduce((sum, d) => sum + d.value, 0),
					dividendsCount: dividendsSince.length,
					dividendsUnpriced: dividendsSince.filter((d) => !d.priced).length,
					dividends: dividendsSince,
					lots: held.lots.map((lot) => ({
						timestamp: lot.timestamp,
						shares: lot.shares,
						price: lot.price,
						worth: lot.worth,
					})),
					sells: [],
				};
				reconciliation = {
					source: "transactions",
					reconciled: held.completed,
					replayedShares: replay.shares,
					note: "Cost basis taken from Torn's purchase list.",
				};
			} else {
				// Nothing can support a basis: report the position without pretending.
				const dividends = collectDividends(stockEvents, null, replayOptions);
				term = {
					start: null,
					days: null,
					invested: 0,
					costBasis: 0,
					realized: 0,
					dividendsValue: dividends.reduce((sum, d) => sum + d.value, 0),
					dividendsCount: dividends.length,
					dividendsUnpriced: dividends.filter((d) => !d.priced).length,
					dividends,
					lots: [],
					sells: [],
				};
				reconciliation = {
					source: "none",
					reconciled: false,
					replayedShares: stockEvents.length > 0 ? replay.shares : null,
					note: "No purchase records and no log history for this position, so no cost basis could be established.",
				};
				warnings.push(
					"No purchase history is on record for this position; cost basis, profit and ROI are unavailable.",
				);
			}
		} else {
			term = {
				start: replay.termStart,
				days:
					replay.termStart === null
						? null
						: Math.max(0, (asOfSeconds - replay.termStart) / DAY_SECONDS),
				invested: replay.invested,
				costBasis: replay.costBasis,
				realized: replay.realized,
				dividendsValue: replay.dividends.reduce((sum, d) => sum + d.value, 0),
				dividendsCount: replay.dividends.length,
				dividendsUnpriced: replay.dividends.filter((d) => !d.priced).length,
				dividends: replay.dividends,
				lots: replay.lots,
				sells: replay.sells,
			};
			reconciliation = {
				source: "logs",
				reconciled: true,
				replayedShares: replay.shares,
				basisIncomplete: replay.basisIncomplete,
			};
		}

		// ── Mark to market ──────────────────────────────────────────────────
		//
		// Without a cost basis there is no such thing as unrealised profit: the
		// whole position would read as gain, which is worse than reporting nothing.
		// The same applies when only part of the basis is known — a diluted average
		// cost turns unknown shares into apparent profit.
		const basisKnown =
			reconciliation.source !== "none" && !reconciliation.basisIncomplete;
		const marketValue = price > 0 ? shares * price : 0;
		const unrealized =
			price > 0 && basisKnown ? marketValue - term.costBasis : 0;
		const profit = term.realized + term.dividendsValue + unrealized;
		const invested = term.invested;
		const hasBasis = invested > 0;

		// ── Is there a stock return to measure at all? ───────────────────────
		//
		// Four things have to hold before "ROI" describes anything a stock did:
		// a cost basis, a share price, a payout with a dollar figure, and at least
		// one COMPLETE block. A passive block pays no dividend, an active holding
		// below its block size accrues nothing, and an ammo pack or an unknown
		// payout cannot be valued — so for all three the only thing left in `profit`
		// is share-price movement, and calling that a stock ROI was exactly the bug
		// that put a return on TCP, TGP and a part-built FHG.
		const earns =
			increments >= 1 && !benefit.passive && benefit.valuation.priced;
		const measurable = hasBasis && price > 0 && basisKnown && earns;
		const roiPct = measurable ? (profit / invested) * 100 : null;

		let roiNote: string | undefined;
		if (roiPct === null) {
			roiNote = reconciliation.basisIncomplete
				? "Part of this position carries no cost basis, so no ROI is claimed."
				: reconciliation.source === "none"
					? "No cost basis on record, so no ROI to measure."
					: !hasBasis
						? "Nothing invested in the open term."
						: price <= 0
							? "No share price on record, so the position cannot be marked to market."
							: benefit.passive
								? "A passive block pays no dividend, so there is no stock return to measure."
								: increments <= 0
									? `Below one block: ${shares.toLocaleString()} of ${benefit.requirementShares.toLocaleString()} shares, so no dividend is accruing and no stock return exists yet.`
									: (benefit.valuation.pricingNote ??
										"This payout has no dollar value, so no ROI is claimed.");
		}

		let annualizedRoiPct: number | null = null;
		let annualizedNote: string | undefined;
		if (roiPct === null) {
			annualizedNote = roiNote;
		} else if (term.days === null || term.days < MIN_DAYS_TO_ANNUALISE) {
			annualizedNote = `Term is under ${MIN_DAYS_TO_ANNUALISE} days old; annualising it would be noise.`;
		} else if (roiPct <= -100) {
			annualizedNote =
				"Position is down more than everything invested; not annualised.";
		} else {
			const growth = 1 + roiPct / 100;
			annualizedRoiPct = (growth ** (365 / term.days) - 1) * 100;
		}

		const daysHeld = term.days;
		const lastDividendAt =
			term.dividends.length > 0
				? (term.dividends[term.dividends.length - 1]?.timestamp ?? null)
				: null;

		const progress = buildBenefitProgress({
			bonus,
			benefit,
			shares,
			daysHeld,
			lastDividendAt,
			asOfSeconds,
		});

		if (benefit.requirementShares > 0 && shares < benefit.requirementShares) {
			warnings.push(
				`Holding ${shares.toLocaleString()} of the ${benefit.requirementShares.toLocaleString()} shares in one block: no dividend is accruing and no passive benefit is active.`,
			);
		}
		if (term.dividendsUnpriced > 0) {
			warnings.push(
				`${term.dividendsUnpriced} dividend${term.dividendsUnpriced === 1 ? "" : "s"} in this term carry no dollar figure, so profit understates the return.`,
			);
		}
		if (term.sells.some((s) => !s.fromLog)) {
			warnings.push(
				"At least one sale reported no realised profit, so it was derived from average cost.",
			);
		}
		if (transactionLots.some((lot) => lot.price <= 0)) {
			// Torn leaves the price at zero on some older purchases; those shares add
			// market value without adding basis, so the profit below is too generous.
			warnings.push(
				"At least one recorded purchase has no price, so the cost basis — and therefore the profit — is approximate.",
			);
		}
		if (replay.orphanDividendCount > 0 && stockEvents.length > 0) {
			warnings.push(
				`${replay.orphanDividendCount} dividend${replay.orphanDividendCount === 1 ? "" : "s"} were collected outside the open term and are excluded.`,
			);
		}
		if (replay.adjustedBySplitOrMerge) {
			warnings.push(
				"A stock split or merge moved shares in or out of this holding without cash changing hands; the average cost is an approximation because of it.",
			);
		}
		if (replay.basisIncomplete) {
			warnings.push(
				"Shares appeared without a matching purchase in the log, so some of this position carries no cost basis and profit is overstated.",
			);
		}
		if (!benefit.valuation.priced && benefit.valuation.pricingNote) {
			warnings.push(benefit.valuation.pricingNote);
		}

		const stockBenefit: StockBenefit = { ...benefit, increments };
		const forward = forwardAprPct(
			stockBenefit,
			stockBenefit.requirementShares,
			price,
			increments,
		);

		// Progress toward the block being worked toward, on the cumulative model: it
		// starts at (2^n − 1) × blockShares shares and needs 2^n × blockShares more.
		const nextBlockShares =
			stockBenefit.requirementShares *
			2 ** Math.min(increments, MAX_INCREMENTS);
		const sharesIntoNextBlock = Math.max(
			0,
			Math.min(
				nextBlockShares,
				shares -
					sharesForIncrements(stockBenefit.requirementShares, increments),
			),
		);
		const sharesToNextBlock = Math.max(
			0,
			nextBlockShares - sharesIntoNextBlock,
		);

		const catalogRow = catalogStock(holding.stockId);
		holdingsOut.push({
			stockId: holding.stockId,
			name: reference?.name || catalogRow?.name || `Stock ${holding.stockId}`,
			acronym: reference?.acronym || catalogRow?.acronym || "?",
			shares,
			blockShares: stockBenefit.requirementShares,
			increments,
			nextBlockShares,
			sharesToNextBlock,
			nextBlockProgressPct:
				nextBlockShares > 0 ? (sharesIntoNextBlock / nextBlockShares) * 100 : 0,
			price,
			marketValue,
			avgCost: shares > 0 ? term.costBasis / shares : 0,
			term,
			previousTerm: replay.previousTerm,
			unrealized,
			income: term.dividendsValue,
			profit,
			roiPct,
			roiNote,
			annualizedRoiPct,
			annualizedNote,
			nextBlockAprPct: forward.aprPct,
			nextBlockNote: forward.note,
			benefit: stockBenefit,
			progress,
			reconciliation,
			warnings,
		});
	}

	// ── Totals ──────────────────────────────────────────────────────────────
	//
	// Two different sets on purpose. Every position's money is summed (invested,
	// value, income, profit), but ROI is taken only over positions that can earn:
	// a complete, priceable block with a known basis. Averaging a passive block or
	// a half-built one into it would report a stock return that cannot exist.
	const totals = holdingsOut.reduce<StockPortfolioTotals>(
		(acc, holding) => {
			acc.holdingsCount++;
			acc.invested += holding.term.invested;
			acc.costBasis += holding.term.costBasis;
			acc.marketValue += holding.marketValue;
			acc.unrealized += holding.unrealized;
			acc.realized += holding.term.realized;
			acc.income += holding.term.dividendsValue;
			acc.dividendsCount += holding.term.dividendsCount;
			acc.dividendsUnpriced += holding.term.dividendsUnpriced;
			acc.profit += holding.profit;

			if (!holding.benefit.valuation.priced) acc.unpricedHoldingsCount++;
			if (holding.increments <= 0) acc.incompleteHoldingsCount++;
			if (holding.roiPct !== null) {
				acc.measuredHoldingsCount++;
				acc.measuredInvested += holding.term.invested;
				acc.measuredProfit += holding.profit;
			}
			return acc;
		},
		{
			holdingsCount: 0,
			unpricedHoldingsCount: 0,
			incompleteHoldingsCount: 0,
			measuredHoldingsCount: 0,
			invested: 0,
			costBasis: 0,
			marketValue: 0,
			unrealized: 0,
			realized: 0,
			income: 0,
			dividendsCount: 0,
			dividendsUnpriced: 0,
			profit: 0,
			measuredInvested: 0,
			measuredProfit: 0,
			roiPct: null,
			forwardAnnualIncome: 0,
			forwardYieldOnCostPct: null,
		},
	);

	if (totals.measuredInvested > 0) {
		totals.roiPct = (totals.measuredProfit / totals.measuredInvested) * 100;
	}
	for (const holding of holdingsOut) {
		const { valuation, frequencyDays } = holding.benefit;
		if (!valuation.priced || !frequencyDays || frequencyDays <= 0) continue;
		// Income of the blocks actually held, and of each block held — a second
		// increment really does pay a second coupon. A position below one block
		// earns nothing today, however attractive the next block would be, so it
		// does not contribute here — that is what the block table is for.
		if (holding.increments <= 0) continue;
		totals.forwardAnnualIncome +=
			valuation.valuePerCycle * (365 / frequencyDays) * holding.increments;
	}
	if (totals.costBasis > 0) {
		totals.forwardYieldOnCostPct =
			(totals.forwardAnnualIncome / totals.costBasis) * 100;
	}

	// ── Block table: every increment of every stock, owned or not ───────────
	const holdingByStockId = new Map(holdingsOut.map((h) => [h.stockId, h]));
	// Every stock the catalogue knows, plus anything held or reported that it does
	// not — an unknown stock still gets rows, priced as unpriceable, so a new Torn
	// listing shows up rather than disappearing from the list.
	const catalogIds = [
		...new Set<number>([
			...STOCK_CATALOG.map((s) => s.stockId),
			...stocks.map((s) => s.stockId),
			...holdingsOut.map((h) => h.stockId),
		]),
	].sort((a, b) => a - b);

	const blocks: StockBlock[] = [];
	for (const stockId of catalogIds) {
		const reference = referenceById.get(stockId);
		const catalogRow = catalogStock(stockId);
		const benefit = resolveStockBenefit(stockId, reference, {
			pointsPrice,
			itemPricesById,
			itemPricesByName,
		});
		const holding = holdingByStockId.get(stockId);

		blocks.push(
			...buildStockBlocks({
				stockId,
				name: reference?.name || catalogRow?.name || `Stock ${stockId}`,
				acronym: reference?.acronym || catalogRow?.acronym || "?",
				benefit,
				price: reference?.price ?? 0,
				shares: holding?.shares ?? 0,
				increments: holding?.increments ?? 0,
			}),
		);
	}

	// ── Warnings ────────────────────────────────────────────────────────────
	const pricedHoldings = holdingsOut.filter((h) => h.price > 0);
	if (holdingsOut.length > 0 && pricedHoldings.length === 0) {
		portfolioWarnings.push(
			"No share prices are on record, so no position could be marked to market. Refresh to pull today's prices from Torn.",
		);
	}
	if (totals.unpricedHoldingsCount > 0) {
		portfolioWarnings.push(
			`${totals.unpricedHoldingsCount} holding${totals.unpricedHoldingsCount === 1 ? "'s benefit has" : "s' benefits have"} no dollar value in this build, so the portfolio income and profit below them understate the real return.`,
		);
	}
	if (totals.incompleteHoldingsCount > 0) {
		portfolioWarnings.push(
			`${totals.incompleteHoldingsCount} holding${totals.incompleteHoldingsCount === 1 ? " is" : "s are"} below one complete block, so no dividend is accruing and no term ROI is claimed for ${totals.incompleteHoldingsCount === 1 ? "it" : "them"}.`,
		);
	}
	if (totals.dividendsUnpriced > 0) {
		portfolioWarnings.push(
			`${totals.dividendsUnpriced} collected dividend${totals.dividendsUnpriced === 1 ? "" : "s"} could not be valued.`,
		);
	}
	const unreconciled = holdingsOut.filter((h) => !h.reconciliation.reconciled);
	if (unreconciled.length > 0) {
		portfolioWarnings.push(
			`${unreconciled.length} position${unreconciled.length === 1 ? "" : "s"} could not be reconciled against the personal log (${unreconciled
				.map((h) => h.acronym)
				.join(", ")}).`,
		);
	}

	return {
		success: true,
		asOfIso: new Date(asOfSeconds * 1000).toISOString(),
		positionAsOfIso: input.positionAsOfIso ?? null,
		pricesAsOfIso,
		pointsPrice,
		totals,
		holdings: holdingsOut.sort((a, b) => b.marketValue - a.marketValue),
		blocks,
		warnings: portfolioWarnings,
	};
}
