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
 *     price) and points (valued at the points-market price) are tradeable, so they
 *     have an honest dollar figure. Energy, nerve, happiness, ammo packs, random
 *     properties and passive benefits have no market price at all. So each benefit
 *     carries an explicit `priced` flag instead of silently contributing a zero.
 *
 *  3. Income, market movement and ROI are three different numbers and are reported
 *     separately. Dividends collected are flat income — cash the account actually
 *     received. Share-price movement is unrealised. ROI is the total return on the
 *     capital still committed, and it is only claimed for a position that can
 *     actually earn: at least one COMPLETE benefit block (a passive block, or an
 *     active holding below its block size, earns nothing, so no stock return
 *     exists for it) whose payout has a dollar figure and whose cost basis is known.
 *
 *  4. Increments are cumulative, not additive. The second block of a stock costs
 *     twice the first ON TOP of the first, so holding `n` blocks costs
 *     `(2^n − 1) × blockShares` shares, and the block being worked toward starts at
 *     `(2^n − 1) × blockShares` shares held. Everything about "should I buy more?"
 *     is decided on the block being worked toward, not on the blended position.
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

/** A resource a dividend can pay in. Only points are tradeable, so only points price. */
export type StockResourceUnit = "energy" | "nerve" | "happy" | "points";

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
	/**
	 * Complete benefit blocks held. Increments are cumulative: holding `n` blocks
	 * costs `(2^n − 1) × blockShares` shares, so this is not `shares ÷ blockShares`.
	 */
	increments: number;
	/** Shares the block being worked toward adds once complete. */
	nextBlockShares: number;
	/** Shares still needed before that block is complete and starts paying. */
	sharesToNextBlock: number;
	/** Share of the block being worked toward that is already owned, 0–100. */
	nextBlockProgressPct: number;
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
	/**
	 * Flat income collected this term: the dollar value of dividends already paid
	 * out. Deliberately excludes market movement and sale proceeds.
	 */
	income: number;
	/** realised + dividends + unrealized across the open term. */
	profit: number;
	/**
	 * profit ÷ invested. Null whenever no stock return exists to measure: a passive
	 * block, a holding below one complete block, an unpriceable payout, or no basis.
	 */
	roiPct: number | null;
	/** Why `roiPct` is null, when it is. */
	roiNote?: string;
	/** Term ROI annualised. Null over short terms, where it says nothing. */
	annualizedRoiPct: number | null;
	/** Why `annualizedRoiPct` is null, when it is. */
	annualizedNote?: string;
	/** Annualised return of buying one more block at today's price, as a percentage. */
	nextBlockAprPct: number | null;
	/** Why `nextBlockAprPct` is null, when it is. */
	nextBlockNote?: string;
	benefit: StockBenefit;
	progress: StockBenefitProgress | null;
	reconciliation: StockReconciliation;
	warnings: string[];
}

/**
 * One increment of one stock, priced so it can be compared against every other
 * increment of every other stock.
 *
 * This is the decision surface: the row for the block being worked toward answers
 * "what does the next purchase cost, and what does it return?", and the rows for
 * later blocks show what buying further would eventually yield.
 */
export interface StockBlock {
	stockId: number;
	name: string;
	acronym: string;
	/** 1 for the first block, 2 for the second increment, and so on. */
	increment: number;
	/** Shares this single increment adds (the block size, doubled per block held). */
	shares: number;
	/** Shares in the first block, so "block 3 of 4" is readable. */
	blockShares: number;
	price: number;
	/** Cash this increment costs at today's price. Null when no price is on record. */
	cost: number | null;
	frequencyDays: number | null;
	/** Dollar value of one payout of this block, or null when it has no price. */
	payoutValue: number | null;
	/** What one payout is: "$4,000,000", "1× Drug Pack", "100 points". */
	payoutLabel: string;
	/** Why this payout carries no dollar figure, when it does not. */
	payoutNote?: string;
	/** Annual income once complete: payoutValue × 365 ÷ frequencyDays. */
	annualIncome: number | null;
	/** annualIncome ÷ cost, as a percentage. The APR on the whole block. */
	annualizedAprPct: number | null;
	/** Shares already held toward this block. */
	sharesHeld: number;
	/** Share of this block already owned, 0–100. */
	progressPct: number;
	/** Shares still needed to complete it. */
	sharesRemaining: number;
	/** Cash still needed to complete it. Null when no price is on record. */
	costRemaining: number | null;
	/**
	 * annualIncome ÷ costRemaining: the return on the cash the NEXT purchase costs.
	 *
	 * Set only for the one block a purchase can actually advance — a block already
	 * held cannot be bought, and a later block cannot be reached yet — which is what
	 * makes it the "next to buy" ranking.
	 */
	nextToBuyAprPct: number | null;
	/** Every share of this block is held, so it is paying. */
	held: boolean;
	/** A cap blocks any further increment of this stock. */
	capped: boolean;
	/** A passive block pays no dividend, so no increment of it has an APR. */
	passive: boolean;
	benefit: StockBenefit;
}

/**
 * Portfolio-wide roll-up.
 *
 * `profit` and `roiPct` deliberately cover different sets. Profit is every
 * position's realised sales plus collected dividends plus market movement; ROI
 * covers only the positions that can earn (one complete, priceable block with a
 * known basis), because averaging a passive block or a half-built one into an
 * "ROI" would describe a return that cannot exist.
 */
export interface StockPortfolioTotals {
	holdingsCount: number;
	/** Holdings whose benefit has no dollar figure. */
	unpricedHoldingsCount: number;
	/** Holdings below one complete block, so no dividend is accruing. */
	incompleteHoldingsCount: number;
	/** Holdings an ROI can be measured on: complete, priceable block, known basis. */
	measuredHoldingsCount: number;
	/** Every dollar put into the open terms, measured or not. */
	invested: number;
	costBasis: number;
	marketValue: number;
	unrealized: number;
	realized: number;
	/** Flat income collected this term across every holding. */
	income: number;
	dividendsCount: number;
	dividendsUnpriced: number;
	/** realised + income + unrealized, across every holding. */
	profit: number;
	/** Capital sitting in positions whose return can be measured. */
	measuredInvested: number;
	/** Total return of those same positions. */
	measuredProfit: number;
	/** measuredProfit ÷ measuredInvested. Null when nothing measurable is held. */
	roiPct: number | null;
	/** Annualised income of the complete, priceable blocks actually held. */
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
	/** Points-market price per point, used to value any points payout. */
	pointsPrice: number;
	totals: StockPortfolioTotals;
	holdings: StockHolding[];
	/** Every increment of every stock, owned or not, for the buy-decision table. */
	blocks: StockBlock[];
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
