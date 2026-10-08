/**
 * Shared contract for the personal stock portfolio (Blasted's Script → Stocks tab).
 *
 * This is the single source of truth for the payload the API computes and the
 * userscript renders. Any new figure belongs here first, so both sides fail to
 * compile until they agree on it.
 *
 * WHY THIS CONTRACT IS SHAPED THE WAY IT IS
 *
 * "ROI" on Torn stocks is not one number, and the naive version is wrong:
 *
 *  1. Stock benefits pay out over a *holding period*, not over all time. Buying a
 *     block, collecting dividends, selling out and buying back later starts a new
 *     term, so a lifetime total mixes terms that have already been closed with the
 *     one that is still open. Every figure here is scoped to the CURRENT TERM
 *     (since the position was last opened) unless the name says otherwise.
 *
 *  2. Only some benefits are cash. Money dividends, items (valued at item-market
 *     price), energy, nerve, happiness and points are all comparable only if the
 *     reader supplies a value for the resources; ammo packs, random properties and
 *     passive benefits have no price at all. So each benefit carries an explicit
 *     `priced` flag instead of silently contributing a zero, and holdings whose
 *     benefit cannot be priced report `roiPct: null` rather than a wrong number.
 *
 *  3. Realised and unrealised profit are different things. Sells are recorded in
 *     the personal log with Torn's own realised profit, and the shares that are
 *     still held are marked to the current market price, so both are reported.
 *
 * This module is intentionally dependency-free and must stay that way: the
 * userscript imports it type-only and bundles for the browser.
 */

/** What one dividend cycle of a stock actually pays. */
export type StockBenefitKind =
	/** Money. */
	| "cash"
	/** A named item, priced from the item market. */
	| "item"
	/** Energy, nerve, happiness or points — priceable only with a user rate. */
	| "resource"
	/** An ammunition pack: contents depend on the equipped weapon. */
	| "ammo"
	/** A random property: value depends on which of the 13 is drawn. */
	| "property"
	/** A passive benefit with no dividend at all. */
	| "passive";

/** A resource a dividend can pay in, which the reader may value per unit. */
export type StockResourceUnit = "energy" | "nerve" | "happy" | "points";

/** Optional reader-supplied value of one unit of each resource, in dollars. */
export interface StockValuationRates {
	energy: number;
	nerve: number;
	happy: number;
	points: number;
}

/** How much one dividend cycle of a benefit is worth, and whether that is knowable. */
export interface StockBenefitValuation {
	kind: StockBenefitKind;
	/** Units granted per cycle when `kind === "resource"`. */
	resourceUnit?: StockResourceUnit;
	resourceQuantity?: number;
	/** Item granted per cycle when `kind === "item"`. */
	itemId?: number;
	itemName?: string;
	itemQuantity?: number;
	/** Money paid per cycle when `kind === "cash"`. */
	cashPerCycle?: number;
	/** Value of one cycle's payout in dollars; 0 whenever `priced` is false. */
	valuePerCycle: number;
	/** False when no honest dollar figure exists for this payout. */
	priced: boolean;
	/** Why the payout carries no dollar figure, shown to the reader verbatim. */
	pricingNote?: string;
}

/** The benefit a stock's block grants, with its hold/increment rules. */
export interface StockBenefit {
	kind: StockBenefitKind;
	passive: boolean;
	/** Days per dividend cycle; null for passive benefits. */
	frequencyDays: number | null;
	/** Shares in one block (the first increment). */
	requirementShares: number;
	description: string;
	/** Whole blocks held, as reported by Torn's `bonus.increment`. */
	increments: number;
	/** Where the requirement/description came from, so a stale row is visible. */
	source: "torn" | "catalog";
	valuation: StockBenefitValuation;
	/** Hard cap on blocks (only MCS has one), else null. */
	maxIncrements: number | null;
	/** Anything unusual about this stock, shown next to it. */
	note?: string;
}

/** One purchase lot inside the open term. */
export interface StockTermLot {
	timestamp: number;
	shares: number;
	price: number;
	/** Cash paid for the lot. */
	worth: number;
}

/** One dividend collected inside the open term. */
export interface StockTermDividend {
	timestamp: number;
	/** Money credited, 0 when the payout could not be priced. */
	value: number;
	priced: boolean;
	/** What was paid: cash, an item, or a resource. */
	kind: "cash" | "item" | "resource";
	itemId?: number;
	itemName?: string;
	resourceUnit?: StockResourceUnit;
	resourceQuantity?: number;
}

/** One completed sale inside the open term. */
export interface StockTermSell {
	timestamp: number;
	shares: number;
	proceeds: number;
	fees: number;
	/** Realised profit as recorded by Torn, or derived from average cost. */
	realized: number;
	/** True when Torn reported the profit rather than it being derived. */
	fromLog: boolean;
}

/** The currently open holding period for one stock. */
export interface StockTerm {
	/** Unix seconds the term opened (first buy after the position was flat). */
	start: number | null;
	/** Whole days the term has been open. */
	days: number | null;
	/** Cash put in during the term (sum of buys). The ROI denominator. */
	invested: number;
	/** Cost basis still held (buys minus the cost of shares sold). */
	costBasis: number;
	/** Realised profit from sales inside the term. */
	realized: number;
	/** Dollar value of dividends collected inside the term. */
	dividendsValue: number;
	dividendsCount: number;
	/** Dividends collected that carry no dollar value. */
	dividendsUnpriced: number;
	dividends: StockTermDividend[];
	lots: StockTermLot[];
	sells: StockTermSell[];
}

/** A term that has already been closed by selling out completely. */
export interface StockClosedTerm {
	start: number;
	end: number;
	days: number;
	invested: number;
	profit: number;
	roiPct: number | null;
}

/** Where the cost basis came from, and whether it reconciles with the live position. */
export interface StockReconciliation {
	/** `logs` = replayed personal logs; `transactions` = live Torn purchase list. */
	source: "logs" | "transactions" | "none";
	/** True when the replay landed on the share count Torn reports. */
	reconciled: boolean;
	/** Shares the replay arrived at, before the live count was substituted. */
	replayedShares: number | null;
	/**
	 * True when some held shares carry no cost basis at all (they arrived through a
	 * split or merge with no purchase behind them). Profit and ROI are withheld
	 * rather than computed against a diluted average cost, which would read as a
	 * large gain the account never made.
	 */
	basisIncomplete?: boolean;
	note?: string;
}

/** Where a holding stands toward its next payout (or its passive activation). */
export interface StockBenefitProgress {
	/** A dividend is ready to collect, or a passive benefit is live. */
	available: boolean;
	frequencyDays: number | null;
	/** Days progressed into the current cycle. */
	days: number | null;
	/** Days remaining until the next payout. */
	daysUntil: number | null;
	/** True only for passive benefits whose 7-day hold is complete. */
	passiveActive: boolean | null;
	/** Reminder about the collect window, when relevant. */
	note?: string;
}

/** One stock currently held, with its current-term performance. */
export interface StockHolding {
	stockId: number;
	name: string;
	acronym: string;
	/** Shares held right now, per Torn's `/user/stocks`. */
	shares: number;
	/** Shares in one block, so "how many increments" is readable. */
	blockShares: number;
	increments: number;
	/** Current market price per share. */
	price: number;
	marketValue: number;
	/** Average price paid for the shares still held. */
	avgCost: number;
	term: StockTerm;
	/** The term before this one, if the position was closed and reopened. */
	previousTerm: StockClosedTerm | null;
	/** marketValue − costBasis. */
	unrealized: number;
	/** realised + dividends + unrealized across the open term. */
	profit: number;
	/** profit ÷ invested. Null when the benefit cannot be priced or nothing was invested. */
	roiPct: number | null;
	/** Term ROI annualised. Null over short terms, where it says nothing. */
	annualizedRoiPct: number | null;
	/** Why `annualizedRoiPct` is null, when it is. */
	annualizedNote?: string;
	/** Forward annualised yield of one more block at today's price. */
	forwardYieldPct: number | null;
	benefit: StockBenefit;
	progress: StockBenefitProgress | null;
	reconciliation: StockReconciliation;
	warnings: string[];
}

/** One row of the full stock list, owned or not, so candidates can be compared. */
export interface StockCatalogEntry {
	stockId: number;
	name: string;
	acronym: string;
	price: number;
	benefit: StockBenefit;
	/** Shares held right now; 0 when not owned. */
	shares: number;
	owned: boolean;
	/** Shares that the next increment would cost (doubling each time). */
	nextIncrementShares: number;
	/** Cash the next increment would cost at today's price. Null when capped out. */
	nextIncrementCost: number | null;
	/**
	 * Annualised yield of buying the NEXT increment at today's price. This is the
	 * number that answers "should I buy more?", which is not the same as the yield
	 * on what is already held. Null when the benefit cannot be priced.
	 */
	nextIncrementYieldPct: number | null;
	/** Annualised yield of the FIRST increment at today's price. */
	firstIncrementYieldPct: number | null;
	/** Performance of the open term, repeated here so the list sorts in one place. */
	termRoiPct: number | null;
	termProfit: number;
}

/** Portfolio-wide roll-up. Holdings whose benefit cannot be priced are excluded. */
export interface StockPortfolioTotals {
	holdingsCount: number;
	/** Holdings whose benefit has no dollar figure, excluded from the money totals. */
	unpricedHoldingsCount: number;
	invested: number;
	costBasis: number;
	marketValue: number;
	unrealized: number;
	realized: number;
	dividendsValue: number;
	dividendsCount: number;
	dividendsUnpriced: number;
	profit: number;
	/**
	 * profit ÷ invested across every holding with a basis. This is a lower bound,
	 * not a measurement, whenever `unpricedHoldingsCount` is non-zero.
	 */
	roiPct: number | null;
	/** Capital in holdings whose benefit has a dollar value and whose basis is known. */
	pricedInvested: number;
	/** Profit of those same holdings. */
	pricedProfit: number;
	/** The like-for-like ROI: pricedProfit ÷ pricedInvested. */
	pricedRoiPct: number | null;
	/** Annualised income of every priced holding's current blocks, at today's rates. */
	forwardAnnualIncome: number;
	/** forwardAnnualIncome ÷ costBasis. */
	forwardYieldOnCostPct: number | null;
}

export interface StockPortfolioResponse {
	success: boolean;
	message?: string;
	/** When this payload was computed. */
	asOfIso: string;
	/** When Torn's `/user/stocks` position was last synced. */
	positionAsOfIso: string | null;
	/** When the share prices were last refreshed. */
	pricesAsOfIso: string | null;
	/** The resource rates used for every figure above. */
	rates: StockValuationRates;
	totals: StockPortfolioTotals;
	holdings: StockHolding[];
	catalog: StockCatalogEntry[];
	/** Why some figures are missing, in the reader's words. */
	warnings: string[];
}

/** Ledger telemetry for the stocks half of the personal log pipeline. */
export interface StocksLedgerState {
	status: "idle" | "running" | "completed" | "error";
	totalIndexedLogs: number;
	lastProcessedTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
}
