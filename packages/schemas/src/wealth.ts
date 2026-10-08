/**
 * Shared contract for the personal wealth ledger (Blasted's Script → Wealth tab).
 *
 * This is the single source of truth for what the API computes and the userscript
 * renders. Any new figure belongs here first, so both sides fail to compile until
 * they agree on it.
 *
 * WHY THIS CONTRACT IS SHAPED THE WAY IT IS
 *
 * 1. CASH FLOW AND PROFIT ARE DIFFERENT NUMBERS. Moving money into the vault, the
 *    company, the bank, the Cayman account or the bookie changes what is in the
 *    player's pocket without changing what they are worth. So every event and
 *    every total carries `walletDelta` (pocket) and `accountDelta` (a balance they
 *    still own) separately, and `netWorthDelta` is the one that answers "did I get
 *    richer". Reporting only cash flow makes a vault deposit look like a loss;
 *    reporting only net worth hides where the money actually is.
 *
 * 2. AN UNPRICED EVENT IS NOT A ZERO. Torn has 1170 log types and not all of them
 *    carry an amount we can establish: a `Book` has no item-market price, a
 *    points refill spends points rather than dollars, and a faction transfer is
 *    logged twice with no way to tell which leg touched the wallet. Those events
 *    are recorded with `priced: false` and reported in `coverage`, so the reader
 *    sees the shape of what is missing instead of reading a zero as "nothing
 *    happened".
 *
 * 3. THE LEDGER IS ANCHORED TO 00:00 UTC, NOT TO "NOW". Init runs part-way through
 *    a day and the account has already been active since midnight. The balances
 *    recorded as day zero are therefore OPENING balances: the observed balances
 *    minus the net effect of everything that has happened since midnight, so the
 *    day's events are counted once rather than twice.
 *
 * 4. THE LEDGER IS CHECKED, NOT TRUSTED. Torn publishes its own `daily_networth`.
 *    `netWorthDrift` is the difference between what the ledger says the account is
 *    worth and what Torn says, and a drift that is not near zero is the signal
 *    that a rule is wrong. That check is why this module can be corrected from
 *    evidence instead of argued about.
 *
 * This module must stay dependency-free: the userscript imports it type-only.
 */

/** A balance the player owns that is not their pocket. */
export type WealthAccountKey =
	| "wallet"
	| "bookie"
	| "vault"
	| "company"
	| "bank"
	| "cayman"
	| "piggy"
	| "faction";

/** Where a value movement sits, for grouping. Mirrors the engine's categories. */
export type WealthCategoryKey =
	| "crime"
	| "bounty"
	| "missions"
	| "hunting"
	| "bazaar"
	| "item_market"
	| "points_market"
	| "shops"
	| "trades"
	| "auctions"
	| "display"
	| "casino"
	| "bookie"
	| "racing"
	| "stocks"
	| "company"
	| "faction"
	| "property"
	| "bank"
	| "vault"
	| "gym"
	| "medical"
	| "education"
	| "travel"
	| "jail"
	| "items"
	| "consumables"
	| "attacks"
	| "events"
	| "other";

/** One item stack attached to an event. */
export interface WealthEventItem {
	itemId: string;
	itemName: string | null;
	quantity: number;
	/** Unique item id, when Torn tracked this stack individually. */
	uid: number | null;
	/** Market price per unit, or 0 when the item has no market price. */
	marketPrice: number;
}

/** One ledger row, as the tab renders it. */
export interface WealthTransaction {
	id: string;
	logId: string;
	logType: number;
	timestamp: string;
	category: WealthCategoryKey;
	label: string;
	/** What the log type was called in Torn's own log. */
	title: string | null;
	tornCategory: string | null;
	walletDelta: number;
	account: WealthAccountKey | null;
	accountDelta: number;
	itemsIn: WealthEventItem[];
	itemsOut: WealthEventItem[];
	netWorthDelta: number;
	priced: boolean;
}

/** The day-zero anchor and the balances derived from it since. */
export interface WealthBalances {
	/** Wallet cash. */
	wallet: number;
	/** Every non-wallet balance the player owns, keyed by account. */
	accounts: Partial<Record<WealthAccountKey, number>>;
	/** Value of items the ledger has seen move since day zero. */
	itemsValue: number;
	/** `wallet + accounts + itemsValue`, as far as the ledger can account for it. */
	trackedNetWorth: number;
	/** Torn's own net worth figure, or null when it could not be read. */
	tornNetWorth: number | null;
	/** `trackedNetWorth − tornNetWorth`. A large value means a rule is wrong. */
	netWorthDrift: number | null;
	/** Bank investment maturity, when the player has one open. */
	cityBank?: {
		amount: number;
		profit: number;
		until: number | null;
	} | null;
	observedAt: string;
}

/** How much of the log the classifier could actually account for. */
export interface WealthCoverage {
	/** Events whose amounts are fully established. */
	pricedEvents: number;
	/** Events recorded but not fully trusted. */
	unpricedEvents: number;
	/** Net-worth movement carried by the unpriced events, as a magnitude. */
	unpricedAmount: number;
	/** One entry per log type that no rule and no band covered. */
	unclassified: Array<{
		logType: number;
		title: string | null;
		events: number;
		sample: string;
	}>;
	/** Log types the classifier recognised, for the "of N" line in the tab. */
	classifiedLogTypes: number;
	/** Total log types Torn publishes, when the reference sync has run. */
	totalLogTypes: number | null;
}

/** Ledger synchronisation state, mirroring the other personal ledgers. */
export interface WealthLedgerState {
	status: "idle" | "running" | "completed" | "error";
	/** True once the day-zero snapshot has been written. */
	initialised: boolean;
	/** Unix seconds of 00:00 UTC on the day the ledger was anchored. */
	anchorTimestamp: number | null;
	/** ISO timestamp of that same anchor, for display. */
	anchorDate: string | null;
	totalIndexedEvents: number;
	lastReconciledAt: string | null;
	lastError: string | null;
	updatedAt: string;
	coverage: WealthCoverage;
}

/** One day of the cash-flow timeline. */
export interface WealthTimelinePoint {
	date: string;
	walletIn: number;
	walletOut: number;
	walletNet: number;
	netWorthDelta: number;
	events: number;
}

/** One row of the category breakdown table. */
export interface WealthCategoryRow {
	category: WealthCategoryKey;
	walletIn: number;
	walletOut: number;
	walletNet: number;
	netWorthDelta: number;
	events: number;
	unpricedEvents: number;
}

/** Top-line figures for the KPI row. */
export interface WealthKPIs {
	walletIn: number;
	walletOut: number;
	walletNet: number;
	accountNet: number;
	itemsInValue: number;
	itemsOutValue: number;
	netWorthDelta: number;
	events: number;
}

/** The analytics payload the Wealth tab renders. */
export interface WealthAnalyticsResponse {
	success: boolean;
	timeframe: {
		/** `7`, `30`, `90` or `all`. */
		days: string;
		from: string | null;
		to: string | null;
	};
	state: WealthLedgerState;
	balances: WealthBalances;
	kpis: WealthKPIs;
	timeline: WealthTimelinePoint[];
	categories: WealthCategoryRow[];
	topEvents: WealthTransaction[];
}

/** A page of ledger rows. */
export interface WealthTransactionsResponse {
	success: boolean;
	total: number;
	offset: number;
	limit: number;
	transactions: WealthTransaction[];
}

/** The ledger state plus the balances, which is what a refresh returns. */
export interface WealthStateResponse {
	success: boolean;
	state: WealthLedgerState;
	balances: WealthBalances;
}
