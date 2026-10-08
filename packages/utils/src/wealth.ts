import {
	getWealthBand,
	getWealthRule,
	payloadCarriesValue,
	resolveMirror,
	type WealthAccount,
	type WealthCategory,
	type WealthItemFields,
	type WealthMoneyTerm,
	type WealthRule,
} from "./wealth-rules";

/**
 * The wealth engine: turns one Torn personal log into one ledger event.
 *
 * THE ONE IDEA
 *
 * A log does not have a "value". It has up to four independent effects — money
 * leaving the wallet, money moving between balances the player still owns, items
 * arriving, items leaving — and the number a reader cares about is the change in
 * NET WORTH, which is all four together:
 *
 *     netWorthDelta = walletDelta + accountDelta + itemsInValue - itemsOutValue
 *
 * That single formula is what makes the awkward cases fall out correctly instead
 * of needing a special case each:
 *
 *   - Buying an item at market price is a swap: cash out, item in, net zero.
 *     Buying below market is a real gain, and the same formula says so.
 *   - A crime drop is a gain of the item's market value with no cash at all —
 *     the "getting items for free" case.
 *   - A bazaar sale is cash in minus the item that left, which is the realised
 *     profit, without ever needing a stored cost basis.
 *   - A bookie bet is wallet out, bookie balance in, net zero. It only becomes a
 *     gain or a loss when the bet settles.
 *
 * WHAT IT REFUSES TO DO
 *
 * Invent numbers. Torn renames payload fields between log generations, sometimes
 * omits them, and in at least one case stores prose where a number belongs
 * (`5555 Subscription success` carries `value: "4.00 GBP ($4.85)"`). Every read
 * goes through `readNumber`, which returns null rather than zero, and an event
 * whose amount cannot be established is recorded with `priced: false`. Those
 * events still reach the ledger so the coverage report can show what is missing,
 * because a silent zero reads as "nothing happened".
 *
 * Nothing here touches the database. The engine takes rows in and gives events
 * out, which is what makes the whole rule table testable against captured
 * payloads.
 */

/** The shape the worker reads out of `personal_logs`. */
export type WealthLogRow = {
	id: string;
	log: number;
	title: string | null;
	timestamp: Date;
	/** The stored log object: `{ id, data, params, details, timestamp }`. */
	data: unknown;
};

export type WealthItemRef = {
	itemId: string;
	quantity: number;
	uid: number | null;
};

export type WealthUnitRef = {
	unit: string;
	quantity: number;
};

export type WealthEvent = {
	/** `ledger_ev_<logId>`, stable so re-ingesting is idempotent. */
	id: string;
	logId: string;
	logType: number;
	timestamp: Date;
	category: WealthCategory;
	label: string;
	walletDelta: number;
	account: WealthAccount | null;
	accountDelta: number;
	itemsIn: WealthItemRef[];
	itemsOut: WealthItemRef[];
	units: WealthUnitRef[];
	/** Market value of `itemsIn`, in dollars. Zero when nothing could be priced. */
	itemsInValue: number;
	itemsOutValue: number;
	netWorthDelta: number;
	/** False when any part of the effect could not be established. */
	priced: boolean;
	/** True when this row is the redundant half of a Torn mirror pair. */
	mirrored: boolean;
	/** True when no rule and no band covered the log type. */
	unknownType: boolean;
	/** The `details.category` string Torn itself filed the log under. */
	tornCategory: string | null;
	title: string | null;
};

export type WealthClassifyContext = {
	/** Item market prices keyed by item id, as strings. Missing means unpriced. */
	itemPrices: ReadonlyMap<string, number>;
};

// ─── Payload reading ─────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

/**
 * A finite number, or null.
 *
 * Torn stores money as a number, as a numeric string (`"895.00"` on stock
 * trades), and occasionally as prose (`"4.00 GBP ($4.85)"` on subscriptions).
 * Returning null for the prose case keeps it out of the arithmetic instead of
 * letting a `Number()` cast turn it into NaN and poison a total.
 */
export function readNumber(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed === "") return null;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/**
 * Evaluates a signed term list against a payload.
 *
 * `fields` is a preference list, so `["upkeep_paid", "upkeep_due"]` uses the
 * first that resolves. Returns null when no field in any term resolves, which is
 * how "this payload has no amount" is distinguished from "the amount is zero".
 */
export function evaluateTerms(
	payload: Record<string, unknown>,
	terms: readonly WealthMoneyTerm[],
): number | null {
	let total = 0;
	let resolved = false;
	for (const term of terms) {
		let value: number | null = null;
		for (const field of term.fields) {
			value = readNumber(payload[field]);
			if (value !== null) break;
		}
		if (value === null) continue;
		resolved = true;
		total += term.sign * value;
	}
	return resolved ? total : null;
}

function firstPresent(
	payload: Record<string, unknown>,
	fields: readonly string[],
): unknown {
	for (const field of fields) {
		if (payload[field] !== undefined && payload[field] !== null) {
			return payload[field];
		}
	}
	return undefined;
}

/**
 * Reads item references out of any of Torn's payload shapes.
 *
 * The same logical thing is written six different ways across the log catalogue:
 *
 *   item: 180                              a bare id, quantity from a sibling
 *   item: { "370": 1 }                     a map of id to quantity
 *   item: [{ id, qty, uid }]               an array of stacks
 *   items: [{ id, qty, uid }]              the same, pluralised
 *   "items_gained": { "707": 10 }          a map, past tense
 *   "item_gained": 48                      a bare id, past tense
 *
 * `quantityHint` supplies the sibling `quantity`/`amount` for the bare-id forms,
 * which is the only way `1210 Bazaar add` (item 984, quantity 20) can be read
 * correctly.
 */
export function readItemRefs(
	value: unknown,
	quantityHint: number | null,
): WealthItemRef[] {
	const out: WealthItemRef[] = [];

	const pushStack = (
		rawId: unknown,
		rawQuantity: unknown,
		rawUid: unknown,
	): void => {
		const itemId = readNumber(rawId) ?? readNumber(String(rawId));
		if (itemId === null || itemId <= 0) return;
		const quantity = readNumber(rawQuantity) ?? quantityHint ?? 1;
		if (quantity <= 0) return;
		const uid = readNumber(rawUid);
		out.push({
			itemId: String(Math.trunc(itemId)),
			quantity,
			uid: uid !== null && uid > 0 ? uid : null,
		});
	};

	if (value === null || value === undefined) return out;

	// A bare id: `item_gained: 48`.
	const scalar = readNumber(value);
	if (scalar !== null) {
		pushStack(scalar, null, null);
		return out;
	}

	if (Array.isArray(value)) {
		for (const entry of value) {
			const record = asRecord(entry);
			if (!record) {
				pushStack(entry, null, null);
				continue;
			}
			pushStack(
				record.id ?? record.item,
				record.qty ?? record.quantity ?? record.amount,
				record.uid,
			);
		}
		return out;
	}

	const record = asRecord(value);
	if (!record) return out;

	// A single structured stack: `{ id, qty, uid }`.
	if (record.id !== undefined || record.item !== undefined) {
		const single = readNumber(record.id ?? record.item);
		if (single !== null) {
			pushStack(
				single,
				record.qty ?? record.quantity ?? record.amount,
				record.uid,
			);
			return out;
		}
	}

	// A map of id to quantity: `{ "707": 10 }`.
	for (const [key, rawQuantity] of Object.entries(record)) {
		pushStack(key, rawQuantity, null);
	}
	return out;
}

/** Applies a `quantity`/`amount` sibling as the hint for bare-id item fields. */
function itemHintFor(
	payload: Record<string, unknown>,
	fields: WealthItemFields,
): number | null {
	// Only the singular forms take a sibling quantity; the plural payloads carry
	// their own.
	const singular = fields.some((field) =>
		["item", "item_gained", "first_item", "second_item"].includes(field),
	);
	if (!singular) return null;
	return readNumber(payload.quantity ?? payload.amount);
}

function readItems(
	payload: Record<string, unknown>,
	fields: WealthItemFields,
): WealthItemRef[] {
	const raw = firstPresent(payload, fields);
	if (raw === undefined) return [];
	const hint = itemHintFor(payload, fields);
	// `first_item` / `second_item` are two separate payload keys, so read each.
	if (fields.length > 1 && fields.every((field) => field in payload)) {
		const merged: WealthItemRef[] = [];
		for (const field of fields) {
			merged.push(...readItemRefs(payload[field], hint));
		}
		return merged;
	}
	return readItemRefs(raw, hint);
}

/**
 * The log type id.
 *
 * `details.id` is authoritative; the denormalised `log` column is the fallback
 * for rows written before `details` existed.
 */
export function resolveLogTypeId(row: WealthLogRow): number {
	const outer = asRecord(row.data);
	const details = asRecord(outer?.details);
	const fromDetails = readNumber(details?.id);
	if (fromDetails !== null && fromDetails > 0) return Math.trunc(fromDetails);
	const fromOuter = readNumber(outer?.log);
	if (fromOuter !== null && fromOuter > 0) return Math.trunc(fromOuter);
	return row.log;
}

/**
 * The payload the rule table reads.
 *
 * Torn nests the interesting fields one level down under `data`. Everything the
 * rules reference lives there, so the engine hands the rules the inner object
 * and keeps the outer one for the log type and category.
 */
export function resolvePayload(row: WealthLogRow): Record<string, unknown> {
	const outer = asRecord(row.data);
	if (!outer) return {};
	return asRecord(outer.data) ?? outer;
}

export function resolveTornCategory(row: WealthLogRow): string | null {
	const outer = asRecord(row.data);
	const details = asRecord(outer?.details);
	const category = details?.category;
	return typeof category === "string" && category.length > 0 ? category : null;
}

function sumItemValue(
	items: readonly WealthItemRef[],
	itemPrices: ReadonlyMap<string, number>,
): { value: number; complete: boolean } {
	let value = 0;
	let complete = true;
	for (const item of items) {
		const price = itemPrices.get(item.itemId);
		if (price === undefined || price <= 0) {
			// An item we cannot price is not worthless, it is unknown. Marking the
			// event lets the coverage panel say so.
			complete = false;
			continue;
		}
		value += price * item.quantity;
	}
	return { value, complete };
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Classifies one log into a ledger event.
 *
 * Returns null only when the row cannot be read at all; an unclassified log type
 * still produces an event, flagged `unknownType` and `priced: false`, so that the
 * audit can enumerate what is missing rather than quietly dropping it.
 */
export function classifyWealthLog(
	row: WealthLogRow,
	ctx: WealthClassifyContext,
): WealthEvent | null {
	const payload = resolvePayload(row);
	const logType = resolveLogTypeId(row);

	const rule: WealthRule | null = getWealthRule(logType);
	const band = rule ? null : getWealthBand(logType);

	// A rule that names an amount but whose field is missing from this payload is
	// not a zero, it is an unknown. `amountResolved` carries that distinction to
	// the `priced` flag below.
	let amountResolved = true;

	let walletDelta = 0;
	if (rule?.wallet) {
		const resolved = evaluateTerms(payload, rule.wallet);
		if (resolved === null) amountResolved = false;
		else walletDelta = resolved;
	}

	let accountDelta = 0;
	if (rule?.account) {
		const resolved = evaluateTerms(payload, rule.account.terms);
		if (resolved === null) amountResolved = false;
		else accountDelta = resolved;
	}

	const itemsIn = rule?.itemsIn ? readItems(payload, rule.itemsIn) : [];
	const itemsOut = rule?.itemsOut ? readItems(payload, rule.itemsOut) : [];

	const units: WealthUnitRef[] = [];
	if (rule?.units) {
		for (const unit of rule.units) {
			const quantity = evaluateTerms(payload, [
				{ fields: unit.fields, sign: unit.sign ?? 1 },
			]);
			if (quantity !== null && quantity !== 0) {
				units.push({ unit: unit.unit, quantity });
			}
		}
	}

	const inValue = sumItemValue(itemsIn, ctx.itemPrices);
	const outValue = sumItemValue(itemsOut, ctx.itemPrices);

	const unknownType = rule === null && band === null;
	const category: WealthCategory = rule?.category ?? band?.category ?? "other";
	const label = rule?.label ?? row.title ?? `Log type ${logType}`;

	// An event is priced when its rule trusts the amount, every field it names
	// actually resolved, and every item it moved could be valued.
	//
	// An event with NO rule is a different question. It cannot be called priced on
	// the strength of a rule, but if its payload holds nothing that could carry
	// value then zero is a fact about the log rather than a failure to read it — a
	// forum post moved nothing. Only a payload that does carry something stays
	// unpriced, which is what keeps the coverage count meaningful instead of
	// padding it with every message the account has ever sent.
	const rulePriced = rule
		? (rule.priced ?? true)
		: !payloadCarriesValue(payload);
	const priced =
		rulePriced && amountResolved && inValue.complete && outValue.complete;

	const netWorthDelta =
		walletDelta + accountDelta + inValue.value - outValue.value;

	return {
		id: `ledger_ev_${row.id}`,
		logId: row.id,
		logType,
		timestamp: row.timestamp,
		category,
		label,
		walletDelta,
		account: rule?.account?.account ?? null,
		accountDelta,
		itemsIn,
		itemsOut,
		units,
		itemsInValue: inValue.value,
		itemsOutValue: outValue.value,
		netWorthDelta,
		priced,
		mirrored: rule ? !resolveMirror(rule) : false,
		unknownType,
		tornCategory: resolveTornCategory(row),
		title: row.title,
	};
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

export type WealthTotals = {
	walletIn: number;
	walletOut: number;
	walletNet: number;
	accountNet: number;
	/** Per-account movement, so each balance can be unwound independently. */
	accountDeltas: Record<WealthAccount, number>;
	itemsInValue: number;
	itemsOutValue: number;
	netWorthDelta: number;
	eventCount: number;
	pricedEvents: number;
	unpricedEvents: number;
	unpricedAmount: number;
	unclassifiedLogIds: number[];
};

function emptyAccountDeltas(): Record<WealthAccount, number> {
	return {
		wallet: 0,
		bookie: 0,
		vault: 0,
		company: 0,
		bank: 0,
		cayman: 0,
		piggy: 0,
		faction: 0,
	};
}

/**
 * Aggregates events into the totals the KPI row shows.
 *
 * `unpricedAmount` is the sum of net-worth movements on events whose amounts are
 * not fully trusted. It is reported separately rather than folded into the
 * totals, so a large unpriced figure reads as "we could not measure this" rather
 * than as a measured zero.
 */
export function summariseWealth(events: readonly WealthEvent[]): WealthTotals {
	const totals: WealthTotals = {
		walletIn: 0,
		walletOut: 0,
		walletNet: 0,
		accountNet: 0,
		accountDeltas: emptyAccountDeltas(),
		itemsInValue: 0,
		itemsOutValue: 0,
		netWorthDelta: 0,
		eventCount: 0,
		pricedEvents: 0,
		unpricedEvents: 0,
		unpricedAmount: 0,
		unclassifiedLogIds: [],
	};
	const unclassified = new Set<number>();

	for (const event of events) {
		if (event.mirrored) continue;
		totals.eventCount += 1;
		totals.walletNet += event.walletDelta;
		totals.accountNet += event.accountDelta;
		if (event.account) {
			totals.accountDeltas[event.account] += event.accountDelta;
		}
		totals.itemsInValue += event.itemsInValue;
		totals.itemsOutValue += event.itemsOutValue;
		totals.netWorthDelta += event.netWorthDelta;
		if (event.walletDelta > 0) totals.walletIn += event.walletDelta;
		if (event.walletDelta < 0) totals.walletOut += -event.walletDelta;
		if (event.priced) {
			totals.pricedEvents += 1;
		} else {
			totals.unpricedEvents += 1;
			totals.unpricedAmount += event.netWorthDelta;
		}
		if (event.unknownType) unclassified.add(event.logType);
	}

	totals.unclassifiedLogIds = [...unclassified].sort((a, b) => a - b);
	return totals;
}

export type WealthDailyPoint = {
	date: string;
	walletIn: number;
	walletOut: number;
	walletNet: number;
	netWorthDelta: number;
	events: number;
};

/** Buckets events into UTC days, which is the boundary Torn itself uses. */
export function buildWealthTimeline(
	events: readonly WealthEvent[],
): WealthDailyPoint[] {
	const byDay = new Map<string, WealthDailyPoint>();
	for (const event of events) {
		if (event.mirrored) continue;
		const date = event.timestamp.toISOString().slice(0, 10);
		const point = byDay.get(date) ?? {
			date,
			walletIn: 0,
			walletOut: 0,
			walletNet: 0,
			netWorthDelta: 0,
			events: 0,
		};
		point.events += 1;
		point.walletNet += event.walletDelta;
		point.netWorthDelta += event.netWorthDelta;
		if (event.walletDelta > 0) point.walletIn += event.walletDelta;
		if (event.walletDelta < 0) point.walletOut += -event.walletDelta;
		byDay.set(date, point);
	}
	return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export type WealthCategorySummary = {
	category: WealthCategory;
	walletIn: number;
	walletOut: number;
	walletNet: number;
	netWorthDelta: number;
	events: number;
	unpricedEvents: number;
};

/** Groups events by wealth category, largest absolute movement first. */
export function buildWealthCategoryBreakdown(
	events: readonly WealthEvent[],
): WealthCategorySummary[] {
	const byCategory = new Map<WealthCategory, WealthCategorySummary>();
	for (const event of events) {
		if (event.mirrored) continue;
		const entry = byCategory.get(event.category) ?? {
			category: event.category,
			walletIn: 0,
			walletOut: 0,
			walletNet: 0,
			netWorthDelta: 0,
			events: 0,
			unpricedEvents: 0,
		};
		entry.events += 1;
		entry.walletNet += event.walletDelta;
		entry.netWorthDelta += event.netWorthDelta;
		if (event.walletDelta > 0) entry.walletIn += event.walletDelta;
		if (event.walletDelta < 0) entry.walletOut += -event.walletDelta;
		if (!event.priced) entry.unpricedEvents += 1;
		byCategory.set(event.category, entry);
	}
	return [...byCategory.values()].sort(
		(a, b) =>
			Math.abs(b.walletNet) +
			Math.abs(b.netWorthDelta) -
			(Math.abs(a.walletNet) + Math.abs(a.netWorthDelta)),
	);
}

/**
 * The change in net worth the events account for, which is the figure the
 * observed balances are reconciled against.
 */
export function computeLedgerNetWorthChange(
	events: readonly WealthEvent[],
): number {
	let total = 0;
	for (const event of events) {
		if (event.mirrored) continue;
		total += event.netWorthDelta;
	}
	return total;
}

/**
 * Opening balances for the ledger's anchor.
 *
 * The init runs part-way through a UTC day, and the account has already been
 * active since midnight. Recording the observed balances as day-zero would count
 * everything that happened today twice — once in the balances and once in the
 * replayed events. Subtracting the net effect of the day's events yields what the
 * balances actually were at 00:00 UTC, which is the anchor the ledger needs.
 *
 * `observed` is whatever the Torn API reports at init time; `accountKeys` maps
 * each tracked account to the observed balance it corresponds to, so a vault
 * deposit is unwound from the vault and a bookie bet from the bookie.
 */
export function deriveOpeningBalances(input: {
	observedWallet: number;
	observedItemsValue: number;
	observedAccounts: Partial<Record<WealthAccount, number>>;
	todayEvents: readonly WealthEvent[];
}): {
	wallet: number;
	itemsValue: number;
	accounts: Partial<Record<WealthAccount, number>>;
} {
	const totals = summariseWealth(input.todayEvents);

	const accounts: Partial<Record<WealthAccount, number>> = {};
	for (const [key, value] of Object.entries(input.observedAccounts)) {
		if (typeof value !== "number") continue;
		const account = key as WealthAccount;
		accounts[account] = value - (totals.accountDeltas[account] ?? 0);
	}

	return {
		wallet: input.observedWallet - totals.walletNet,
		itemsValue:
			input.observedItemsValue - (totals.itemsInValue - totals.itemsOutValue),
		accounts,
	};
}

/**
 * Net worth, from the parts the ledger tracks.
 *
 * Torn publishes its own `daily_networth`, which is the number this is checked
 * against: the difference between them is the drift the coverage panel reports,
 * and it is the only signal that a rule is quietly wrong.
 */
export function computeTrackedNetWorth(input: {
	wallet: number;
	accounts: Partial<Record<WealthAccount, number>>;
	itemsValue: number;
}): number {
	let total = input.wallet + input.itemsValue;
	for (const value of Object.values(input.accounts)) {
		if (typeof value === "number") total += value;
	}
	return total;
}

/** Midnight UTC of the day containing `now`, in seconds — the ledger's anchor. */
export function startOfUtcDay(now: Date): number {
	return Math.floor(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000,
	);
}
