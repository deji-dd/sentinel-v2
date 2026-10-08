/**
 * The wealth rule table: what every Torn personal log type does to the player's
 * money, balances and items.
 *
 * WHY THIS IS DATA AND NOT CODE
 *
 * Torn has 1170 log types across 230 categories and this account has personally
 * generated 785 of them. Every one of them can move value, and the ways they do
 * it are wildly inconsistent: `1221 Bazaar sell` carries `cost_total`,
 * `5511 Stock sell` carries `worth` minus `fees` plus Torn's own `profit`, and
 * `8305 Casino roulette win` carries a bet AND a payout that must be netted. A
 * hand-written `if` chain over those shapes is how the previous attempt at this
 * module ended up recognising eight log types and mis-booking the bookie as a
 * loss. A table can be reviewed, diffed, snapshotted and checked for coverage;
 * control flow cannot.
 *
 * THE FOUR EFFECTS
 *
 * Each rule declares any combination of four independent effects, because
 * conflating them is what makes a wealth ledger wrong:
 *
 *   wallet   money in or out of the player's pocket, right now
 *   account  money into or out of a balance the player still owns but does not
 *            hold in their pocket — the bookie, the vault, company funds, the
 *            city bank, the Cayman account, the piggy bank
 *   itemsIn  item stacks arriving
 *   itemsOut item stacks leaving
 *
 * A bet is not an expense: `8460 Bookie bet` moves money from the wallet to the
 * bookie account, and net worth is unchanged. Only when the bet settles does the
 * bookie account gain or lose anything, and only when the player withdraws does
 * the money come back. See `BOOKIE_BET_LOG_IDS` below, proved against the
 * 2026-09-17 chain in the account's real log.
 *
 * WHAT `sign` MEANS
 *
 * `terms` are summed as `Σ sign × value(field)`, taking the first field in the
 * list that resolves to a finite number. So `money_receive` is
 * `[{ fields: ["money"], sign: +1 }]` and a roulette win is
 * `[{ fields: ["won_amount"], sign: +1 }, { fields: ["bet_amount"], sign: -1 }]`.
 *
 * MIRROR LOG PAIRS, AND PAIRS THAT ONLY LOOK LIKE THEM
 *
 * Torn writes several faction events twice, once from each side, into the same
 * personal log. `6737` and `6738` fire in the same second with byte-identical
 * payloads; those are duplicates, they are marked `mirrorOf`, and the engine
 * counts exactly one side by the rule in `resolveMirror`.
 *
 * The faction give/receive pairs are not duplicates, which is easy to get wrong
 * and was. `6735` means "I gave faction money to somebody" and the somebody can
 * be any member; `6736` is the receive line and means money arrived to the
 * player. Treating them as one silenced every receipt. See the comment above
 * `FACTION_BALANCE_MIRROR_IDS` for the row counts that show it.
 */

/** A balance the player owns that is not their pocket. */
export type WealthAccount =
	| "wallet"
	| "bookie"
	| "vault"
	| "company"
	| "bank"
	| "cayman"
	| "piggy"
	| "faction";

/** Where a value movement sits, for grouping in the UI. */
export type WealthCategory =
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

export const WEALTH_CATEGORIES: readonly WealthCategory[] = [
	"crime",
	"bounty",
	"missions",
	"hunting",
	"bazaar",
	"item_market",
	"points_market",
	"shops",
	"trades",
	"auctions",
	"display",
	"casino",
	"bookie",
	"racing",
	"stocks",
	"company",
	"faction",
	"property",
	"bank",
	"vault",
	"gym",
	"medical",
	"education",
	"travel",
	"jail",
	"items",
	"consumables",
	"attacks",
	"events",
	"other",
];

/** Human labels, so the API and the tab agree on the wording. */
export const WEALTH_CATEGORY_LABELS: Record<WealthCategory, string> = {
	crime: "Crimes",
	bounty: "Bounties",
	missions: "Missions",
	hunting: "Hunting",
	bazaar: "Bazaar",
	item_market: "Item market",
	points_market: "Points market",
	shops: "Shops",
	trades: "Trades",
	auctions: "Auctions",
	display: "Display case",
	casino: "Casino",
	bookie: "Bookie",
	racing: "Racing",
	stocks: "Stocks",
	company: "Company",
	faction: "Faction",
	property: "Property",
	bank: "Bank",
	vault: "Vault",
	gym: "Gym",
	medical: "Medical",
	education: "Education",
	travel: "Travel",
	jail: "Jail & bail",
	items: "Items",
	consumables: "Consumables",
	attacks: "Attacks",
	events: "Events",
	other: "Other",
};

/**
 * One signed term of a money rule.
 *
 * `fields` is a preference list: `["upkeep_paid", "upkeep_due"]` means "use
 * `upkeep_paid`, or `upkeep_due` if the first is absent". Torn renames fields
 * between log generations and sometimes omits one, and a missing field must fall
 * through rather than read as zero.
 */
export type WealthMoneyTerm = {
	fields: string[];
	sign: 1 | -1;
};

/** Payload keys that may hold item data. All Torn item shapes are accepted. */
export type WealthItemFields = string[];

export type WealthRule = {
	logId: number;
	label: string;
	category: WealthCategory;
	/** Signed wallet cash movement caused by this log alone. */
	wallet?: WealthMoneyTerm[];
	/** Signed movement of a non-wallet balance the player still owns. */
	account?: { account: WealthAccount; terms: WealthMoneyTerm[] };
	itemsIn?: WealthItemFields;
	itemsOut?: WealthItemFields;
	/**
	 * Resource units that are not items and have no single market price: casino
	 * tokens, ammo, energy. Recorded for completeness, never priced as cash.
	 * `sign` mirrors the money convention: omitted means the unit arrives.
	 */
	units?: { unit: string; fields: string[]; sign?: 1 | -1 }[];
	/**
	 * False when the rule fires but the amount cannot be trusted: the payload
	 * carries no number, or carries one whose meaning is unproven. These events
	 * still reach the ledger, flagged, so the coverage panel can show what is
	 * missing instead of a zero that reads as "nothing happened".
	 */
	priced?: boolean;
	/**
	 * Set when Torn writes this event twice into the same log. The engine counts
	 * the lower log id of the pair and skips the other.
	 */
	mirrorOf?: number;
	/** Why this rule is what it is. Shown in the audit report. */
	evidence?: string;
};

/**
 * The bookie is an account, not an expense.
 *
 * Proved against the account's own log on 2026-09-17: `8460 bet 58,160,000`,
 * then `8462 win 88,403,200`, then `8465 withdrawn 159,697,600` — the winnings
 * were never in the wallet, they accumulated at the bookie and arrived only on
 * withdrawal. Booking the bet as a loss and the win as income overstates both
 * sides by the stake and reports gambling swings that never touched the wallet.
 */
export const BOOKIE_BET_LOG_IDS: readonly number[] = [8450, 8460];
export const BOOKIE_WIN_LOG_IDS: readonly number[] = [8452, 8462];
export const BOOKIE_REFUND_LOG_IDS: readonly number[] = [8453, 8463];
export const BOOKIE_WITHDRAW_LOG_IDS: readonly number[] = [8455, 8465];

/**
 * Mirror pairs, and the pairs that only LOOK like mirrors.
 *
 * Torn writes faction events from both sides, and two of those pairs genuinely
 * are duplicates of one event: `6737`/`6738` and `6742`/`6743` fire in the same
 * second with byte-identical payloads. The engine keeps the lower id and drops
 * the higher.
 *
 * The faction give/receive pairs are NOT duplicates, and treating them as one was
 * a real bug. `6735` is "I gave faction money to somebody" — the counterparty can
 * be any member, and the money comes out of the faction bank, which the player
 * does not own. `6736` is the receive line, and it means one of exactly two
 * things: the player moved money from the faction to themselves, or somebody gave
 * them faction money. Both are money arriving to the player.
 *
 * The row counts from the account's own history show the shape:
 *
 *   6735 rows=4184  receiver is me=3355  receiver is somebody else=829
 *   6736 rows=3426  sender   is me=3378  sender   is somebody else=48
 *
 * So `6735` is booked as nothing and `6736` carries the money. The same
 * construction holds for items (`6732` send / `6733` receive), and it does NOT
 * hold for the organised-crime payout, where every `6795` carries
 * `balance_change` and therefore credits a faction balance rather than the
 * player — a distinction that is visible in the payloads and nowhere else.
 */
export const FACTION_BALANCE_MIRROR_IDS: readonly number[] = [6737, 6738];
export const FACTION_POINTS_MIRROR_IDS: readonly number[] = [6742, 6743];

/**
 * Log id bands.
 *
 * Torn allocates log ids in contiguous ranges per category, which is visible in
 * this account's own history: 1100-1113 is the item market, 1200-1226 bazaars,
 * 8300-8465 casino, 90xx crimes. The bands are the fallback for the 385 log
 * types this account has never generated, so an unseen type is still filed under
 * the right heading and reported as unpriced rather than dropped.
 *
 * Bands are checked in order and the first match wins, so the specific ranges
 * must precede the broad ones.
 */
export const WEALTH_LOG_BANDS: ReadonlyArray<{
	from: number;
	to: number;
	category: WealthCategory;
	priced: false;
}> = [
	// Torn's own money movements. Anything here that reaches the fallback is a
	// money log we have no rule for, which is exactly what the audit chases.
	{ from: 1100, to: 1199, category: "item_market", priced: false },
	{ from: 1200, to: 1299, category: "bazaar", priced: false },
	{ from: 1300, to: 1399, category: "display", priced: false },
	{ from: 1400, to: 1499, category: "items", priced: false },
	{ from: 4000, to: 4099, category: "items", priced: false },
	{ from: 4100, to: 4199, category: "items", priced: false },
	{ from: 4200, to: 4299, category: "shops", priced: false },
	{ from: 4300, to: 4399, category: "auctions", priced: false },
	{ from: 4400, to: 4499, category: "trades", priced: false },
	{ from: 4500, to: 4599, category: "items", priced: false },
	{ from: 4600, to: 4799, category: "items", priced: false },
	{ from: 4800, to: 4899, category: "bank", priced: false },
	{ from: 4900, to: 4999, category: "items", priced: false },
	{ from: 5000, to: 5099, category: "points_market", priced: false },
	{ from: 5100, to: 5299, category: "events", priced: false },
	{ from: 5300, to: 5399, category: "gym", priced: false },
	{ from: 5400, to: 5449, category: "medical", priced: false },
	{ from: 5450, to: 5499, category: "bank", priced: false },
	{ from: 5500, to: 5599, category: "stocks", priced: false },
	{ from: 5600, to: 5699, category: "events", priced: false },
	{ from: 5700, to: 5799, category: "crime", priced: false },
	{ from: 5800, to: 5899, category: "events", priced: false },
	{ from: 5900, to: 5999, category: "property", priced: false },
	{ from: 6000, to: 6199, category: "travel", priced: false },
	{ from: 6200, to: 6219, category: "bank", priced: false },
	{ from: 6220, to: 6299, category: "company", priced: false },
	{ from: 6300, to: 6699, category: "events", priced: false },
	{ from: 6700, to: 6799, category: "faction", priced: false },
	{ from: 6800, to: 6999, category: "faction", priced: false },
	{ from: 7000, to: 7099, category: "items", priced: false },
	{ from: 7100, to: 7199, category: "events", priced: false },
	{ from: 7200, to: 7399, category: "events", priced: false },
	{ from: 7400, to: 7599, category: "events", priced: false },
	{ from: 7600, to: 7999, category: "missions", priced: false },
	{ from: 8000, to: 8099, category: "events", priced: false },
	{ from: 8100, to: 8199, category: "attacks", priced: false },
	{ from: 8200, to: 8299, category: "casino", priced: false },
	{ from: 8300, to: 8399, category: "casino", priced: false },
	{ from: 8400, to: 8449, category: "casino", priced: false },
	{ from: 8450, to: 8469, category: "bookie", priced: false },
	{ from: 8470, to: 8499, category: "casino", priced: false },
	{ from: 8700, to: 8799, category: "racing", priced: false },
	{ from: 8800, to: 8899, category: "items", priced: false },
	{ from: 8900, to: 8999, category: "events", priced: false },
	{ from: 9000, to: 9099, category: "crime", priced: false },
	{ from: 9100, to: 9199, category: "crime", priced: false },
	{ from: 9300, to: 9399, category: "crime", priced: false },
];

const NEUTRAL = { priced: true } as const;

/**
 * Payload keys that can carry value.
 *
 * Used to decide whether an event the rule table does not cover can still be
 * called priced. A log type with no rule whose payload contains none of these
 * fields provably moved nothing — a forum post, a message, a faction notice — so
 * recording it as worth zero is a determination rather than a guess, and counting
 * it as "unpriced" would drown the real gaps in noise. A payload that DOES contain
 * one of these stays unpriced, because an amount we cannot interpret is exactly
 * what that flag is for.
 *
 * Erring wide is deliberate: a false positive costs one line in the coverage
 * report, a false negative loses money silently.
 */
export const WEALTH_VALUE_KEYS: readonly string[] = [
	// Money.
	"money",
	"money_gained",
	"money_lost",
	"money_given",
	"money_mugged",
	"money_increased",
	"money_deposited",
	"cost",
	"cost_each",
	"cost_total",
	"value",
	"value_each",
	"total_value",
	"total",
	"worth",
	"price",
	"price_each",
	"price_total",
	"price_before",
	"price_after",
	"bid_price",
	"final_price",
	"sale_value",
	"upkeep_paid",
	"upkeep_due",
	"fee",
	"fees",
	"fee_paid",
	"fee_applied",
	"fee_balance",
	"join_fee",
	"won_amount",
	"bet_amount",
	"bet",
	"winnings",
	"losses",
	"loss",
	"pot",
	"profit",
	"income",
	"amount",
	"deposited",
	"withdrawn",
	"balance",
	"balance_before",
	"balance_after",
	"balance_change",
	"bounty_reward",
	"reward",
	"pay",
	"rent",
	"interest",
	"bucks",
	"credits",
	"credits_spent",
	"donated",
	"cash",
	// Resources that trade, or that stand in for money.
	"points",
	"points_used",
	"points_given",
	"points_gained",
	"points_received",
	"points_deposited",
	"points_increased",
	"casino_tokens_increased",
	"tokens",
	"racing_points",
	// Items, in every shape the log catalogue uses.
	"item",
	"items",
	"item_gained",
	"items_gained",
	"items_lost",
	"items_used",
	"items_added",
	"items_removed",
	"first_item",
	"second_item",
];

/**
 * Whether a payload holds anything the ledger would need to value.
 *
 * `false` means the event provably moved nothing, whatever log type it is — which
 * is the only case where an uncovered log type may be called priced.
 */
export function payloadCarriesValue(payload: Record<string, unknown>): boolean {
	for (const key of WEALTH_VALUE_KEYS) {
		if (payload[key] !== undefined) return true;
	}
	return false;
}

/**
 * Containers that pay out what was inside them.
 *
 * The generic consumable rule below records an item leaving and nothing else,
 * which is right for a drug or a book and wrong for a wallet: opening one hands
 * over its `money` and its `items`. The audit's suspect report is what found
 * these — both carry a numeric `money` that the generic rule was recording as
 * zero. They get explicit rules instead of a generated one.
 */
const PAYING_CONSUMABLE_IDS = new Set([2405, 2407]);

function rule(entry: WealthRule): WealthRule {
	return entry;
}

/**
 * Every rule, in log-id order.
 *
 * A log type that is absent here and outside every band is still recorded by the
 * engine as an unpriced `other` event, so nothing is ever silently discarded.
 */
export const WEALTH_LOG_RULES: readonly WealthRule[] = [
	// ─── Item market ───────────────────────────────────────────────────────────
	rule({
		logId: 1100,
		label: "Item market listing fee",
		category: "item_market",
		wallet: [{ fields: ["fee"], sign: -1 }],
		itemsOut: ["item"],
		evidence:
			"1100 carries the fee and 1104 pays the full `cost` (item 487: price 2000, fee 60, later sale cost 2000), so the old market charged the fee at listing.",
	}),
	rule({
		logId: 1101,
		label: "Item market listing removed",
		category: "item_market",
		itemsIn: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 1102,
		label: "Item market listing edited",
		category: "item_market",
		...NEUTRAL,
		evidence:
			"Editing an item market listing's price. The listing is not a sale; the cash appears at 1103/1104.",
	}),
	rule({
		logId: 1103,
		label: "Item market purchase",
		category: "item_market",
		wallet: [{ fields: ["cost"], sign: -1 }],
		itemsIn: ["item"],
	}),
	rule({
		logId: 1104,
		label: "Item market sale",
		category: "item_market",
		wallet: [{ fields: ["cost"], sign: 1 }],
		itemsOut: ["item"],
	}),
	rule({
		logId: 1110,
		label: "Item market listing",
		category: "item_market",
		itemsOut: ["items"],
		...NEUTRAL,
		evidence:
			"The listing price is aspirational — it is what the seller hopes to get, not money that moved. The sale's `cost_total` is the cash event.",
	}),
	rule({
		logId: 1112,
		label: "Item market purchase",
		category: "item_market",
		wallet: [{ fields: ["cost_total"], sign: -1 }],
		itemsIn: ["items"],
	}),
	rule({
		logId: 1113,
		label: "Item market sale",
		category: "item_market",
		wallet: [{ fields: ["cost_total"], sign: 1 }],
		itemsOut: ["items"],
		evidence:
			"Sold for 2, logged `cost_total: 1` with `fee: 1` — the new market's `cost_total` is already net of the fee, so adding the fee back would double-charge it.",
	}),

	// ─── Bazaars ───────────────────────────────────────────────────────────────
	rule({
		logId: 1200,
		label: "Bazaar name change",
		category: "bazaar",
		...NEUTRAL,
	}),
	rule({
		logId: 1201,
		label: "Bazaar description change",
		category: "bazaar",
		...NEUTRAL,
	}),
	rule({
		logId: 1202,
		label: "Bazaar opened/closed",
		category: "bazaar",
		...NEUTRAL,
	}),
	rule({
		logId: 1210,
		label: "Bazaar listing added",
		category: "bazaar",
		itemsOut: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 1211,
		label: "Bazaar listing removed",
		category: "bazaar",
		itemsIn: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 1212,
		label: "Bazaar listing repriced",
		category: "bazaar",
		...NEUTRAL,
		evidence:
			"`price_before`/`price_after` are the asking price being edited. Nothing has been paid or received.",
	}),
	rule({
		logId: 1220,
		label: "Bazaar purchase",
		category: "bazaar",
		wallet: [{ fields: ["cost_total"], sign: -1 }],
		itemsIn: ["item"],
	}),
	rule({
		logId: 1221,
		label: "Bazaar sale",
		category: "bazaar",
		wallet: [{ fields: ["cost_total"], sign: 1 }],
		itemsOut: ["item"],
	}),
	rule({
		logId: 1222,
		label: "Bazaar listing added",
		category: "bazaar",
		itemsOut: ["items"],
		...NEUTRAL,
	}),
	rule({
		logId: 1223,
		label: "Bazaar listing removed",
		category: "bazaar",
		itemsIn: ["items"],
		...NEUTRAL,
	}),
	rule({
		logId: 1224,
		label: "Bazaar listing repriced",
		category: "bazaar",
		...NEUTRAL,
		evidence: "The asking price being edited, like 1212. No money moves.",
	}),
	rule({
		logId: 1225,
		label: "Bazaar purchase",
		category: "bazaar",
		wallet: [{ fields: ["cost_total"], sign: -1 }],
		itemsIn: ["items"],
	}),
	rule({
		logId: 1226,
		label: "Bazaar sale",
		category: "bazaar",
		wallet: [{ fields: ["cost_total"], sign: 1 }],
		itemsOut: ["items"],
	}),
	rule({
		logId: 1205,
		label: "Bazaar favourited",
		category: "bazaar",
		...NEUTRAL,
	}),
	rule({
		logId: 1206,
		label: "Bazaar unfavourited",
		category: "bazaar",
		...NEUTRAL,
	}),

	// ─── Display case ──────────────────────────────────────────────────────────
	// Moving an item to the display case changes where it sits, not what it is
	// worth, so these are value-neutral relocations.
	rule({
		logId: 1300,
		label: "Display case add",
		category: "display",
		...NEUTRAL,
		evidence:
			"The display case is a second shelf, not a second owner. The item is still the player's, so moving it there changes its location and not its value.",
	}),
	rule({
		logId: 1301,
		label: "Display case remove",
		category: "display",
		...NEUTRAL,
		evidence:
			"Removing from the display case moves the item back to the inventory — a relocation.",
	}),
	rule({
		logId: 1302,
		label: "Display case add",
		category: "display",
		...NEUTRAL,
		evidence:
			"The display case is a shelf, not a change of ownership; the item stays the player's wherever it sits.",
	}),
	rule({
		logId: 1303,
		label: "Display case remove",
		category: "display",
		...NEUTRAL,
		evidence:
			"Removing from the display case is a relocation back to the inventory.",
	}),

	// ─── Dump and city finds ───────────────────────────────────────────────────
	rule({
		logId: 1400,
		label: "Dump add",
		category: "items",
		itemsOut: ["item"],
		...NEUTRAL,
		evidence:
			"Payload is `{ item: 650, quantity: 1 }` — the player put it in the dump. 1404 is the find.",
	}),
	rule({
		logId: 1403,
		label: "Dump add",
		category: "items",
		itemsOut: ["item"],
		...NEUTRAL,
		evidence: "The modern form of 1400: an item goes into the dump.",
	}),
	rule({
		logId: 1404,
		label: "Dump find",
		category: "items",
		itemsIn: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 1401,
		label: "Dump find",
		category: "items",
		itemsIn: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 7011,
		label: "City item find",
		category: "items",
		itemsIn: ["item"],
		...NEUTRAL,
	}),

	// ─── Item sending and parcels ──────────────────────────────────────────────
	rule({
		logId: 4100,
		label: "Item sent",
		category: "items",
		itemsOut: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 4101,
		label: "Item received",
		category: "items",
		itemsIn: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 4102,
		label: "Items sent",
		category: "items",
		itemsOut: ["items"],
		...NEUTRAL,
	}),
	rule({
		logId: 4103,
		label: "Items received",
		category: "items",
		itemsIn: ["items"],
		...NEUTRAL,
	}),
	// A parcel is a container the player fills and seals, so the items genuinely
	// leave the inventory at 4000 and come back at 4001. This is a different
	// mechanism from item sending (4100/4102), which is why the two do not
	// double-count the same stack.
	rule({
		logId: 4000,
		label: "Parcel filled",
		category: "items",
		itemsOut: ["items"],
		...NEUTRAL,
		evidence:
			'Payload is `{ parcel_id, items: { "406": 1 } }`: the named stacks go into the parcel and out of the inventory.',
	}),
	rule({
		logId: 4001,
		label: "Parcel opened",
		category: "items",
		itemsIn: ["items"],
		...NEUTRAL,
		evidence:
			'Payload is `{ parcel_id, parcel_type, items: { "110": 9, "392": 1 } }`: opening the parcel puts those stacks back in the inventory.',
	}),
	rule({
		logId: 4002,
		label: "Parcel wrapped",
		category: "items",
		...NEUTRAL,
		evidence:
			"Sealing a parcel the items are already in. 4000 moved them; wrapping only closes the box.",
	}),
	rule({
		logId: 4005,
		label: "Parcel opened (small explosive device)",
		category: "items",
		itemsIn: ["items"],
		...NEUTRAL,
		evidence:
			"A parcel opened by force. Whatever survived comes back to the inventory.",
	}),

	// ─── Shops and travel purchases ────────────────────────────────────────────
	rule({
		logId: 4200,
		label: "Shop purchase",
		category: "shops",
		wallet: [{ fields: ["cost_total", "cost"], sign: -1 }],
		itemsIn: ["item"],
	}),
	rule({
		logId: 4201,
		label: "Abroad purchase",
		category: "travel",
		wallet: [{ fields: ["cost_total", "cost"], sign: -1 }],
		itemsIn: ["item"],
	}),
	rule({
		logId: 4210,
		label: "Shop sale",
		category: "shops",
		wallet: [{ fields: ["total_value"], sign: 1 }],
		itemsOut: ["item"],
	}),
	rule({
		logId: 4220,
		label: "Shop sale (points)",
		category: "shops",
		units: [{ unit: "points", fields: ["total_value"] }],
		priced: false,
		evidence:
			"Payload is `{ quantity, value_each, total_value }` with no item id, so which stack was sold cannot be established and the event is flagged rather than half-booked.",
	}),

	// ─── Auctions ──────────────────────────────────────────────────────────────
	rule({
		logId: 4300,
		label: "Auction listing added",
		category: "auctions",
		itemsOut: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 4305,
		label: "Auction bid failed (refund)",
		category: "auctions",
		wallet: [{ fields: ["bid_price"], sign: 1 }],
		priced: false,
		evidence:
			"Torn escrows the bid when placed (4310) and refunds it on failure; whether 4305 is the refund or the failed attempt is unproven, so it is flagged.",
	}),
	rule({
		logId: 4310,
		label: "Auction bid",
		category: "auctions",
		wallet: [{ fields: ["bid_price"], sign: -1 }],
	}),
	rule({
		logId: 4312,
		label: "Auction outbid (refund)",
		category: "auctions",
		wallet: [{ fields: ["bid_price"], sign: 1 }],
	}),
	rule({
		logId: 4320,
		label: "Auction won",
		category: "auctions",
		itemsIn: ["item"],
		...NEUTRAL,
		evidence:
			"The winning bid was already paid at 4310, so delivery moves the item and no cash.",
	}),
	rule({
		logId: 4322,
		label: "Auction sold",
		category: "auctions",
		wallet: [{ fields: ["final_price"], sign: 1 }],
		itemsOut: ["item"],
	}),

	// ─── Trades ────────────────────────────────────────────────────────────────
	// Only settlement moves value. Draft edits and lifecycle notices are free.
	// Proved on trade 13364479: `4442 add 324,000,000` at 16:25:32, then
	// `4440 outgoing 324,000,000` at 16:26:05 — booking both doubles the payment.
	rule({
		logId: 4400,
		label: "Trade initiated",
		category: "trades",
		...NEUTRAL,
	}),
	rule({
		logId: 4401,
		label: "Trade initiated",
		category: "trades",
		...NEUTRAL,
	}),
	rule({
		logId: 4410,
		label: "Trade cancelled",
		category: "trades",
		...NEUTRAL,
	}),
	rule({
		logId: 4411,
		label: "Trade cancelled",
		category: "trades",
		...NEUTRAL,
	}),
	rule({ logId: 4420, label: "Trade expired", category: "trades", ...NEUTRAL }),
	rule({
		logId: 4430,
		label: "Trade completed",
		category: "trades",
		...NEUTRAL,
	}),
	rule({
		logId: 4431,
		label: "Trade accepted",
		category: "trades",
		...NEUTRAL,
	}),
	rule({
		logId: 4440,
		label: "Trade payment sent",
		category: "trades",
		wallet: [{ fields: ["money"], sign: -1 }],
	}),
	rule({
		logId: 4441,
		label: "Trade payment received",
		category: "trades",
		wallet: [{ fields: ["money"], sign: 1 }],
		evidence:
			"Trade 13255267: 4480 +6.83B, 4481 −1.53B, then 4441 6.30B received.",
	}),
	rule({
		logId: 4442,
		label: "Trade money added (draft)",
		category: "trades",
		...NEUTRAL,
		evidence:
			"Editing a draft trade is not a payment. Trade 13364479 proves it: `4442 add 324,000,000` at 16:25:32 and `4440 outgoing 324,000,000` at 16:26:05 — the settlement log is the one that moves money.",
	}),
	rule({
		logId: 4445,
		label: "Trade items sent",
		category: "trades",
		itemsOut: ["items"],
		...NEUTRAL,
	}),
	rule({
		logId: 4446,
		label: "Trade items received",
		category: "trades",
		itemsIn: ["items"],
		...NEUTRAL,
	}),
	rule({
		logId: 4447,
		label: "Trade items added (draft)",
		category: "trades",
		...NEUTRAL,
		evidence:
			"A draft edit by the counterparty, like 4480. The `items` array is what they put on the table, not what the player received — only 4445 and 4446 move stock.",
	}),
	rule({
		logId: 4480,
		label: "Trade money added by partner",
		category: "trades",
		...NEUTRAL,
		evidence:
			"The counterparty's own draft edit, mirrored into this log. Only 4440/4441 settle, so this and its sibling are informational.",
	}),
	rule({
		logId: 4481,
		label: "Trade money removed by partner",
		category: "trades",
		...NEUTRAL,
		evidence:
			"The counterparty removing money from a draft trade. Informational, like 4480: nothing has moved until 4440 or 4441 fires.",
	}),
	rule({
		logId: 4482,
		label: "Trade items added by partner",
		category: "trades",
		...NEUTRAL,
		evidence:
			"A draft edit by the counterparty, like 4480. The `items` array is what they put on the table, not what the player received — only 4445 and 4446 move stock.",
	}),
	rule({ logId: 4499, label: "Trade comment", category: "trades", ...NEUTRAL }),

	// ─── Ammo, mods and equipping ──────────────────────────────────────────────
	rule({
		logId: 4500,
		label: "Ammo purchase",
		category: "items",
		wallet: [{ fields: ["value"], sign: -1 }],
		units: [{ unit: "ammo", fields: ["quantity"] }],
	}),
	rule({
		logId: 4510,
		label: "Ammo sale",
		category: "items",
		wallet: [{ fields: ["value"], sign: 1 }],
		units: [{ unit: "ammo", fields: ["quantity"] }],
	}),
	rule({
		logId: 4520,
		label: "Ammo priority set",
		category: "items",
		...NEUTRAL,
	}),
	rule({ logId: 4600, label: "Mod equipped", category: "items", ...NEUTRAL }),
	rule({ logId: 4610, label: "Mod unequipped", category: "items", ...NEUTRAL }),
	rule({
		logId: 4700,
		label: "Item equipped",
		category: "items",
		...NEUTRAL,
		evidence:
			"Payload is `{ item: 242 }`: equipping moves the item from the inventory to a slot — the same asset in a different place, so it is neither gained nor lost. The day-zero snapshot counts equipped items as held.",
	}),
	rule({
		logId: 4710,
		label: "Item unequipped",
		category: "items",
		...NEUTRAL,
		evidence:
			"Unequipping is the reverse of 4700: a relocation, not a change in what the player owns.",
	}),
	rule({
		logId: 4750,
		label: "Loadout switched",
		category: "items",
		...NEUTRAL,
	}),
	rule({
		logId: 4751,
		label: "Loadout renamed",
		category: "items",
		...NEUTRAL,
	}),
	rule({ logId: 4752, label: "Loadout reset", category: "items", ...NEUTRAL }),

	// ─── Money movement ────────────────────────────────────────────────────────
	rule({
		logId: 4800,
		label: "Money sent",
		category: "bank",
		wallet: [{ fields: ["money"], sign: -1 }],
	}),
	rule({
		logId: 4810,
		label: "Money received",
		category: "bank",
		wallet: [{ fields: ["money"], sign: 1 }],
	}),
	rule({
		logId: 5460,
		label: "Cashier's check withdrawn",
		category: "bank",
		wallet: [{ fields: ["amount"], sign: -1 }],
	}),
	rule({
		logId: 5461,
		label: "Cashier's check received",
		category: "bank",
		wallet: [{ fields: ["amount"], sign: 1 }],
	}),

	// ─── Points ────────────────────────────────────────────────────────────────
	rule({
		logId: 4900,
		label: "Points spent on energy refill",
		category: "items",
		units: [{ unit: "points", fields: ["points_used"] }],
		priced: false,
	}),
	rule({
		logId: 4905,
		label: "Points spent on nerve refill",
		category: "items",
		units: [{ unit: "points", fields: ["points_used"] }],
		priced: false,
	}),
	rule({
		logId: 4910,
		label: "Points spent on casino tokens",
		category: "items",
		units: [{ unit: "points", fields: ["points_used"] }],
		priced: false,
	}),
	rule({
		logId: 5000,
		label: "Points listed for sale",
		category: "points_market",
		units: [{ unit: "points", fields: ["quantity"], sign: -1 }],
		priced: false,
	}),
	rule({
		logId: 5001,
		label: "Points listing removed",
		category: "points_market",
		units: [{ unit: "points", fields: ["quantity"] }],
		priced: false,
	}),
	rule({
		logId: 5010,
		label: "Points purchased",
		category: "points_market",
		wallet: [{ fields: ["cost_total"], sign: -1 }],
		units: [{ unit: "points", fields: ["quantity"] }],
	}),
	rule({
		logId: 5011,
		label: "Points sold",
		category: "points_market",
		wallet: [{ fields: ["cost_total"], sign: 1 }],
		units: [{ unit: "points", fields: ["quantity"] }],
	}),

	// ─── Merits, awards, levels ────────────────────────────────────────────────
	rule({
		logId: 5100,
		label: "Merit assigned",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5110,
		label: "Honour awarded",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 5120, label: "Medal awarded", category: "events", ...NEUTRAL }),
	rule({ logId: 5130, label: "Rank changed", category: "events", ...NEUTRAL }),
	rule({ logId: 5140, label: "Title changed", category: "events", ...NEUTRAL }),
	rule({
		logId: 5150,
		label: "Honour bar changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 5200, label: "Level up", category: "events", ...NEUTRAL }),
	rule({
		logId: 5250,
		label: "Referral signup",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5251,
		label: "Referral reward",
		category: "events",
		itemsIn: ["item", "item2"],
		units: [{ unit: "points", fields: ["points"] }],
		...NEUTRAL,
		evidence:
			"Payload is `{ item: 571, item2: 367, level: 10, points: 250, donator_days: 31 }` — two items and points, all arriving.",
	}),

	// ─── Gym, jail, medical ────────────────────────────────────────────────────
	rule({
		logId: 5300,
		label: "Gym train (strength)",
		category: "gym",
		...NEUTRAL,
	}),
	rule({
		logId: 5301,
		label: "Gym train (defense)",
		category: "gym",
		...NEUTRAL,
	}),
	rule({
		logId: 5302,
		label: "Gym train (speed)",
		category: "gym",
		...NEUTRAL,
	}),
	rule({
		logId: 5303,
		label: "Gym train (dexterity)",
		category: "gym",
		...NEUTRAL,
	}),
	rule({
		logId: 5310,
		label: "Gym train (addict)",
		category: "gym",
		...NEUTRAL,
	}),
	rule({
		logId: 5320,
		label: "Gym membership purchased",
		category: "gym",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 5321,
		label: "Gym membership activated",
		category: "gym",
		...NEUTRAL,
	}),
	rule({ logId: 5350, label: "Jailed", category: "jail", ...NEUTRAL }),
	rule({
		logId: 5351,
		label: "Jail escape succeeded",
		category: "jail",
		...NEUTRAL,
	}),
	rule({
		logId: 5352,
		label: "Jail escape failed",
		category: "jail",
		...NEUTRAL,
	}),
	rule({ logId: 5355, label: "Jail fruitcake", category: "jail", ...NEUTRAL }),
	rule({ logId: 5356, label: "Jail fruitcake", category: "jail", ...NEUTRAL }),
	rule({ logId: 5360, label: "Bust succeeded", category: "jail", ...NEUTRAL }),
	rule({ logId: 5361, label: "Bust received", category: "jail", ...NEUTRAL }),
	rule({ logId: 5362, label: "Bust failed", category: "jail", ...NEUTRAL }),
	rule({
		logId: 5363,
		label: "Bust received (failed)",
		category: "jail",
		...NEUTRAL,
	}),
	rule({
		logId: 5370,
		label: "Bail paid",
		category: "jail",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 5371,
		label: "Bail paid for you",
		category: "jail",
		wallet: [{ fields: ["cost"], sign: 1 }],
	}),
	rule({ logId: 5400, label: "Hospitalised", category: "medical", ...NEUTRAL }),
	rule({ logId: 5410, label: "Revive sent", category: "medical", ...NEUTRAL }),
	rule({
		logId: 5411,
		label: "Revive received",
		category: "medical",
		...NEUTRAL,
	}),
	rule({
		logId: 5412,
		label: "Reviving skill up",
		category: "medical",
		...NEUTRAL,
	}),
	rule({
		logId: 5415,
		label: "Revive failed",
		category: "medical",
		...NEUTRAL,
	}),
	rule({
		logId: 5416,
		label: "Revive failed (received)",
		category: "medical",
		...NEUTRAL,
	}),
	rule({
		logId: 5420,
		label: "Early discharge",
		category: "medical",
		...NEUTRAL,
	}),

	// ─── Bank ──────────────────────────────────────────────────────────────────
	// A transfer between two balances the player owns leaves net worth unchanged,
	// so each of these declares BOTH legs. Declaring only the account leg would
	// book every deposit as a loss.
	rule({
		logId: 5450,
		label: "Bank investment",
		category: "bank",
		wallet: [{ fields: ["amount"], sign: -1 }],
		account: { account: "bank", terms: [{ fields: ["amount"], sign: 1 }] },
	}),
	rule({
		logId: 5451,
		label: "Bank withdrawal",
		category: "bank",
		wallet: [{ fields: ["amount"], sign: 1 }],
		account: { account: "bank", terms: [{ fields: ["amount"], sign: -1 }] },
	}),
	rule({
		logId: 6010,
		label: "Cayman deposit",
		category: "bank",
		wallet: [{ fields: ["deposited"], sign: -1 }],
		account: { account: "cayman", terms: [{ fields: ["deposited"], sign: 1 }] },
	}),
	rule({
		logId: 6011,
		label: "Cayman withdrawal",
		category: "bank",
		wallet: [{ fields: ["withdrawn"], sign: 1 }],
		account: {
			account: "cayman",
			terms: [{ fields: ["withdrawn"], sign: -1 }],
		},
	}),
	rule({
		logId: 6012,
		label: "Cayman interest",
		category: "bank",
		wallet: [{ fields: ["interest"], sign: 1 }],
	}),
	rule({
		logId: 5850,
		label: "Vault deposit",
		category: "vault",
		wallet: [{ fields: ["deposited"], sign: -1 }],
		account: { account: "vault", terms: [{ fields: ["deposited"], sign: 1 }] },
	}),
	rule({
		logId: 5851,
		label: "Vault withdrawal",
		category: "vault",
		wallet: [{ fields: ["withdrawn"], sign: 1 }],
		account: { account: "vault", terms: [{ fields: ["withdrawn"], sign: -1 }] },
	}),
	rule({
		logId: 2380,
		label: "Piggy bank deposit",
		category: "vault",
		wallet: [{ fields: ["deposited", "money"], sign: -1 }],
		account: {
			account: "piggy",
			terms: [{ fields: ["deposited", "money"], sign: 1 }],
		},
		evidence:
			"Payload is `{ item: 820, deposited }`: `820` is the piggy bank itself, not stock moving, and the amount is `deposited`.",
	}),
	rule({
		logId: 2381,
		label: "Piggy bank withdrawal",
		category: "vault",
		wallet: [{ fields: ["withdrawn", "money"], sign: 1 }],
		account: {
			account: "piggy",
			terms: [{ fields: ["withdrawn", "money"], sign: -1 }],
		},
	}),
	rule({
		logId: 6200,
		label: "Loan taken",
		category: "bank",
		wallet: [{ fields: ["loan_amount", "amount"], sign: 1 }],
		priced: false,
	}),
	rule({
		logId: 6201,
		label: "Loan repaid",
		category: "bank",
		wallet: [{ fields: ["loan_amount", "amount"], sign: -1 }],
		priced: false,
	}),
	rule({
		logId: 6203,
		label: "Loan fees increased",
		category: "bank",
		wallet: [{ fields: ["fee_applied"], sign: -1 }],
		priced: false,
	}),
	rule({
		logId: 6204,
		label: "Loan fees paid",
		category: "bank",
		wallet: [{ fields: ["fee_paid"], sign: -1 }],
	}),
	rule({ logId: 6205, label: "Loan warning", category: "bank", ...NEUTRAL }),

	// ─── Stocks ────────────────────────────────────────────────────────────────
	// Buys and sells are worth-normalised by the stock engine; the wealth engine
	// only books the wallet side of the same numbers.
	rule({
		logId: 5500,
		label: "Stock bought",
		category: "stocks",
		wallet: [{ fields: ["worth"], sign: -1 }],
	}),
	rule({
		logId: 5501,
		label: "Stock sold",
		category: "stocks",
		wallet: [{ fields: ["worth"], sign: 1 }],
	}),
	rule({
		logId: 5510,
		label: "Stock bought",
		category: "stocks",
		wallet: [{ fields: ["worth"], sign: -1 }],
		evidence:
			"Shares 59,181 at 895.00; `worth` 52,966,995 is exactly price × amount.",
	}),
	rule({
		logId: 5511,
		label: "Stock sold",
		category: "stocks",
		wallet: [{ fields: ["worth"], sign: 1 }],
		evidence:
			"`worth` is already net of `fees` (gross 667,455,471 − fees 667,456 = 666,788,014), and Torn's own `profit` of 2,689,304 is a third figure that must not be added again.",
	}),
	rule({
		logId: 5520,
		label: "Stock split",
		category: "stocks",
		...NEUTRAL,
		evidence:
			"`amount` here is a share count, not dollars. A split changes the number of shares, never the money in the wallet.",
	}),
	rule({
		logId: 5521,
		label: "Stock merge",
		category: "stocks",
		...NEUTRAL,
		evidence:
			"`amount` here is a share count, not dollars. A merge changes the number of shares, never the money in the wallet.",
	}),
	rule({
		logId: 5530,
		label: "Stock dividend (item)",
		category: "stocks",
		itemsIn: ["item"],
		...NEUTRAL,
		evidence:
			"`amount` here is a share count, not dollars. A split changes the number of shares, never the money in the wallet.",
	}),
	rule({
		logId: 5531,
		label: "Stock dividend (money)",
		category: "stocks",
		wallet: [{ fields: ["money"], sign: 1 }],
	}),
	rule({
		logId: 5532,
		label: "Stock dividend",
		category: "stocks",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 5533,
		label: "Stock dividend",
		category: "stocks",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 5534,
		label: "Stock dividend (happy)",
		category: "stocks",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 5535,
		label: "Stock dividend (energy)",
		category: "stocks",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 5536,
		label: "Stock dividend (nerve)",
		category: "stocks",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 5537,
		label: "Stock dividend",
		category: "stocks",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 5544,
		label: "Stock block withdrawal ready",
		category: "stocks",
		...NEUTRAL,
	}),
	rule({
		logId: 5545,
		label: "Stock passive benefit active",
		category: "stocks",
		...NEUTRAL,
	}),

	// ─── Donations and seasonals ───────────────────────────────────────────────
	// The `value` on these is a real-money subscription price in a prose string
	// ("4.00 GBP ($4.85)"), never Torn cash. It is read defensively and ignored.
	rule({
		logId: 5555,
		label: "Subscription payment",
		category: "events",
		...NEUTRAL,
		priced: false,
		evidence:
			'`value` is the real-money subscription price in prose ("4.00 GBP ($4.85)"), never Torn cash. The points it grants arrive separately.',
	}),
	rule({
		logId: 5560,
		label: "Subscription created",
		category: "events",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 5561,
		label: "Subscription cancelled",
		category: "events",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 5565,
		label: "Subscription failed",
		category: "events",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 5570,
		label: "Donation expired",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5575,
		label: "Subscription reward",
		category: "events",
		itemsIn: ["first_item", "second_item"],
		...NEUTRAL,
	}),
	rule({
		logId: 5585,
		label: "Donation reward",
		category: "events",
		...NEUTRAL,
		priced: false,
		evidence:
			"A donation reward: `points` and `donator_days`, neither of which is Torn cash. The real-money subscription price is not the player's money either.",
	}),
	rule({
		logId: 5600,
		label: "Seasonal gift",
		category: "events",
		itemsIn: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 5611,
		label: "Seasonal refills",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5615,
		label: "Seasonal merit reset",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 15061,
		label: "Staff refills credited",
		category: "events",
		...NEUTRAL,
	}),

	// ─── Crimes ────────────────────────────────────────────────────────────────
	rule({ logId: 5700, label: "Crime failed", category: "crime", ...NEUTRAL }),
	rule({
		logId: 5705,
		label: "Crime failed (jailed)",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 5710,
		label: "Crime failed (hospitalised)",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 5715,
		label: "Crime failure cost",
		category: "crime",
		wallet: [{ fields: ["money_lost"], sign: -1 }],
	}),
	rule({
		logId: 5720,
		label: "Crime money gain",
		category: "crime",
		wallet: [{ fields: ["money_gained"], sign: 1 }],
	}),
	rule({
		logId: 5725,
		label: "Crime item gain",
		category: "crime",
		itemsIn: ["item_gained"],
		...NEUTRAL,
	}),
	rule({
		logId: 5730,
		label: "Crime points gain",
		category: "crime",
		units: [{ unit: "points", fields: ["points_gained"] }],
		priced: false,
	}),
	rule({
		logId: 9000,
		label: "Crime system migration",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9005,
		label: "Crime skill level up",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9006,
		label: "Crime skill level down",
		category: "crime",
		...NEUTRAL,
	}),
	rule({ logId: 9010, label: "Crime success", category: "crime", ...NEUTRAL }),
	rule({
		logId: 9015,
		label: "Crime money gain",
		category: "crime",
		wallet: [{ fields: ["money_gained"], sign: 1 }],
	}),
	rule({
		logId: 9020,
		label: "Crime item gain",
		category: "crime",
		itemsIn: ["items_gained"],
		...NEUTRAL,
	}),
	rule({
		logId: 9025,
		label: "Crime points gain",
		category: "crime",
		units: [{ unit: "points", fields: ["points_gained"] }],
		priced: false,
	}),
	rule({
		logId: 9027,
		label: "Crime ammo gain",
		category: "crime",
		units: [{ unit: "ammo", fields: ["ammo_gained"] }],
		priced: false,
	}),
	rule({
		logId: 9030,
		label: "Crime money paid",
		category: "crime",
		wallet: [{ fields: ["money_lost"], sign: -1 }],
	}),
	rule({
		logId: 9050,
		label: "Crime: bootlegging copy DVDs",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9051,
		label: "Crime: bootlegging online store",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9052,
		label: "Crime: bootlegging sell DVDs",
		category: "crime",
		wallet: [{ fields: ["money_gained"], sign: 1 }],
	}),
	rule({ logId: 9053, label: "Crime success", category: "crime", ...NEUTRAL }),
	rule({
		logId: 9055,
		label: "Crime: skimming collect card details",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9056,
		label: "Crime: skimming sell card details",
		category: "crime",
		wallet: [{ fields: ["money_gained"], sign: 1 }],
	}),
	rule({
		logId: 9060,
		label: "Crime: burglary scout target",
		category: "crime",
		...NEUTRAL,
	}),
	rule({ logId: 9065, label: "Crime unlock", category: "crime", ...NEUTRAL }),
	rule({
		logId: 9070,
		label: "Crime: scamming farm emails",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9071,
		label: "Crime: scamming money paid",
		category: "crime",
		wallet: [{ fields: ["money_lost"], sign: -1 }],
	}),
	rule({
		logId: 9072,
		label: "Crime: phishing website",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9073,
		label: "Crime: website scraper",
		category: "crime",
		...NEUTRAL,
	}),
	rule({ logId: 9150, label: "Crime failed", category: "crime", ...NEUTRAL }),
	rule({
		logId: 9154,
		label: "Crime critical failure",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9155,
		label: "Crime critical failure (jailed)",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9158,
		label: "Crime critical failure (injury)",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9160,
		label: "Crime critical failure (hospital)",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9163,
		label: "Crime critical failure (items lost)",
		category: "crime",
		itemsOut: ["items_lost"],
		...NEUTRAL,
		evidence:
			'Payload is `{ nerve, outcome, items_lost: { "61": 1 }, crime_action }`: the crime failed and took a stack with it.',
	}),
	rule({
		logId: 9165,
		label: "Crime critical failure (money loss)",
		category: "crime",
		wallet: [{ fields: ["money_lost"], sign: -1 }],
	}),
	rule({
		logId: 9300,
		label: "Crime: add blank DVDs",
		category: "crime",
		itemsOut: ["items_used"],
		...NEUTRAL,
	}),
	rule({
		logId: 9301,
		label: "Crime: add spray can",
		category: "crime",
		itemsOut: ["items_used"],
		...NEUTRAL,
	}),
	rule({
		logId: 9302,
		label: "Crime: use items for skimming",
		category: "crime",
		itemsOut: ["items_used"],
		...NEUTRAL,
	}),
	rule({
		logId: 9303,
		label: "Crime: retrieve skimmer",
		category: "crime",
		itemsIn: ["items_used"],
		...NEUTRAL,
	}),
	rule({
		logId: 9304,
		label: "Crime: use items for disposal",
		category: "crime",
		itemsOut: ["items_used"],
		...NEUTRAL,
	}),
	rule({
		logId: 9305,
		label: "Crime: add component",
		category: "crime",
		itemsOut: ["items_used"],
		...NEUTRAL,
	}),
	rule({
		logId: 9306,
		label: "Crime: remove component",
		category: "crime",
		itemsIn: ["items_used"],
		...NEUTRAL,
	}),
	rule({
		logId: 9307,
		label: "Crime: cracking character guess",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9308,
		label: "Crime: bootlegging store toggle",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9309,
		label: "Crime: add item for forgery",
		category: "crime",
		itemsOut: ["items_used"],
		...NEUTRAL,
	}),
	rule({
		logId: 9310,
		label: "Crime: use items for forgery",
		category: "crime",
		itemsOut: ["items_used"],
		...NEUTRAL,
	}),
	rule({
		logId: 9350,
		label: "Crime: graffiti reputation up",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9351,
		label: "Crime: graffiti reputation down",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9356,
		label: "Crime: scamming read email",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9360,
		label: "Crime: arson inquire",
		category: "crime",
		...NEUTRAL,
	}),
	rule({
		logId: 9361,
		label: "Crime: use items for arson",
		category: "crime",
		itemsOut: ["items_used"],
		...NEUTRAL,
	}),
	rule({
		logId: 9362,
		label: "Crime: unlock item for arson",
		category: "crime",
		...NEUTRAL,
	}),

	// ─── Item use ──────────────────────────────────────────────────────────────
	// Consuming an item spends an asset the player already paid for; the cost was
	// recognised at acquisition, so the ledger records the item leaving and does
	// not book a second expense. `item` is the consumed stack in every one of
	// these payloads.
	//
	// Two containers pay out what was inside them, so they are not plain
	// consumables. Found by the audit's suspect report: both carry a numeric
	// `money` that the generic consumable rule recorded as zero.
	rule({
		logId: 2405,
		label: "Opened a wallet",
		category: "consumables",
		wallet: [{ fields: ["money"], sign: 1 }],
		itemsIn: ["items"],
		itemsOut: ["item"],
		evidence:
			"Payload is `{ item: 1078, items: [...], money: 10 }`: the wallet is consumed, and its `money` and `items` are what comes out.",
	}),
	rule({
		logId: 2407,
		label: "Opened a stash box",
		category: "consumables",
		wallet: [{ fields: ["money"], sign: 1 }],
		itemsIn: ["items"],
		itemsOut: ["item"],
		evidence:
			"Same shape as the wallet: `{ item: 1239, items: [...], money: 33000 }`.",
	}),
	...ITEM_USE_RULES(),

	// ─── Property ──────────────────────────────────────────────────────────────
	rule({
		logId: 5900,
		label: "Property upgrade",
		category: "property",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 5910,
		label: "Property move",
		category: "property",
		...NEUTRAL,
	}),
	rule({
		logId: 5915,
		label: "Property kick",
		category: "property",
		...NEUTRAL,
	}),
	rule({
		logId: 5916,
		label: "Property kick received",
		category: "property",
		...NEUTRAL,
	}),
	rule({
		logId: 5920,
		label: "Property upkeep",
		category: "property",
		wallet: [{ fields: ["upkeep_paid", "upkeep_due"], sign: -1 }],
	}),
	rule({
		logId: 5925,
		label: "Property listed for sale",
		category: "property",
		...NEUTRAL,
		evidence:
			"The asking price is aspirational; nothing has been paid or received. 5928 Property sell is the cash event.",
	}),
	rule({
		logId: 5926,
		label: "Property listing removed",
		category: "property",
		...NEUTRAL,
		evidence:
			"Removing a sale listing moves no money — 5925 recorded no cash in either.",
	}),
	rule({
		logId: 5928,
		label: "Property sold",
		category: "property",
		wallet: [{ fields: ["cost"], sign: 1 }],
	}),
	rule({
		logId: 5930,
		label: "Property listed for rent",
		category: "property",
		...NEUTRAL,
		evidence:
			"The advertised rent is aspirational and nothing has been received. 5937 is where rent actually arrives.",
	}),
	rule({
		logId: 5932,
		label: "Rental offer made",
		category: "property",
		...NEUTRAL,
		evidence:
			"A rental offer changes hands only when it is accepted; `rent` here is the offer, not a receipt.",
	}),
	rule({
		logId: 5934,
		label: "Rental offer removed",
		category: "property",
		...NEUTRAL,
		evidence:
			"Withdrawing a rental offer is not a refund, because placing one moved no money.",
	}),
	rule({
		logId: 5937,
		label: "Rent received",
		category: "property",
		wallet: [{ fields: ["rent"], sign: 1 }],
		priced: false,
	}),
	rule({
		logId: 5939,
		label: "Rental expired",
		category: "property",
		...NEUTRAL,
	}),
	rule({
		logId: 5945,
		label: "Property given away",
		category: "property",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 5946,
		label: "Property received",
		category: "property",
		...NEUTRAL,
		priced: false,
	}),

	// ─── Education, church, travel, misc ───────────────────────────────────────
	rule({
		logId: 5960,
		label: "Education started",
		category: "education",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 5961,
		label: "Education left",
		category: "education",
		...NEUTRAL,
	}),
	rule({
		logId: 5962,
		label: "Education kicked",
		category: "education",
		...NEUTRAL,
	}),
	rule({
		logId: 5963,
		label: "Education completed",
		category: "education",
		...NEUTRAL,
	}),
	rule({
		logId: 5970,
		label: "Church donation",
		category: "events",
		wallet: [{ fields: ["donated", "cost"], sign: -1 }],
		priced: false,
	}),
	rule({ logId: 5971, label: "Church pray", category: "events", ...NEUTRAL }),
	rule({
		logId: 5975,
		label: "Marriage proposed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5976,
		label: "Marriage proposed to you",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5981,
		label: "Marriage proposal accepted",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5982,
		label: "Marriage proposal accepted",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5986,
		label: "Church guest invited",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5987,
		label: "Church guest accepted",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 5989, label: "Married", category: "events", ...NEUTRAL }),
	rule({ logId: 5990, label: "Divorce sent", category: "events", ...NEUTRAL }),
	rule({
		logId: 5991,
		label: "Divorce received",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5992,
		label: "Church witness",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 6000,
		label: "Travel departed",
		category: "travel",
		...NEUTRAL,
	}),
	rule({
		logId: 6001,
		label: "Travel fee",
		category: "travel",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 6002,
		label: "Business class ticket",
		category: "travel",
		wallet: [{ fields: ["cost"], sign: -1 }],
		priced: false,
	}),
	rule({
		logId: 6003,
		label: "Travel arrived",
		category: "travel",
		...NEUTRAL,
	}),
	rule({
		logId: 6005,
		label: "Rehabilitation",
		category: "medical",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 6015,
		label: "Fortune teller",
		category: "travel",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 6020,
		label: "Hunting session",
		category: "hunting",
		wallet: [
			{ fields: ["income"], sign: 1 },
			{ fields: ["cost"], sign: -1 },
		],
	}),

	// ─── Company ───────────────────────────────────────────────────────────────
	rule({
		logId: 6221,
		label: "Company pay",
		category: "company",
		wallet: [{ fields: ["pay"], sign: 1 }],
		evidence:
			"`pay` is dollars and ranges 0 to 2,500,000 across the account's history; `job_points` beside it is the separate points figure.",
	}),
	rule({
		logId: 6222,
		label: "Director pay",
		category: "company",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 6263,
		label: "Company train sent",
		category: "company",
		...NEUTRAL,
	}),
	rule({
		logId: 6264,
		label: "Company train received",
		category: "company",
		...NEUTRAL,
	}),
	rule({
		logId: 6284,
		label: "Company deposit",
		category: "company",
		wallet: [{ fields: ["deposited"], sign: -1 }],
		account: {
			account: "company",
			terms: [{ fields: ["deposited"], sign: 1 }],
		},
	}),
	rule({
		logId: 6285,
		label: "Company withdrawal",
		category: "company",
		wallet: [{ fields: ["withdrawn"], sign: 1 }],
		account: {
			account: "company",
			terms: [{ fields: ["withdrawn"], sign: -1 }],
		},
	}),
	rule({
		logId: 6280,
		label: "Company founded",
		category: "company",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 6281,
		label: "Company stock pricing",
		category: "company",
		...NEUTRAL,
	}),
	rule({
		logId: 6282,
		label: "Company stock order",
		category: "company",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 6283,
		label: "Company advertising budget",
		category: "company",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 6290,
		label: "Company storage upgrade",
		category: "company",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 6291,
		label: "Company staff room upgrade",
		category: "company",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 6292,
		label: "Company size upgrade",
		category: "company",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 6293,
		label: "Company renamed",
		category: "company",
		...NEUTRAL,
	}),
	rule({
		logId: 6505,
		label: "Company special: item",
		category: "company",
		itemsIn: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 6525,
		label: "Company special: items",
		category: "company",
		itemsIn: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 6509,
		label: "Company special: money",
		category: "company",
		wallet: [{ fields: ["money_gained"], sign: 1 }],
	}),
	rule({
		logId: 6536,
		label: "Company special: bank time",
		category: "company",
		...NEUTRAL,
		priced: false,
	}),

	// ─── Bounties ──────────────────────────────────────────────────────────────
	rule({
		logId: 6700,
		label: "Bounty placed",
		category: "bounty",
		wallet: [{ fields: ["cost"], sign: -1 }],
		evidence:
			"`cost` is what left the wallet; `bounty_reward` is the headline figure only.",
	}),
	rule({
		logId: 6701,
		label: "Bounty placed on you",
		category: "bounty",
		...NEUTRAL,
		evidence:
			"A bounty placed on the player by someone else: the reward is theirs to pay, not the player's.",
	}),
	rule({
		logId: 6705,
		label: "Bounty expired",
		category: "bounty",
		...NEUTRAL,
		evidence:
			"The lister's notice that a bounty lapsed. The reward was taken at 6700 and returned at 6706, so booking this too would double it.",
	}),
	rule({
		logId: 6706,
		label: "Bounty expired (reward returned)",
		category: "bounty",
		wallet: [{ fields: ["bounty_reward"], sign: 1 }],
	}),
	rule({
		logId: 6710,
		label: "Bounty claimed",
		category: "bounty",
		wallet: [{ fields: ["bounty_reward"], sign: 1 }],
	}),
	rule({
		logId: 6711,
		label: "Your bounty was claimed",
		category: "bounty",
		...NEUTRAL,
		evidence:
			"The lister's notice that their bounty was claimed. The reward left the wallet at 6700 when it was placed, so this settles nothing.",
	}),
	rule({
		logId: 6712,
		label: "You were claimed",
		category: "bounty",
		...NEUTRAL,
		evidence:
			"The target's notice that a bounty on them was claimed — the target receives nothing.",
	}),

	// ─── Faction ───────────────────────────────────────────────────────────────
	// A faction balance is NOT an account the player owns: Torn's own net worth
	// excludes it. Money moved into it has genuinely left the player's wealth, so
	// the deposit is a plain wallet outflow with no second leg.
	rule({
		logId: 6726,
		label: "Faction deposit",
		category: "faction",
		wallet: [{ fields: ["money_deposited"], sign: -1 }],
		evidence:
			"2026-10-05: `6726 money_deposited 152,000,000` at 16:33:47, and my own faction balance becomes exactly 152,000,000 at 16:34:22.",
	}),
	rule({
		logId: 6727,
		label: "Faction points deposit",
		category: "faction",
		units: [{ unit: "points", fields: ["points_deposited"], sign: -1 }],
		priced: false,
	}),
	rule({
		logId: 6725,
		label: "Faction item deposit (legacy)",
		category: "faction",
		itemsOut: ["items", "item"],
		...NEUTRAL,
	}),
	rule({
		logId: 6728,
		label: "Faction item deposit",
		category: "faction",
		itemsOut: ["items", "item"],
		...NEUTRAL,
	}),
	rule({
		logId: 6730,
		label: "Faction item given (legacy)",
		category: "faction",
		itemsOut: ["item"],
		mirrorOf: 6731,
		...NEUTRAL,
	}),
	rule({
		logId: 6731,
		label: "Faction item received (legacy)",
		category: "faction",
		itemsIn: ["item"],
		mirrorOf: 6730,
		...NEUTRAL,
	}),
	rule({
		logId: 6732,
		label: "Faction items given",
		category: "faction",
		...NEUTRAL,
		evidence:
			"The send line: the items went to whichever member is named, and they came out of the faction armory, not the player's inventory. 6733 is the receive side and is the one that moves stock.",
	}),
	rule({
		logId: 6733,
		label: "Faction items received",
		category: "faction",
		itemsIn: ["item", "items"],
		...NEUTRAL,
		evidence:
			"The receive line, and it means one of two things: the player took items from the faction armory, or somebody sent them. Both put stock in the inventory. Row counts: 478 rows, 467 with `sender` = the player, 11 from others.",
	}),
	// Torn logs faction transfers twice, once from each side, into the same
	// personal log. The 2026-10-05 sequence proves it: a 152,000,000 deposit,
	// a distribution to members, my balance settling at 59,000,000, and then a
	// 6735/6736 pair at 16:36:33 both carrying `money_given: 59,000,000`.
	//
	// Which leg touched the wallet is exactly what the payload does not say, so
	// these are recorded and flagged rather than guessed. Booking a direction
	// would invent money in the wallet or in net worth that may never have moved.
	rule({
		logId: 6735,
		label: "Faction money given",
		category: "faction",
		...NEUTRAL,
		evidence:
			"The send line, and NOT the player's money: `receiver` can be any member (829 of 4,184 rows name somebody else), and the funds come out of the faction bank. 6736 is the receive side and the one to book.",
	}),
	rule({
		logId: 6736,
		label: "Faction money received",
		category: "faction",
		wallet: [{ fields: ["money_given"], sign: 1 }],
		evidence:
			"The receive line, and it means exactly one of two things: the player moved money from the faction to themselves, or somebody gave them faction money. Money arrives either way. Unlike 6795 it never carries `balance_change` (0 of 3,426 rows), so this is a payment rather than a faction-balance credit.",
	}),
	rule({
		logId: 6737,
		label: "Faction balance changed",
		category: "faction",
		mirrorOf: 6738,
		...NEUTRAL,
		priced: false,
		evidence:
			"Informational feed of faction balances. Booking it would double-count 6726, which already carries the wallet effect.",
	}),
	rule({
		logId: 6738,
		label: "Faction balance changed",
		category: "faction",
		mirrorOf: 6737,
		...NEUTRAL,
		priced: false,
		evidence:
			"The redundant half of the 6737/6738 pair: both fire in the same second with byte-identical payloads, so counting both doubles the record.",
	}),
	rule({
		logId: 6740,
		label: "Faction points given",
		category: "faction",
		units: [{ unit: "points", fields: ["points_given"], sign: -1 }],
		mirrorOf: 6741,
		priced: false,
	}),
	rule({
		logId: 6741,
		label: "Faction points received",
		category: "faction",
		units: [{ unit: "points", fields: ["points_given"] }],
		mirrorOf: 6740,
		priced: false,
	}),
	rule({
		logId: 6742,
		label: "Faction points balance changed",
		category: "faction",
		mirrorOf: 6743,
		...NEUTRAL,
		priced: false,
		evidence:
			"A faction POINTS balance changing, and its twin 6743 fires at the same moment. Faction points are not money, and the balance belongs to the faction.",
	}),
	rule({
		logId: 6743,
		label: "Faction points balance changed",
		category: "faction",
		mirrorOf: 6742,
		...NEUTRAL,
		priced: false,
		evidence: "The redundant half of the 6742/6743 pair.",
	}),
	rule({
		logId: 6745,
		label: "Faction item loan sent",
		category: "faction",
		itemsOut: ["item", "items"],
		...NEUTRAL,
	}),
	rule({
		logId: 6746,
		label: "Faction item loan received",
		category: "faction",
		itemsIn: ["item", "items"],
		...NEUTRAL,
	}),
	rule({
		logId: 6747,
		label: "Faction item loan returned",
		category: "faction",
		itemsIn: ["item", "items"],
		...NEUTRAL,
	}),
	rule({
		logId: 6748,
		label: "Faction item loan retrieved",
		category: "faction",
		itemsOut: ["item", "items"],
		...NEUTRAL,
	}),
	rule({
		logId: 6749,
		label: "Faction item loan retrieved",
		category: "faction",
		itemsIn: ["item", "items"],
		...NEUTRAL,
	}),
	rule({
		logId: 6794,
		label: "Faction organised crime payout",
		category: "faction",
		...NEUTRAL,
		priced: false,
		evidence:
			"The organised crime paying out, with `reward` as the pot and no per-player amount. Not a mirror of 6795: the two do not fire together (6795 fired alone on 2026-10-07 03:40:34) and only 6795 names a participant's share.",
	}),
	rule({
		logId: 6795,
		label: "Faction payout share received",
		category: "faction",
		...NEUTRAL,
		priced: false,
		evidence:
			"The player's cut of an organised crime, credited to a FACTION balance: every one of the 60 rows carries `balance_change` (0 of 3,426 on 6736 do). A faction balance is not an account the player owns, so this is recorded and flagged rather than booked as cash.",
	}),
	rule({
		logId: 6810,
		label: "Faction payday given",
		category: "faction",
		...NEUTRAL,
		evidence:
			"The payday send line, naming every `receivers`. Money leaving the faction bank is not the player's money leaving their pocket; 6811 is the receive side.",
	}),
	rule({
		logId: 6811,
		label: "Faction payday received",
		category: "faction",
		wallet: [{ fields: ["money_given"], sign: 1 }],
		evidence:
			"The payday receive line, shaped exactly like 6736 and like it carrying no `balance_change` (0 of 218 rows), so the money reaches the player rather than a faction balance. Row counts: 218 rows, 199 with `sender` = the player, 19 from others.",
	}),
	rule({
		logId: 6768,
		label: "Organised crime items used",
		category: "faction",
		itemsOut: ["items_used", "items", "item"],
		...NEUTRAL,
	}),

	// ─── Forums, messages, events, settings ────────────────────────────────────
	rule({
		logId: 7000,
		label: "Museum exchange",
		category: "events",
		units: [{ unit: "points", fields: ["points_received"] }],
		...NEUTRAL,
		priced: false,
		evidence:
			'Payload is `{ set: "Plushie Set", quantity: 60, points_received: 600 }`: a named set is traded for points. The set is not item ids, so what left the inventory cannot be established and the event is flagged rather than half-booked.',
	}),
	rule({
		logId: 7070,
		label: "Article submitted",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 7075,
		label: "Elimination headline",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 7100,
		label: "Classified advert",
		category: "events",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 7110,
		label: "Image advert",
		category: "events",
		wallet: [{ fields: ["cost", "price"], sign: -1 }],
		priced: false,
	}),
	rule({
		logId: 7121,
		label: "Image advert accepted",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 7200, label: "Message sent", category: "events", ...NEUTRAL }),
	rule({
		logId: 7201,
		label: "Message received",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 7205, label: "Message read", category: "events", ...NEUTRAL }),
	rule({ logId: 7215, label: "Message saved", category: "events", ...NEUTRAL }),
	rule({
		logId: 7216,
		label: "Saved message deleted",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 7300, label: "Event deleted", category: "events", ...NEUTRAL }),
	rule({ logId: 7301, label: "Event sent", category: "events", ...NEUTRAL }),
	rule({
		logId: 7302,
		label: "Event received",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 7305, label: "Event deleted", category: "events", ...NEUTRAL }),
	rule({ logId: 7310, label: "Event saved", category: "events", ...NEUTRAL }),
	rule({
		logId: 7311,
		label: "Saved event deleted",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 7322, label: "Event saved", category: "events", ...NEUTRAL }),
	rule({ logId: 7323, label: "Event unsaved", category: "events", ...NEUTRAL }),

	// ─── Missions ──────────────────────────────────────────────────────────────
	rule({
		logId: 7800,
		label: "Mission accepted",
		category: "missions",
		...NEUTRAL,
	}),
	rule({
		logId: 7805,
		label: "Mission declined",
		category: "missions",
		...NEUTRAL,
	}),
	rule({
		logId: 7810,
		label: "Mission failed",
		category: "missions",
		...NEUTRAL,
	}),
	rule({
		logId: 7815,
		label: "Mission completed",
		category: "missions",
		wallet: [{ fields: ["money"], sign: 1 }],
	}),
	rule({
		logId: 7900,
		label: "Mission reward: item",
		category: "missions",
		itemsIn: ["item", "items"],
		...NEUTRAL,
	}),
	rule({
		logId: 7905,
		label: "Mission reward: ammo",
		category: "missions",
		units: [{ unit: "ammo", fields: ["quantity", "amount"] }],
		priced: false,
	}),
	rule({
		logId: 7910,
		label: "Mission reward: mod",
		category: "missions",
		itemsIn: ["item", "items"],
		...NEUTRAL,
	}),
	rule({
		logId: 7609,
		label: "Job points prize",
		category: "missions",
		...NEUTRAL,
		priced: false,
	}),

	// ─── Attacks ───────────────────────────────────────────────────────────────
	rule({ logId: 8100, label: "Attack lost", category: "attacks", ...NEUTRAL }),
	rule({
		logId: 8101,
		label: "Attack lost (received)",
		category: "attacks",
		...NEUTRAL,
	}),
	rule({
		logId: 8105,
		label: "Attack stalemate",
		category: "attacks",
		...NEUTRAL,
	}),
	rule({
		logId: 8106,
		label: "Attack stalemate (received)",
		category: "attacks",
		...NEUTRAL,
	}),
	rule({
		logId: 8111,
		label: "Attack timed out",
		category: "attacks",
		...NEUTRAL,
	}),
	rule({
		logId: 8115,
		label: "Attack escaped",
		category: "attacks",
		...NEUTRAL,
	}),
	rule({
		logId: 8116,
		label: "Attack escaped (received)",
		category: "attacks",
		...NEUTRAL,
	}),
	rule({
		logId: 8140,
		label: "Attack failed",
		category: "attacks",
		...NEUTRAL,
	}),
	rule({
		logId: 8141,
		label: "Attack failed (received)",
		category: "attacks",
		...NEUTRAL,
	}),
	rule({
		logId: 8145,
		label: "Attack assist",
		category: "attacks",
		...NEUTRAL,
	}),
	rule({ logId: 8150, label: "Attack left", category: "attacks", ...NEUTRAL }),
	rule({
		logId: 8151,
		label: "Attack left (received)",
		category: "attacks",
		...NEUTRAL,
	}),
	rule({
		logId: 8155,
		label: "Mugging",
		category: "attacks",
		wallet: [{ fields: ["money_mugged"], sign: 1 }],
	}),
	rule({
		logId: 8156,
		label: "Mugged",
		category: "attacks",
		wallet: [{ fields: ["money_mugged"], sign: -1 }],
		evidence:
			"Payload names the `attacker` and adds `hospital_time_increased`, so this is the victim's copy: 8155 is the money arriving, 8156 is the same money leaving. Recording it as neutral hid every mugging from the ledger.",
	}),
	rule({
		logId: 8160,
		label: "Hospitalised a target",
		category: "attacks",
		...NEUTRAL,
	}),
	rule({
		logId: 8161,
		label: "Hospitalised by a target",
		category: "attacks",
		...NEUTRAL,
	}),
	rule({
		logId: 8170,
		label: "Loot received",
		category: "attacks",
		itemsIn: ["item", "items"],
		...NEUTRAL,
	}),

	// ─── Casino ────────────────────────────────────────────────────────────────
	// Slots, roulette and keno have no separate "bet placed" log: the stake leaves
	// the wallet when the round resolves, so the win log nets the payout against
	// the stake and the lose log is the stake alone.
	rule({
		logId: 8300,
		label: "Slots win",
		category: "casino",
		wallet: [
			{ fields: ["won_amount"], sign: 1 },
			{ fields: ["bet_amount"], sign: -1 },
		],
	}),
	rule({
		logId: 8301,
		label: "Slots loss",
		category: "casino",
		wallet: [{ fields: ["bet_amount"], sign: -1 }],
	}),
	rule({
		logId: 8305,
		label: "Roulette win",
		category: "casino",
		wallet: [
			{ fields: ["won_amount"], sign: 1 },
			{ fields: ["bet_amount"], sign: -1 },
		],
	}),
	rule({
		logId: 8306,
		label: "Roulette loss",
		category: "casino",
		wallet: [{ fields: ["bet_amount"], sign: -1 }],
	}),
	rule({
		logId: 8320,
		label: "Keno win",
		category: "casino",
		wallet: [
			{ fields: ["won_amount"], sign: 1 },
			{ fields: ["bet_amount"], sign: -1 },
		],
	}),
	// High-low keeps a running pot. `8310 start` is the stake leaving the wallet;
	// the per-round logs carry a pot COUNTER that only looks like money at low
	// stakes. A 2024-12-21 session bets 10 and climbs 10 → 12 → 15 → 18 → 22,
	// matching `pot_increase` 2,3,3,4 exactly, which is how we know `pot` here is
	// a running total that only becomes cash at cash-in.
	rule({
		logId: 8310,
		label: "High-low stake",
		category: "casino",
		wallet: [{ fields: ["bet_amount"], sign: -1 }],
	}),
	rule({
		logId: 8311,
		label: "High-low round lost",
		category: "casino",
		...NEUTRAL,
		evidence:
			"A high-low round. `pot` here is the running multiplier counter, not money — a $10 session climbs 10, 12, 15, 18, 22, matching `pot_increase` 2, 3, 3, 4. Only 8310 stakes and 8314/8315 cash in.",
	}),
	rule({
		logId: 8312,
		label: "High-low round drawn",
		category: "casino",
		...NEUTRAL,
		evidence:
			"A high-low draw. `pot` is the running counter, and a draw adds nothing to it.",
	}),
	rule({
		logId: 8313,
		label: "High-low round won",
		category: "casino",
		...NEUTRAL,
		evidence:
			"A high-low round won. `pot` is the running counter that grows here; the cash only appears at 8314/8315 cash-in.",
	}),
	rule({
		logId: 8314,
		label: "High-low cashed in",
		category: "casino",
		wallet: [{ fields: ["pot"], sign: 1 }],
	}),
	rule({
		logId: 8315,
		label: "High-low cashed in (half)",
		category: "casino",
		wallet: [{ fields: ["pot"], sign: 1 }],
	}),
	rule({
		logId: 8340,
		label: "Lottery ticket",
		category: "casino",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	// Blackjack: the stake leaves at the deal (8350), doubles at 8352, and the
	// insurance side bet at 8356. The win returns the stake plus the win.
	rule({
		logId: 8350,
		label: "Blackjack deal",
		category: "casino",
		wallet: [{ fields: ["bet"], sign: -1 }],
	}),
	rule({ logId: 8351, label: "Blackjack hit", category: "casino", ...NEUTRAL }),
	rule({
		logId: 8352,
		label: "Blackjack double down",
		category: "casino",
		wallet: [{ fields: ["bet"], sign: -1 }],
	}),
	rule({
		logId: 8354,
		label: "Blackjack loss",
		category: "casino",
		...NEUTRAL,
		evidence:
			"A blackjack loss. The stake left the wallet at the deal (8350) and again at any double down (8352), so the losing hand itself moves nothing.",
	}),
	rule({
		logId: 8355,
		label: "Blackjack win",
		category: "casino",
		wallet: [{ fields: ["winnings"], sign: 1 }],
	}),
	rule({
		logId: 8356,
		label: "Blackjack insurance lost",
		category: "casino",
		wallet: [{ fields: ["bet"], sign: -1 }],
	}),
	rule({
		logId: 8357,
		label: "Blackjack insurance won",
		category: "casino",
		wallet: [{ fields: ["winnings"], sign: 1 }],
	}),
	rule({
		logId: 8358,
		label: "Blackjack push",
		category: "casino",
		wallet: [{ fields: ["money"], sign: 1 }],
	}),
	rule({
		logId: 8353,
		label: "Blackjack split",
		category: "casino",
		...NEUTRAL,
		evidence:
			"Splitting a hand puts a second stake on the table; it is taken by the follow-up deal rather than logged here.",
	}),
	// Wheel: one paid spin, then whatever it paid out.
	rule({
		logId: 8370,
		label: "Wheel spin",
		category: "casino",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 8371,
		label: "Wheel free spin",
		category: "casino",
		...NEUTRAL,
	}),
	rule({
		logId: 8372,
		label: "Wheel spin (nothing)",
		category: "casino",
		...NEUTRAL,
	}),
	rule({
		logId: 8373,
		label: "Wheel spin (hospital)",
		category: "casino",
		...NEUTRAL,
	}),
	rule({
		logId: 8374,
		label: "Wheel spin won money",
		category: "casino",
		wallet: [{ fields: ["money"], sign: 1 }],
	}),
	rule({
		logId: 8375,
		label: "Wheel spin won points",
		category: "casino",
		units: [{ unit: "points", fields: ["points"] }],
		priced: false,
	}),
	rule({
		logId: 8376,
		label: "Wheel spin won tokens",
		category: "casino",
		units: [{ unit: "casino_tokens", fields: ["casino_tokens_increased"] }],
		priced: false,
	}),
	rule({
		logId: 8377,
		label: "Wheel spin won item",
		category: "casino",
		itemsIn: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 8378,
		label: "Wheel spin won property",
		category: "casino",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 8379,
		label: "Wheel spin won honour bar",
		category: "casino",
		...NEUTRAL,
	}),
	// Russian roulette: the stake leaves at start/join; the pot arrives on a win.
	rule({
		logId: 8390,
		label: "Russian roulette started",
		category: "casino",
		wallet: [{ fields: ["bet_amount"], sign: -1 }],
	}),
	rule({
		logId: 8391,
		label: "Russian roulette joined",
		category: "casino",
		wallet: [{ fields: ["bet_amount"], sign: -1 }],
	}),
	rule({
		logId: 8392,
		label: "Russian roulette opponent joined",
		category: "casino",
		...NEUTRAL,
		evidence:
			"The opponent joining a russian roulette game. Their stake is taken from their wallet, not the player's — 8390 and 8391 are the player's own buy-ins.",
	}),
	rule({
		logId: 8393,
		label: "Russian roulette result",
		category: "casino",
		...NEUTRAL,
	}),
	rule({
		logId: 8394,
		label: "Russian roulette opponent result",
		category: "casino",
		...NEUTRAL,
	}),
	rule({
		logId: 8395,
		label: "Russian roulette won",
		category: "casino",
		wallet: [{ fields: ["pot"], sign: 1 }],
	}),
	rule({
		logId: 8396,
		label: "Russian roulette lost",
		category: "casino",
		...NEUTRAL,
		evidence:
			"A russian roulette loss. The stake was taken at 8390/8391; losing simply does not return a pot.",
	}),
	rule({
		logId: 8398,
		label: "Russian roulette opponent timed out",
		category: "casino",
		...NEUTRAL,
	}),
	// Poker: chips move between the wallet and the table only on join and leave.
	// Proved on a real pair: join `value` 1,000,000, leave `value` 1,007,500, and
	// a `8435 poker win` of exactly 7,500 — the win is already inside the leave.
	rule({
		logId: 8410,
		label: "Poker buy-in",
		category: "casino",
		wallet: [{ fields: ["value"], sign: -1 }],
	}),
	rule({
		logId: 8411,
		label: "Poker cash-out",
		category: "casino",
		wallet: [{ fields: ["value"], sign: 1 }],
	}),
	rule({
		logId: 8415,
		label: "Poker small blind",
		category: "casino",
		...NEUTRAL,
		evidence:
			"Chips moving inside the poker table. The wallet only changes at 8410 buy-in and 8411 cash-out, and a real pair proves it: join 1,000,000, leave 1,007,500, hand win 7,500 — the win is already inside the cash-out.",
	}),
	rule({
		logId: 8416,
		label: "Poker big blind",
		category: "casino",
		...NEUTRAL,
		evidence:
			"Chips moving inside the poker table, like 8415. No wallet movement until the player cashes out.",
	}),
	rule({
		logId: 8426,
		label: "Poker fold",
		category: "casino",
		...NEUTRAL,
		evidence:
			"Folding moves chips only within the table; the wallet is untouched until 8411.",
	}),
	rule({
		logId: 8427,
		label: "Poker call",
		category: "casino",
		...NEUTRAL,
		evidence:
			"Calling moves chips only within the table; the wallet is untouched until 8411.",
	}),
	rule({
		logId: 8428,
		label: "Poker bet",
		category: "casino",
		...NEUTRAL,
		evidence:
			"Betting moves chips only within the table; the wallet is untouched until 8411.",
	}),
	rule({
		logId: 8429,
		label: "Poker raise",
		category: "casino",
		...NEUTRAL,
		evidence:
			"Raising moves chips only within the table; the wallet is untouched until 8411.",
	}),
	rule({
		logId: 8435,
		label: "Poker hand won",
		category: "casino",
		...NEUTRAL,
		evidence:
			"Folding moves chips only within the table; the wallet is untouched until 8411.",
	}),
	rule({
		logId: 8437,
		label: "Poker timed out",
		category: "casino",
		...NEUTRAL,
	}),
	rule({ logId: 8440, label: "Poker sat out", category: "casino", ...NEUTRAL }),
	rule({ logId: 8441, label: "Poker sat in", category: "casino", ...NEUTRAL }),

	// ─── Bookie ────────────────────────────────────────────────────────────────
	// Each pair declares both legs, so a bet is a transfer rather than an expense.
	rule({
		logId: 8450,
		label: "Bookie bet",
		category: "bookie",
		wallet: [{ fields: ["bet"], sign: -1 }],
		account: { account: "bookie", terms: [{ fields: ["bet"], sign: 1 }] },
	}),
	rule({
		logId: 8451,
		label: "Bookie bet lost",
		category: "bookie",
		...NEUTRAL,
		evidence:
			"The legacy form of 8461: the stake was taken at 8450, so the loss itself moves nothing.",
	}),
	rule({
		logId: 8452,
		label: "Bookie bet won",
		category: "bookie",
		account: { account: "bookie", terms: [{ fields: ["winnings"], sign: 1 }] },
	}),
	rule({
		logId: 8453,
		label: "Bookie bet refunded",
		category: "bookie",
		account: { account: "bookie", terms: [{ fields: ["bet"], sign: 1 }] },
	}),
	rule({
		logId: 8455,
		label: "Bookie withdrawal",
		category: "bookie",
		wallet: [{ fields: ["withdrawn"], sign: 1 }],
		account: {
			account: "bookie",
			terms: [{ fields: ["withdrawn"], sign: -1 }],
		},
	}),
	rule({
		logId: 8460,
		label: "Bookie bet",
		category: "bookie",
		wallet: [{ fields: ["bet"], sign: -1 }],
		account: { account: "bookie", terms: [{ fields: ["bet"], sign: 1 }] },
	}),
	rule({
		logId: 8461,
		label: "Bookie bet lost",
		category: "bookie",
		...NEUTRAL,
		evidence:
			"A bookie bet that lost. The stake left the wallet at 8460 when the bet was placed, so settling it moves nothing — which is why a losing bet and a winning one differ only in what the bookie balance does.",
	}),
	rule({
		logId: 8462,
		label: "Bookie bet won",
		category: "bookie",
		account: { account: "bookie", terms: [{ fields: ["winnings"], sign: 1 }] },
	}),
	rule({
		logId: 8463,
		label: "Bookie bet refunded",
		category: "bookie",
		account: { account: "bookie", terms: [{ fields: ["bet"], sign: 1 }] },
	}),
	rule({
		logId: 8465,
		label: "Bookie withdrawal",
		category: "bookie",
		wallet: [{ fields: ["withdrawn"], sign: 1 }],
		account: {
			account: "bookie",
			terms: [{ fields: ["withdrawn"], sign: -1 }],
		},
	}),

	// ─── Racing ────────────────────────────────────────────────────────────────
	rule({
		logId: 8700,
		label: "Race car enlisted",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8701,
		label: "Race car unenlisted",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8702,
		label: "Race car renamed",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8705,
		label: "Race car upgraded",
		category: "racing",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 8706,
		label: "Race car upgrade removed",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8710,
		label: "Custom race created",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8711,
		label: "Custom race joined",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8715,
		label: "Official race joined",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8720,
		label: "Custom race left",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8721,
		label: "Official race left",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8725,
		label: "Race car changed",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8730,
		label: "Custom race finished",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8731,
		label: "Official race finished",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8732,
		label: "Racing skill up",
		category: "racing",
		...NEUTRAL,
	}),
	rule({
		logId: 8733,
		label: "Racing personal best",
		category: "racing",
		...NEUTRAL,
	}),
	rule({ logId: 8735, label: "Race crashed", category: "racing", ...NEUTRAL }),
	rule({
		logId: 8740,
		label: "Race join fee",
		category: "racing",
		wallet: [{ fields: ["join_fee"], sign: -1 }],
	}),
	rule({
		logId: 8742,
		label: "Race winnings",
		category: "racing",
		wallet: [{ fields: ["money", "winnings", "amount"], sign: 1 }],
		priced: false,
	}),
	rule({
		logId: 8745,
		label: "Racing class up",
		category: "racing",
		...NEUTRAL,
	}),

	// ─── Token shop ────────────────────────────────────────────────────────────
	rule({
		logId: 8800,
		label: "Token shop: honour",
		category: "events",
		units: [{ unit: "tokens", fields: ["cost"] }],
		priced: false,
		evidence:
			"`cost` here is paid in casino tokens, not dollars — a token shop purchase never touches the wallet.",
	}),
	rule({
		logId: 8802,
		label: "Token shop: backdrop",
		category: "events",
		...NEUTRAL,
		priced: false,
		evidence: "`cost` here is paid in casino tokens, not dollars.",
	}),
	rule({
		logId: 8803,
		label: "Token shop: hairstyle equipped",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8804,
		label: "Token shop: backdrop changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8805,
		label: "Token shop: hairstyle unequipped",
		category: "events",
		...NEUTRAL,
	}),

	// ─── Seasonal events ───────────────────────────────────────────────────────
	rule({
		logId: 8930,
		label: "Christmas town: item found",
		category: "events",
		itemsIn: ["item"],
		...NEUTRAL,
	}),
	rule({
		logId: 8931,
		label: "Christmas town: key found",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8932,
		label: "Christmas town: chest opened",
		category: "events",
		...NEUTRAL,
		priced: false,
		evidence:
			"Opening a Christmas town chest. What comes out arrives in its own logs.",
	}),
	rule({
		logId: 8933,
		label: "Christmas town: reward",
		category: "events",
		wallet: [{ fields: ["money"], sign: 1 }],
		itemsIn: ["items"],
	}),
	rule({
		logId: 8934,
		label: "Christmas town: purchase",
		category: "events",
		wallet: [{ fields: ["cost"], sign: -1 }],
		itemsIn: ["item", "items"],
	}),
	rule({
		logId: 8935,
		label: "Christmas town: ornament purchased",
		category: "events",
		...NEUTRAL,
		priced: false,
		evidence:
			"Buying a Christmas town ornament with event currency, not with the wallet.",
	}),
	rule({
		logId: 8936,
		label: "Christmas town: pot deposit",
		category: "events",
		itemsOut: ["item", "items"],
		...NEUTRAL,
	}),
	rule({
		logId: 8937,
		label: "Christmas town: ornament",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8938,
		label: "Christmas town: items",
		category: "events",
		itemsIn: ["item", "items"],
		...NEUTRAL,
	}),
	rule({
		logId: 8939,
		label: "Christmas town: bucks",
		category: "events",
		...NEUTRAL,
		priced: false,
		evidence:
			"`bucks` is Christmas town currency, spendable only inside the minigame. It is not dollars and never reaches the wallet.",
	}),
	rule({
		logId: 8940,
		label: "Christmas town: money",
		category: "events",
		wallet: [{ fields: ["money"], sign: 1 }],
	}),
	rule({
		logId: 8941,
		label: "Christmas town: ornament",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8945,
		label: "Christmas town: coupon",
		category: "events",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 8946,
		label: "Christmas town: coupon exchanged",
		category: "events",
		...NEUTRAL,
		priced: false,
		evidence:
			"Exchanging Christmas town coupons for other event currency, inside the minigame.",
	}),
	rule({
		logId: 8920,
		label: "Anniversary cake",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8921,
		label: "Anniversary cake",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8922,
		label: "Anniversary cake",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8923,
		label: "Anniversary cake",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8960,
		label: "Easter egg found",
		category: "events",
		itemsIn: ["item", "egg"],
		...NEUTRAL,
	}),
	rule({
		logId: 8980,
		label: "Easter egg found",
		category: "events",
		itemsIn: ["item", "egg"],
		...NEUTRAL,
	}),
	// The used-egg ids 8981-8988 are declared in the consumables table below,
	// where they belong: each spends a stack the player already owns.

	// ─── Hallowe'en basket ─────────────────────────────────────────────────────
	rule({
		logId: 2535,
		label: "Hallowe'en basket used",
		category: "items",
		...NEUTRAL,
		priced: false,
		evidence:
			"Using a Hallowe'en basket. The basket and its contents are event items, and the treats it yields are recorded by 2536.",
	}),
	rule({
		logId: 2536,
		label: "Hallowe'en treats received",
		category: "items",
		units: [{ unit: "treats", fields: ["treats"] }],
		priced: false,
	}),
	rule({
		logId: 2538,
		label: "Hallowe'en basket evolved",
		category: "items",
		...NEUTRAL,
	}),
	rule({
		logId: 2540,
		label: "Hallowe'en basket upgraded",
		category: "items",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({
		logId: 2545,
		label: "Hallowe'en basket reward",
		category: "items",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 2546,
		label: "Hallowe'en basket reward",
		category: "items",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 2547,
		label: "Hallowe'en basket reward",
		category: "items",
		...NEUTRAL,
		priced: false,
	}),
	rule({
		logId: 2548,
		label: "Hallowe'en basket item",
		category: "items",
		itemsIn: ["item"],
		...NEUTRAL,
	}),

	// ─── Miscellaneous cash movements ──────────────────────────────────────────
	rule({
		logId: 300,
		label: "Name change",
		category: "events",
		wallet: [{ fields: ["cost"], sign: -1 }],
	}),
	rule({ logId: 301, label: "Email change", category: "events", ...NEUTRAL }),
	rule({
		logId: 302,
		label: "Email validated",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 303,
		label: "Password changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 305, label: "Gender changed", category: "events", ...NEUTRAL }),
	rule({ logId: 306, label: "Name changed", category: "events", ...NEUTRAL }),
	rule({
		logId: 310,
		label: "Security panel entry",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 311,
		label: "Security panel failure",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 312, label: "2FA changed", category: "events", ...NEUTRAL }),
	rule({
		logId: 313,
		label: "Device authorisation changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 314,
		label: "Mobile number changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 315,
		label: "Birth date changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 316,
		label: "Secret question changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 317,
		label: "Authenticator changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 320,
		label: "Login widgets changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 321,
		label: "Honour names changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 323,
		label: "Revive preference changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 325,
		label: "Attack preferences changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 328,
		label: "Navigation preference changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 331,
		label: "Icon order changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 332,
		label: "Icon size changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 333, label: "Icon refresh", category: "events", ...NEUTRAL }),
	rule({
		logId: 340,
		label: "Newsletter resent",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 341,
		label: "Email subscriptions changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 345, label: "API key reset", category: "events", ...NEUTRAL }),
	rule({ logId: 346, label: "API key added", category: "events", ...NEUTRAL }),
	rule({
		logId: 347,
		label: "API key deleted",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 348,
		label: "API key paused/unpaused",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 350,
		label: "Profile signature changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 351,
		label: "Signature preference changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 355,
		label: "Forum signature changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 356,
		label: "Signature viewing preference",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 360,
		label: "Display preference changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 361,
		label: "Real name changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 362,
		label: "Country changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 363, label: "City changed", category: "events", ...NEUTRAL }),
	rule({ logId: 364, label: "Age changed", category: "events", ...NEUTRAL }),
	rule({
		logId: 370,
		label: "Gallery image uploaded",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 371,
		label: "Gallery image edited",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 373,
		label: "Gallery image deleted",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 400,
		label: "Seasonal newsletter",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 401,
		label: "Newsletter energy bonus",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 410,
		label: "Inactive update",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 500, label: "Captcha passed", category: "events", ...NEUTRAL }),
	rule({ logId: 501, label: "Captcha failed", category: "events", ...NEUTRAL }),
	rule({ logId: 101, label: "Login", category: "events", ...NEUTRAL }),
	rule({ logId: 102, label: "Failed login", category: "events", ...NEUTRAL }),
	rule({ logId: 103, label: "Logout", category: "events", ...NEUTRAL }),
	rule({
		logId: 104,
		label: "Logged out everywhere",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 105,
		label: "Inactive refills",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 106,
		label: "Development server accessed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 110,
		label: "Password reset requested",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 111, label: "Password reset", category: "events", ...NEUTRAL }),
	rule({ logId: 120, label: "2FA code sent", category: "events", ...NEUTRAL }),
	rule({
		logId: 121,
		label: "2FA code entered",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 122,
		label: "2FA code failed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 123,
		label: "2FA secret question passed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 124,
		label: "2FA secret question failed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 125,
		label: "2FA email code sent",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 126,
		label: "2FA email code entered",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 130,
		label: "2FA authenticator entered",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 5750, label: "Friend added", category: "events", ...NEUTRAL }),
	rule({
		logId: 5751,
		label: "Friend removed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5752,
		label: "Friend description changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5753,
		label: "Friend added automatically",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 5755, label: "Enemy added", category: "events", ...NEUTRAL }),
	rule({ logId: 5756, label: "Enemy removed", category: "events", ...NEUTRAL }),
	rule({
		logId: 5757,
		label: "Enemy description changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 5758,
		label: "Enemy exchanges changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 5760, label: "Target added", category: "events", ...NEUTRAL }),
	rule({
		logId: 5761,
		label: "Target removed",
		category: "events",
		...NEUTRAL,
	}),
	rule({ logId: 7150, label: "Ignored", category: "events", ...NEUTRAL }),
	rule({ logId: 7151, label: "Unignored", category: "events", ...NEUTRAL }),
	rule({ logId: 8820, label: "Report sent", category: "events", ...NEUTRAL }),
	rule({
		logId: 8840,
		label: "Energy maximum changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8841,
		label: "Energy maximum changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8842,
		label: "Nerve maximum changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8843,
		label: "Nerve maximum changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8844,
		label: "Happy maximum changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8845,
		label: "Happy maximum changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8846,
		label: "Life maximum changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8847,
		label: "Life maximum changed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8000,
		label: "Account closed",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8001,
		label: "Account reopened",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8005,
		label: "Account deleted",
		category: "events",
		...NEUTRAL,
	}),
	rule({
		logId: 8010,
		label: "Account recovered",
		category: "events",
		...NEUTRAL,
	}),
];

/**
 * The `Item use` family.
 *
 * These consume a stack the player already owns. The expense was recognised when
 * the item was bought, so booking another cost here would charge for it twice;
 * the ledger records the item leaving and nothing else. The ids are generated
 * rather than listed because Torn allocates them densely and a missed one would
 * be a silently unrecorded item movement.
 *
 * A few of these containers PAY OUT, and those are excluded here and given
 * explicit rules instead — see `PAYING_CONSUMABLE_IDS`.
 */
function ITEM_USE_RULES(): WealthRule[] {
	const ids: Array<[number, string]> = [
		[2020, "Candy"],
		[2030, "Alcohol"],
		[2040, "Energy drink"],
		[2050, "Book"],
		[2051, "Book finished"],
		[2052, "Book: strength"],
		[2053, "Book: speed"],
		[2054, "Book: defense"],
		[2055, "Book: dexterity"],
		[2056, "Book: working stats"],
		[2057, "Book: list capacity"],
		[2058, "Book: merit reset"],
		[2060, "Morphine"],
		[2070, "First aid kit"],
		[2080, "Small first aid kit"],
		[2090, "Neumune tablet"],
		[2100, "Blood bag"],
		[2101, "Blood bag (wrong type)"],
		[2102, "Blood bag (irradiated)"],
		[2105, "Ipecac syrup"],
		[2110, "Lawyer's business card"],
		[2130, "Skateboard"],
		[2150, "Dumbbells"],
		[2170, "Gift card"],
		[2180, "Erotic DVD"],
		[2190, "Feathery hotel coupon"],
		[2200, "Cannabis"],
		[2201, "Cannabis overdose"],
		[2210, "Ecstasy"],
		[2211, "Ecstasy overdose"],
		[2220, "Ketamine"],
		[2221, "Ketamine overdose"],
		[2230, "LSD"],
		[2231, "LSD overdose"],
		[2240, "Opium"],
		[2250, "PCP"],
		[2260, "Shrooms"],
		[2261, "Shrooms overdose"],
		[2270, "Speed"],
		[2271, "Speed overdose"],
		[2280, "Vicodin"],
		[2281, "Vicodin overdose"],
		[2290, "Xanax"],
		[2291, "Xanax overdose"],
		[2295, "Love juice"],
		[2300, "Dog poop"],
		[2302, "Dog poop (target)"],
		[2310, "Stink bombs"],
		[2312, "Stink bombs (target)"],
		[2320, "Toilet paper"],
		[2322, "Toilet paper (target)"],
		[2323, "Toilet paper (failed)"],
		[2330, "Donator pack"],
		[2340, "Empty blood bag"],
		[2350, "Box of grenades"],
		[2360, "Box of medical supplies"],
		[2370, "Lottery voucher"],
		[2390, "Drug pack"],
		[2400, "Goodie bag"],
		[2405, "Wallet"],
		[2407, "Stash box"],
		[2410, "Box of tissues"],
		[2430, "Casino pass"],
		[2443, "Dirty bomb radiation"],
		[2450, "Cake frosting / lock picking kit"],
		[2460, "Felovax"],
		[2470, "Zylkene"],
		[2480, "Duke's safe"],
		[2500, "Keg of beer"],
		[2501, "Keg of beer (empty)"],
		[2510, "Six pack of alcohol"],
		[2520, "Six pack of energy drink"],
		[2525, "Tin of treats"],
		[2613, "Christmas cracker (target lost)"],
		[2615, "Cache"],
		[8981, "Green Easter egg"],
		[8982, "Red Easter egg"],
		[8983, "Yellow Easter egg"],
		[8985, "Black Easter egg"],
		[8986, "Blue Easter egg"],
		[8987, "White Easter egg"],
		[8988, "Brown Easter egg"],
	];
	return ids
		.filter(([logId]) => !PAYING_CONSUMABLE_IDS.has(logId))
		.map(([logId, label]) =>
			rule({
				logId,
				label: `Used ${label}`,
				category: "consumables",
				itemsOut: ["item"],
				...NEUTRAL,
				evidence:
					"Consumable: the cost was recognised at acquisition, so the ledger records the item leaving without booking a second expense.",
			}),
		);
}

const RULE_BY_ID = new Map<number, WealthRule>(
	WEALTH_LOG_RULES.map((entry) => [entry.logId, entry]),
);

/** The rule for a log id, or `null` when neither a rule nor a band covers it. */
export function getWealthRule(logId: number): WealthRule | null {
	return RULE_BY_ID.get(logId) ?? null;
}

/**
 * The band a log id falls in.
 *
 * Bands describe where a log sits, not what it costs, so an unmatched type is
 * still filed under the right category and reported as unpriced.
 */
export function getWealthBand(
	logId: number,
): { category: WealthCategory; priced: false } | null {
	for (const band of WEALTH_LOG_BANDS) {
		if (logId >= band.from && logId <= band.to) {
			return { category: band.category, priced: false };
		}
	}
	return null;
}

/**
 * Whether a mirror log should be counted.
 *
 * Torn writes faction transfers twice; counting both doubles the flow. The lower
 * id of the pair is kept and the higher one dropped, which is deterministic and
 * does not depend on arrival order.
 */
export function resolveMirror(rule: WealthRule): boolean {
	if (rule.mirrorOf === undefined) return true;
	return rule.logId < rule.mirrorOf;
}
