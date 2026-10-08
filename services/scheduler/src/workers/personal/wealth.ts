import {
	and,
	assets,
	companyDailyProfits,
	db,
	eq,
	gte,
	isNull,
	ledgerEvents,
	personalLogs,
	sql,
	systemStates,
	tornItems,
	tornLogTypes,
	wealthAccountSnapshots,
} from "@sentinel/database";
import type {
	TornSchema,
	WealthBalances,
	WealthCoverage,
	WealthLedgerState,
} from "@sentinel/schemas";
import type { ManagedApiKey } from "@sentinel/torn-api";
import { getPersonalKey, tornApi } from "@sentinel/torn-api";
import {
	classifyWealthLog,
	computeTrackedNetWorth,
	deriveOpeningBalances,
	extractItemMarketPrice,
	getWealthBand,
	getWealthRule,
	Logger,
	readNumber,
	startOfUtcDay,
	WEALTH_LOG_RULES,
	type WealthAccount,
	type WealthEvent,
	type WealthItemRef,
	type WealthLogRow,
} from "@sentinel/utils";
import { schedulerEvents } from "../../lib/events";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

/**
 * The wealth ledger.
 *
 * WHAT THIS OWNS
 *
 * `ledger_events` has exactly one writer, and this is it. The crimes, stocks and
 * company workers each keep their own domain table (`crime_logs`, `stock_ledgers`,
 * `company_daily_profits`) which their own tabs read, and none of them writes the
 * unified ledger any more. That was the source of the double-counting in the
 * previous attempt: a stock dividend booked once by the stocks worker and again by
 * the wealth engine, with no way to tell afterwards which was which.
 *
 * Company profit is the one contribution a log cannot express — it is money
 * appearing in a company balance between two API snapshots — so it is read out of
 * `company_daily_profits`, which the company worker still owns, and re-emitted
 * here under the same event id.
 *
 * THE ANCHOR IS 00:00 UTC, NOT "NOW"
 *
 * Init runs part-way through a day on an account that has already been active
 * since midnight. If day zero were the observed balances, everything that
 * happened today would be counted twice: once already inside the balances, and
 * once by the replayed events. So the anchor row stores OPENING balances —
 * observed minus the net effect of every event since midnight — and the ledger
 * starts at midnight. The upshot is that the panel is useful on the first open
 * instead of showing an empty day.
 *
 * WHAT IT REFUSES TO DO
 *
 * Guess. Events whose amounts cannot be established are written with
 * `priced: false` and counted in the coverage block rather than dropped or
 * zeroed. Torn's own `daily_networth` is compared against the tracked figure on
 * every sync, and the difference is surfaced as drift: it is the only mechanical
 * signal that a rule is quietly wrong.
 */

const WORKER_NAME = "personal:wealth";
const STATE_ID = "personal:wealth";
/**
 * Hourly, which is also Torn's own inventory cache window.
 *
 * The drift check needs a live reading of the wallet, the accounts and the
 * holdings, and the holdings can only be enumerated one category at a time. Torn
 * caches each category for an hour, so running at exactly that cadence gets a
 * fresh figure without ever asking for a cached one twice.
 */
const CADENCE_SEC = 3600;
/** The log types are static reference data; daily is plenty. */
const LOG_TYPE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const /** Torn caps inventory pages at 250. */ INVENTORY_PAGE_SIZE = 250;
/** Stops a runaway pager if Torn ever returns a full page forever. */
const INVENTORY_MAX_PAGES = 40;

const logger = new Logger("Scheduler", "Wealth");

/** The persisted half of the ledger state; coverage and balances are derived. */
export type WealthState = Omit<WealthLedgerState, "coverage" | "updatedAt"> & {
	updatedAt: string;
	/** When the Torn log-type reference was last refreshed. */
	logTypesSyncedAt: string | null;
};

const DEFAULT_STATE: WealthState = {
	status: "idle",
	initialised: false,
	anchorTimestamp: null,
	anchorDate: null,
	totalIndexedEvents: 0,
	lastReconciledAt: null,
	lastError: null,
	updatedAt: new Date().toISOString(),
	logTypesSyncedAt: null,
};

let inMemoryState: WealthState = { ...DEFAULT_STATE };

// ─── State ───────────────────────────────────────────────────────────────────

export async function loadWealthState(): Promise<WealthState> {
	try {
		const record = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, STATE_ID),
		});
		if (record?.data && typeof record.data === "object") {
			inMemoryState = {
				...DEFAULT_STATE,
				...(record.data as Partial<WealthState>),
				updatedAt: new Date().toISOString(),
			};
			return { ...inMemoryState };
		}
	} catch (error) {
		logger.error("Failed to load wealth state:", error);
	}
	inMemoryState = { ...DEFAULT_STATE };
	return { ...inMemoryState };
}

export async function persistWealthState(state: WealthState): Promise<void> {
	state.updatedAt = new Date().toISOString();
	inMemoryState = { ...state };
	try {
		const now = new Date();
		await db
			.insert(systemStates)
			.values({
				id: STATE_ID,
				init: state.initialised,
				data: state,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: { init: state.initialised, data: state, updatedAt: now },
			});

		const ipc = getActiveIpcServer();
		if (ipc) {
			// The state broadcast carries the balances too, so a listener does not
			// have to make a second round trip to render the header.
			const balances = await computeBalances();
			ipc.broadcast({
				action: "wealth_state_updated",
				data: { ...(await buildLedgerState(state)), balances },
			});
		}
	} catch (error) {
		logger.error("Failed to persist wealth state:", error);
	}
}

export function getWealthState(): WealthState {
	return { ...inMemoryState };
}

// ─── Reference data ──────────────────────────────────────────────────────────

/**
 * The id `torn:references` writes the daily points-market average under.
 *
 * That worker already samples the top 5,000 points of the points market and
 * stores a volume-weighted average here once a day, and the stocks ledger reads
 * it for the same reason this one does: points are the one resource with a real
 * market price, so anything paid in points can be valued honestly. Reading it
 * beats fetching a second copy and disagreeing about the price.
 */
const POINTS_PRICE_STATE_ID = "points_market_price";

/**
 * Dollars per point, or 0 when the reference sync has not run yet.
 *
 * Zero means "unknown", never "worthless": the classifier treats a unit with no
 * rate as unvalued and reports it, rather than quietly counting it as nothing.
 */
export async function loadPointsPrice(): Promise<number> {
	try {
		const record = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, POINTS_PRICE_STATE_ID),
		});
		const data =
			record?.data && typeof record.data === "object"
				? (record.data as Record<string, unknown>)
				: {};
		const price = readNumber(data.price);
		return price !== null && price > 0 ? price : 0;
	} catch (error) {
		logger.warn(
			`Could not read the points market price: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 0;
	}
}

/** Unit rates the engine values resources with. */
async function loadUnitRates(): Promise<Map<string, number>> {
	const points = await loadPointsPrice();
	const rates = new Map<string, number>();
	if (points > 0) rates.set("points", points);
	return rates;
}

let cachedItemPrices: Map<string, number> | null = null;
let cachedItemPricesAt = 0;
const ITEM_PRICE_TTL_MS = 15 * 60_000;

/** Test seam: drops the memoised item prices. */
export function clearWealthCaches(): void {
	cachedItemPrices = null;
	cachedItemPricesAt = 0;
}

/**
 * Item market prices, memoised.
 *
 * The live ingest path runs on every page of a backfill burst; re-reading 1502
 * item rows each time was costing more than the classification itself.
 */
export async function loadItemPrices(): Promise<Map<string, number>> {
	const now = Date.now();
	if (cachedItemPrices && now - cachedItemPricesAt < ITEM_PRICE_TTL_MS) {
		return cachedItemPrices;
	}
	const rows = await db
		.select({ id: tornItems.id, data: tornItems.data })
		.from(tornItems);
	const prices = new Map<string, number>();
	for (const row of rows) {
		const price = extractItemMarketPrice(row.data);
		if (price > 0) prices.set(row.id, price);
	}
	cachedItemPrices = prices;
	cachedItemPricesAt = now;
	return prices;
}

/**
 * Accepts either shape Torn has returned for the log type list.
 *
 * v2 gives `[{ id, title }]`; v1 gave `{ "101": "Successful login" }`. Both are
 * turned into the same list, because a shape mismatch here used to be a hard
 * crash rather than a missed sync.
 */
export function normalizeLogTypes(
	raw:
		| Array<{ id?: number; title?: string }>
		| Record<string, string>
		| undefined,
): Array<{ id: number; title: string | null }> {
	if (!raw) return [];
	if (Array.isArray(raw)) {
		const out: Array<{ id: number; title: string | null }> = [];
		for (const entry of raw) {
			const id = readNumber(entry?.id);
			if (id === null || id <= 0) continue;
			out.push({ id: Math.trunc(id), title: entry.title ?? null });
		}
		return out;
	}
	if (typeof raw !== "object") return [];
	const out: Array<{ id: number; title: string | null }> = [];
	for (const [key, title] of Object.entries(raw)) {
		const id = readNumber(key);
		if (id === null || id <= 0) continue;
		out.push({
			id: Math.trunc(id),
			title: typeof title === "string" ? title : null,
		});
	}
	return out;
}

/**
 * Refreshes the full list of log types Torn publishes.
 *
 * The account has generated 785 of the 1170. Knowing the other 385 exist is what
 * turns "we classified everything we have seen" into a claim about coverage
 * rather than a claim about experience.
 */
export async function syncTornLogTypes(
	force = false,
	key?: ManagedApiKey,
): Promise<number> {
	const state = getWealthState();
	if (
		!force &&
		state.logTypesSyncedAt &&
		Date.now() - new Date(state.logTypesSyncedAt).getTime() <
			LOG_TYPE_SYNC_INTERVAL_MS
	) {
		return 0;
	}

	// `/torn/logtypes` on the v2 base. The v1 endpoint of the same name returns an
	// id-to-title MAP rather than a list, and iterating it throws
	// "{} is not iterable" — which is exactly how this crashed on first deploy.
	// Both shapes are accepted so a base change can never take the worker down
	// again, but the list is what v2 returns.
	const resolved = key ?? (await getPersonalKey());
	if (!resolved) return 0;

	const response = (await tornApi.get("/torn/logtypes", {
		apiKey: resolved.apiKey,
		userId: resolved.userId,
	})) as unknown as {
		logtypes?: Array<{ id?: number; title?: string }> | Record<string, string>;
	};

	const logTypes = normalizeLogTypes(response.logtypes);
	if (logTypes.length === 0) return 0;

	const now = new Date();
	let written = 0;
	for (const entry of logTypes) {
		const logType = entry.id;
		const rule = getWealthRule(logType);
		const band = rule ? null : getWealthBand(logType);
		await db
			.insert(tornLogTypes)
			.values({
				id: logType,
				title: entry.title,
				wealthCategory: rule?.category ?? band?.category ?? null,
				observed: false,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: tornLogTypes.id,
				set: {
					title: entry.title,
					wealthCategory: rule?.category ?? band?.category ?? null,
					updatedAt: now,
				},
			});
		written += 1;
	}

	state.logTypesSyncedAt = now.toISOString();
	await persistWealthState(state);
	logger.info(`Cached ${written} Torn log types for coverage reporting.`);
	return written;
}

// ─── Baseline snapshot ───────────────────────────────────────────────────────

type MoneySelection = {
	points?: number;
	wallet?: number;
	vault?: number;
	company?: number;
	cayman_bank?: number;
	city_bank?: { amount?: number; profit?: number; until?: number } | null;
	daily_networth?: number;
};

type ObservedItem = WealthItemRef & { location: string; name: string | null };

export type BaselineSnapshot = {
	wallet: number;
	points: number;
	vault: number;
	company: number;
	cityBank: number;
	caymanBank: number;
	tornNetWorth: number | null;
	items: ObservedItem[];
	/** Items AND points, valued at market. */
	holdingsValue: number;
	/** The points holding on its own, for the log line. */
	pointsValue: number;
	/** Categories whose inventory page could not be read, by name. */
	failures: string[];
	raw: Record<string, unknown>;
};

/**
 * The item categories Torn's inventory endpoint accepts.
 *
 * These are NOT the item types in `torn_items`: `Weapon`, `Armor` and `Unused`
 * are rejected with error 21, and weapons are split into `Melee`, `Primary`,
 * `Secondary` and `Defensive` instead. Reading the categories out of the item
 * table asked for three that always failed and never asked for the five that
 * hold weapons, so weapons were silently absent from every baseline.
 *
 * The list mirrors the API's own `TornInventoryItemType`, and typing it as that
 * union is what keeps it honest.
 */
const INVENTORY_CATEGORIES: readonly TornSchema<"TornInventoryItemType">[] = [
	"Alcohol",
	"Artifact",
	"Book",
	"Booster",
	"Candy",
	"Car",
	"Clothing",
	"Collectible",
	"Defensive",
	"Drug",
	"Energy Drink",
	"Enhancer",
	"Flower",
	"Jewelry",
	"Material",
	"Medical",
	"Melee",
	"Other",
	"Plushie",
	"Primary",
	"Secondary",
	"Special",
	"Supply Pack",
	"Temporary",
	"Tool",
];

/**
 * Reads everything the ledger is anchored to.
 *
 * All three calls go to the **v2** base through `getPersonal`. `getPersonalRaw`
 * uses the v1 base, and v1 answers these three differently in ways that all look
 * like success: the money selection comes back flat rather than nested, so every
 * balance read as zero; `/user/inventory` is not a v1 path at all, so it answers
 * with the player's profile and the inventory comes back empty; and `/torn`
 * returns the log types as an id-to-title map rather than a list.
 *
 * The lesson is in the guards below: a snapshot that cannot find what it asked
 * for now throws instead of returning zeros. A ledger anchored on zeros reports
 * a net worth of nothing and reconciles against it forever.
 *
 * The key is a PARAMETER rather than resolved here, and the calls go through
 * `tornApi.get` with it explicitly. `getPersonal` falls back to the shared
 * system-key pool when no personal key is configured, and those keys belong to
 * other players — reading one would anchor this ledger on somebody else's wallet
 * and look entirely successful doing it.
 */
export async function snapshotBalances(
	key: ManagedApiKey,
): Promise<BaselineSnapshot> {
	const failures: string[] = [];

	const moneyResponse = (await tornApi.get("/user/money", {
		apiKey: key.apiKey,
		userId: key.userId,
	})) as unknown as {
		money?: MoneySelection;
	};

	// A missing `money` object means the call did not do what we think it did.
	// Zeros here would anchor the entire ledger on nothing.
	if (!moneyResponse?.money || typeof moneyResponse.money !== "object") {
		throw new Error(
			"Torn returned no `money` selection for /user/money, so the baseline cannot be read.",
		);
	}
	const money = moneyResponse.money;

	const wallet = readNumber(money.wallet) ?? 0;
	const points = readNumber(money.points) ?? 0;
	const vault = readNumber(money.vault) ?? 0;
	const company = readNumber(money.company) ?? 0;
	const cityBank = readNumber(money.city_bank?.amount) ?? 0;
	const caymanBank = readNumber(money.cayman_bank) ?? 0;
	const tornNetWorth = readNumber(money.daily_networth);

	const holdingsResponse = (await tornApi.get("/user", {
		apiKey: key.apiKey,
		userId: key.userId,
		queryParams: { selections: ["display", "bazaar"] as never },
	})) as unknown as {
		display?: Array<Record<string, unknown>>;
		bazaar?: Array<Record<string, unknown>>;
	};

	const prices = await loadItemPrices();

	/** Turns one API item entry into a valued holding. */
	const toObserved = (
		raw: Record<string, unknown>,
		location: string,
	): ObservedItem | null => {
		const itemId = readNumber(raw.id ?? raw.ID);
		if (itemId === null || itemId <= 0) return null;
		const quantity = readNumber(raw.amount ?? raw.quantity ?? raw.qty) ?? 1;
		if (quantity <= 0) return null;
		const uid = readNumber(raw.uid ?? raw.UID);
		const name = typeof raw.name === "string" ? raw.name : null;
		return {
			itemId: String(Math.trunc(itemId)),
			quantity,
			uid: uid !== null && uid > 0 ? uid : null,
			location,
			name,
		};
	};

	const items: ObservedItem[] = [];
	for (const raw of holdingsResponse.display ?? []) {
		const entry = toObserved(raw, "display");
		if (entry) items.push(entry);
	}
	for (const raw of holdingsResponse.bazaar ?? []) {
		const entry = toObserved(raw, "bazaar");
		if (entry) items.push(entry);
	}

	// Inventory, one category at a time, paged to the end.
	for (const category of INVENTORY_CATEGORIES) {
		try {
			let offset = 0;
			for (let page = 0; page < INVENTORY_MAX_PAGES; page += 1) {
				const response = (await tornApi.get("/user/inventory", {
					apiKey: key.apiKey,
					userId: key.userId,
					queryParams: {
						cat: category,
						offset,
						limit: INVENTORY_PAGE_SIZE,
					},
				})) as unknown as {
					inventory?: { items?: Array<Record<string, unknown>> };
				};
				const pageItems = response.inventory?.items ?? [];
				for (const raw of pageItems) {
					const entry = toObserved(raw, "inventory");
					if (entry) items.push(entry);
				}
				if (pageItems.length < INVENTORY_PAGE_SIZE) break;
				offset += INVENTORY_PAGE_SIZE;
			}
		} catch (error) {
			// Recorded, not swallowed: an unread category means the baseline is
			// incomplete and the panel has to say so.
			failures.push(
				`${category}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	let itemsValue = 0;
	for (const item of items) {
		itemsValue += (prices.get(item.itemId) ?? 0) * item.quantity;
	}

	// Points are held, trade, and have a daily price from the reference sync, so
	// they belong in the same figure the item holdings do.
	const pointsPrice = await loadPointsPrice();
	const pointsValue = points * pointsPrice;

	return {
		wallet,
		points,
		vault,
		company,
		cityBank,
		caymanBank,
		tornNetWorth,
		items,
		holdingsValue: itemsValue + pointsValue,
		pointsValue,
		failures,
		raw: {
			money: money as Record<string, unknown>,
			displayCount: (holdingsResponse.display ?? []).length,
			bazaarCount: (holdingsResponse.bazaar ?? []).length,
			inventoryCount: items.filter((i) => i.location === "inventory").length,
		},
	};
}

// ─── Log classification ──────────────────────────────────────────────────────

type PersonalLogRow = {
	id: string;
	log: number;
	title: string | null;
	timestamp: Date;
	data: unknown;
};

function toWealthRow(row: PersonalLogRow): WealthLogRow {
	return {
		id: row.id,
		log: row.log,
		title: row.title,
		timestamp: row.timestamp,
		data: row.data,
	};
}

async function classifyRows(rows: PersonalLogRow[]): Promise<WealthEvent[]> {
	const [prices, unitRates] = await Promise.all([
		loadItemPrices(),
		loadUnitRates(),
	]);
	const ctx = { itemPrices: prices, unitRates };
	const events: WealthEvent[] = [];
	for (const row of rows) {
		const event = classifyWealthLog(toWealthRow(row), ctx);
		if (event) events.push(event);
	}
	return events;
}

/** Reads every personal log at or after `anchorDate`. */
async function readLogsSince(anchorDate: Date): Promise<PersonalLogRow[]> {
	return db
		.select({
			id: personalLogs.id,
			log: personalLogs.log,
			title: personalLogs.title,
			timestamp: personalLogs.timestamp,
			data: personalLogs.data,
		})
		.from(personalLogs)
		.where(gte(personalLogs.timestamp, anchorDate))
		.orderBy(personalLogs.timestamp);
}

// ─── Ledger writes ───────────────────────────────────────────────────────────

/**
 * One `ledger_events` row.
 *
 * `cashFlow` and `realizedPnl` are kept populated for the columns that predate
 * this module, while the new columns carry the split the wealth totals sum.
 * `assetDelta` is the net-worth change, which is what the observed balances are
 * reconciled against.
 */
function toLedgerRow(event: WealthEvent) {
	const now = new Date();
	return {
		id: event.id,
		logId: event.logId,
		timestamp: event.timestamp,
		type: event.account
			? `account_${event.account}`
			: event.walletDelta === 0
				? "neutral"
				: event.walletDelta > 0
					? "inflow"
					: "outflow",
		categoryId: 0,
		transactionName: event.label,
		assetsAffected: [
			...event.itemsIn.map((item) => ({
				assetId: item.itemId,
				quantityChange: item.quantity,
				uid: item.uid,
			})),
			...event.itemsOut.map((item) => ({
				assetId: item.itemId,
				quantityChange: -item.quantity,
				uid: item.uid,
			})),
		],
		cashFlow: event.walletDelta,
		realizedPnl: event.netWorthDelta,
		rawLog: null,
		logType: event.logType,
		wealthCategory: event.category,
		walletDelta: event.walletDelta,
		account: event.account,
		accountDelta: event.accountDelta,
		assetDelta: event.netWorthDelta,
		priced: event.priced,
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Writes events in one transaction.
 *
 * The previous implementation awaited an insert per log inside the ingest loop,
 * which is a round trip per row; during a backfill burst that is thousands of
 * sequential statements for a page of logs.
 */
async function writeEvents(events: WealthEvent[]): Promise<number> {
	const rows = events.filter((event) => !event.mirrored).map(toLedgerRow);
	if (rows.length === 0) return 0;

	await db.transaction(async (tx) => {
		for (const row of rows) {
			await tx
				.insert(ledgerEvents)
				.values(row)
				.onConflictDoUpdate({
					target: ledgerEvents.id,
					set: {
						timestamp: row.timestamp,
						type: row.type,
						transactionName: row.transactionName,
						assetsAffected: row.assetsAffected,
						cashFlow: row.cashFlow,
						realizedPnl: row.realizedPnl,
						logType: row.logType,
						wealthCategory: row.wealthCategory,
						walletDelta: row.walletDelta,
						account: row.account,
						accountDelta: row.accountDelta,
						assetDelta: row.assetDelta,
						priced: row.priced,
						updatedAt: row.updatedAt,
					},
				});
		}
	});
	return rows.length;
}

/**
 * Company profit, re-emitted from the company worker's own table.
 *
 * A company balance earns between two API snapshots and no log records it, so
 * this is the one contribution that cannot be derived from `personal_logs`. The
 * company's funds are money the player owns, so it is an account gain, not cash.
 */
async function writeCompanyProfitEvents(anchorDate: Date): Promise<number> {
	const rows = await db
		.select({
			id: companyDailyProfits.id,
			timestamp: companyDailyProfits.timestamp,
			profit: companyDailyProfits.profit,
		})
		.from(companyDailyProfits)
		.where(gte(companyDailyProfits.timestamp, anchorDate));

	if (rows.length === 0) return 0;
	const now = new Date();
	await db.transaction(async (tx) => {
		for (const row of rows) {
			await tx
				.insert(ledgerEvents)
				.values({
					id: row.id.startsWith("ledger_ev_")
						? row.id
						: `ledger_ev_company_profit_${Math.floor(row.timestamp.getTime() / 1000)}`,
					logId: "company",
					timestamp: row.timestamp,
					type: "account_company",
					categoryId: 0,
					transactionName: "Company daily profit",
					assetsAffected: [],
					cashFlow: 0,
					realizedPnl: row.profit,
					rawLog: null,
					logType: null,
					wealthCategory: "company",
					walletDelta: 0,
					account: "company",
					accountDelta: row.profit,
					assetDelta: row.profit,
					priced: true,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: ledgerEvents.id,
					set: {
						timestamp: row.timestamp,
						accountDelta: row.profit,
						assetDelta: row.profit,
						updatedAt: now,
					},
				});
		}
	});
	return rows.length;
}

/** Writes the opening item holdings the anchor implies. */
async function writeOpeningAssets(
	snapshot: BaselineSnapshot,
	todayEvents: readonly WealthEvent[],
	prices: ReadonlyMap<string, number>,
): Promise<void> {
	// Opening = observed minus everything that moved today, so the day's item
	// events are not counted twice.
	const netByItem = new Map<string, number>();
	for (const event of todayEvents) {
		if (event.mirrored) continue;
		for (const item of event.itemsIn) {
			netByItem.set(
				item.itemId,
				(netByItem.get(item.itemId) ?? 0) + item.quantity,
			);
		}
		for (const item of event.itemsOut) {
			netByItem.set(
				item.itemId,
				(netByItem.get(item.itemId) ?? 0) - item.quantity,
			);
		}
	}

	const now = new Date();
	const seen = new Set<string>();
	await db.transaction(async (tx) => {
		for (const item of snapshot.items) {
			const key = `item_${item.itemId}_${item.location}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const observedQuantity = snapshot.items
				.filter((i) => i.itemId === item.itemId && i.location === item.location)
				.reduce((sum, i) => sum + i.quantity, 0);
			const openingQuantity =
				observedQuantity - (netByItem.get(item.itemId) ?? 0);
			if (openingQuantity <= 0) continue;

			const price = prices.get(item.itemId) ?? 0;
			await tx
				.insert(assets)
				.values({
					id: key,
					type: "item",
					assetId: item.itemId,
					quantity: openingQuantity,
					movingAverageCost: price,
					totalCostBasis: price * openingQuantity,
					marketValue: price,
					location: item.location,
					owner: "personal",
					origin: "wealth_anchor",
					realizedPnl: 0,
					lastUpdated: now,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: assets.id,
					set: {
						quantity: openingQuantity,
						movingAverageCost: price,
						totalCostBasis: price * openingQuantity,
						marketValue: price,
						lastUpdated: now,
						updatedAt: now,
					},
				});
		}
	});
}

// ─── Balances ────────────────────────────────────────────────────────────────

type AnchorRow = typeof wealthAccountSnapshots.$inferSelect;

/**
 * Whether the ledger actually has the row everything else is derived from.
 *
 * `initialised` is written from inside init, and init sets it before doing the
 * work — so a run that fails half way leaves a state that claims to be set up
 * with no anchor behind it. The module then takes the reconcile branch forever
 * and reports zero balances, which is exactly what happened on first deploy.
 *
 * Asking the table is the only answer that cannot be stale.
 */
export async function hasAnchorSnapshot(): Promise<boolean> {
	try {
		const [row] = await db
			.select({ id: wealthAccountSnapshots.id })
			.from(wealthAccountSnapshots)
			.where(eq(wealthAccountSnapshots.source, "anchor"))
			.limit(1);
		return row !== undefined;
	} catch (error) {
		logger.error("Could not check for a wealth anchor:", error);
		return false;
	}
}

async function loadAnchor(): Promise<AnchorRow | null> {
	const [row] = await db
		.select()
		.from(wealthAccountSnapshots)
		.where(eq(wealthAccountSnapshots.source, "anchor"))
		.orderBy(sql`${wealthAccountSnapshots.timestamp} desc`)
		.limit(1);
	return row ?? null;
}

/**
 * Current balances, from the anchor plus every event since.
 *
 * Item value is recovered from `assetDelta` by subtracting the cash and account
 * legs, rather than stored again: `assetDelta = wallet + account + items`, so the
 * item leg is whatever is left.
 */
export async function computeBalances(): Promise<WealthBalances> {
	const anchor = await loadAnchor();
	if (!anchor) {
		return {
			wallet: 0,
			accounts: {},
			holdingsValue: 0,
			trackedNetWorth: 0,
			tornNetWorth: null,
			netWorthDrift: null,
			observedAt: new Date().toISOString(),
		};
	}

	const [totals] = await db
		.select({
			wallet: sql<number>`COALESCE(sum(${ledgerEvents.walletDelta}), 0)`,
			account: sql<number>`COALESCE(sum(${ledgerEvents.accountDelta}), 0)`,
			asset: sql<number>`COALESCE(sum(${ledgerEvents.assetDelta}), 0)`,
		})
		.from(ledgerEvents)
		.where(gte(ledgerEvents.timestamp, anchor.timestamp));

	const walletNet = Number(totals?.wallet ?? 0);
	const accountNet = Number(totals?.account ?? 0);
	const assetNet = Number(totals?.asset ?? 0);

	const perAccount = await db
		.select({
			account: ledgerEvents.account,
			total: sql<number>`COALESCE(sum(${ledgerEvents.accountDelta}), 0)`,
		})
		.from(ledgerEvents)
		.where(gte(ledgerEvents.timestamp, anchor.timestamp))
		.groupBy(ledgerEvents.account);

	const accounts: Partial<Record<WealthAccount, number>> = {
		vault: anchor.vault,
		company: anchor.company,
		bank: anchor.cityBank,
		cayman: anchor.caymanBank,
		piggy: anchor.piggyBank,
		bookie: anchor.bookie,
	};
	for (const row of perAccount) {
		if (!row.account) continue;
		const key = row.account as WealthAccount;
		accounts[key] = (accounts[key] ?? 0) + Number(row.total);
	}

	const holdingsValue = anchor.itemsValue + (assetNet - walletNet - accountNet);
	const wallet = anchor.wallet + walletNet;
	const trackedNetWorth = computeTrackedNetWorth({
		wallet,
		accounts,
		holdingsValue,
	});

	return {
		wallet,
		accounts,
		holdingsValue,
		trackedNetWorth,
		tornNetWorth: anchor.tornNetWorth,
		netWorthDrift:
			anchor.tornNetWorth === null
				? null
				: trackedNetWorth - anchor.tornNetWorth,
		cityBank: null,
		observedAt: anchor.timestamp.toISOString(),
	};
}

/** Coverage, from the events themselves plus the log-type reference. */
export async function computeCoverage(): Promise<WealthCoverage> {
	const [counts] = await db
		.select({
			priced: sql<number>`count(*) filter (where ${ledgerEvents.priced})`,
			unpriced: sql<number>`count(*) filter (where not ${ledgerEvents.priced})`,
			unpricedAmount: sql<number>`COALESCE(sum(abs(${ledgerEvents.assetDelta})) filter (where not ${ledgerEvents.priced}), 0)`,
		})
		.from(ledgerEvents);

	const unclassifiedRows = await db
		.select({
			logType: ledgerEvents.logType,
			events: sql<number>`count(*)`,
			title: sql<string | null>`max(${ledgerEvents.transactionName})`,
		})
		.from(ledgerEvents)
		.where(eq(ledgerEvents.wealthCategory, "other"))
		.groupBy(ledgerEvents.logType);

	const classifiedRows = await db
		.select({ logType: ledgerEvents.logType })
		.from(ledgerEvents)
		.groupBy(ledgerEvents.logType);

	const [referenceCount] = await db
		.select({ total: sql<number>`count(*)` })
		.from(tornLogTypes);

	return {
		pricedEvents: Number(counts?.priced ?? 0),
		unpricedEvents: Number(counts?.unpriced ?? 0),
		unpricedAmount: Number(counts?.unpricedAmount ?? 0),
		unclassified: unclassifiedRows
			.filter((row) => row.logType !== null)
			.map((row) => ({
				logType: Number(row.logType),
				title: row.title,
				events: Number(row.events),
				sample: "",
			})),
		classifiedLogTypes: classifiedRows.filter((row) => row.logType !== null)
			.length,
		totalLogTypes:
			Number(referenceCount?.total ?? 0) > 0
				? Number(referenceCount?.total)
				: null,
	};
}

async function buildLedgerState(
	state: WealthState,
): Promise<WealthLedgerState> {
	return {
		status: state.status,
		initialised: state.initialised,
		anchorTimestamp: state.anchorTimestamp,
		anchorDate: state.anchorDate,
		totalIndexedEvents: state.totalIndexedEvents,
		lastReconciledAt: state.lastReconciledAt,
		lastError: state.lastError,
		updatedAt: state.updatedAt,
		coverage: await computeCoverage(),
	};
}

// ─── Init ────────────────────────────────────────────────────────────────────

export type InitResult = {
	state: WealthState;
	eventsWritten: number;
	baseline: BaselineSnapshot;
};

/**
 * Anchors the ledger and writes day zero.
 *
 * `startTimestampSec` defaults to 00:00 UTC today. Whatever the anchor, the
 * balances recorded are OPENING balances: observed minus the events that already
 * happened since the anchor, so the same activity is never counted in the
 * balances and in the ledger.
 */
let initInFlight: Promise<InitResult> | null = null;

/**
 * Anchors the ledger, at most once at a time.
 *
 * Two callers reach this on the same boot: the module's own startup call and the
 * event runner's first tick, which fires immediately unless a stagger is
 * configured. Both see "no anchor" and both would rebuild — interleaving their
 * deletes and inserts, and racing to write the same anchor row. Sharing the
 * in-flight promise makes the second caller wait for the first instead.
 */
export function initWealthTracking(
	startTimestampSec?: number,
): Promise<InitResult> {
	if (initInFlight) {
		logger.info(
			"An anchor is already being written; waiting for it instead of starting a second.",
		);
		return initInFlight;
	}
	initInFlight = runWealthInit(startTimestampSec).finally(() => {
		initInFlight = null;
	});
	return initInFlight;
}

/** Test seam: clears the in-flight anchor guard. */
export function resetWealthInitGuard(): void {
	initInFlight = null;
}

async function runWealthInit(startTimestampSec?: number): Promise<InitResult> {
	const now = new Date();
	const requested = readNumber(startTimestampSec);
	const anchorTimestamp =
		requested !== null && requested > 0
			? Math.trunc(requested)
			: startOfUtcDay(now);
	const anchorDate = new Date(anchorTimestamp * 1000);

	// Anchoring REBUILDS the ledger, so it must never happen as a side effect of
	// booting workers in a test process. The registry test starts every registered
	// worker to check the wiring; without this guard that would delete whatever
	// ledger another test file had just seeded, and reach for the Torn API to do
	// it. Everything past this point is destructive by design.
	if (process.env.NODE_ENV === "test") {
		logger.warn(
			"Refusing to anchor the wealth ledger in a test process: anchoring rebuilds `ledger_events`.",
		);
		return {
			state: {
				...DEFAULT_STATE,
				status: "idle",
				lastError: "Anchoring is disabled in test environments.",
			},
			eventsWritten: 0,
			baseline: {
				wallet: 0,
				points: 0,
				vault: 0,
				company: 0,
				cityBank: 0,
				caymanBank: 0,
				tornNetWorth: null,
				items: [],
				holdingsValue: 0,
				pointsValue: 0,
				failures: [],
				raw: {},
			},
		};
	}

	// `initialised` stays false until the anchor row is actually written. Setting
	// it optimistically here is what left the deployed ledger permanently in a
	// state that claimed to be anchored while having no balances at all.
	const state: WealthState = {
		...DEFAULT_STATE,
		status: "running",
		initialised: false,
		anchorTimestamp,
		anchorDate: anchorDate.toISOString(),
		logTypesSyncedAt: inMemoryState.logTypesSyncedAt,
	};
	await persistWealthState(state);

	try {
		const keyEntry = await getPersonalKey();
		if (!keyEntry) {
			logger.warn(
				"No personal API key registered. The wealth ledger cannot be anchored.",
			);
			state.status = "completed";
			state.lastError =
				"No personal API key registered, so no balances could be read.";
			await persistWealthState(state);
			return {
				state,
				eventsWritten: 0,
				baseline: {
					wallet: 0,
					points: 0,
					vault: 0,
					company: 0,
					cityBank: 0,
					caymanBank: 0,
					tornNetWorth: null,
					items: [],
					holdingsValue: 0,
					pointsValue: 0,
					failures: ["no API key"],
					raw: {},
				},
			};
		}

		logger.info(
			`Anchoring the wealth ledger at ${anchorDate.toISOString()} (00:00 UTC of the anchor day)...`,
		);

		await syncTornLogTypes(true, keyEntry);
		const baseline = await snapshotBalances(keyEntry);
		const prices = await loadItemPrices();

		// Everything since the anchor, which is what the opening balances must
		// unwind.
		const logs = await readLogsSince(anchorDate);
		const events = await classifyRows(logs);
		const opening = deriveOpeningBalances({
			observedWallet: baseline.wallet,
			observedHoldingsValue: baseline.holdingsValue,
			observedAccounts: {
				vault: baseline.vault,
				company: baseline.company,
				bank: baseline.cityBank,
				cayman: baseline.caymanBank,
				// The bookie balance is not in the API response; it is reconstructed
				// from the log, so its opening value is whatever the day's bets imply.
				bookie: 0,
			},
			todayEvents: events,
		});

		// Rebuild from scratch: the ledger owns this table, and stale rows from a
		// previous anchor would be double-counted.
		await db.delete(ledgerEvents);
		await db.delete(assets);
		await db.delete(wealthAccountSnapshots);

		const anchorId = `wealth_anchor_${anchorTimestamp}`;
		await db
			.insert(wealthAccountSnapshots)
			.values({
				id: anchorId,
				timestamp: anchorDate,
				source: "anchor",
				wallet: opening.wallet,
				points: baseline.points,
				vault: opening.accounts.vault ?? 0,
				company: opening.accounts.company ?? 0,
				cityBank: opening.accounts.bank ?? 0,
				caymanBank: opening.accounts.cayman ?? 0,
				piggyBank: opening.accounts.piggy ?? 0,
				bookie: opening.accounts.bookie ?? 0,
				itemsValue: opening.holdingsValue,
				trackedNetWorth: computeTrackedNetWorth({
					wallet: opening.wallet,
					accounts: opening.accounts,
					holdingsValue: opening.holdingsValue,
				}),
				tornNetWorth: baseline.tornNetWorth,
				netWorthDrift: null,
				raw: baseline.raw,
			})
			.onConflictDoUpdate({
				target: wealthAccountSnapshots.id,
				set: {
					timestamp: anchorDate,
					source: "anchor",
					wallet: opening.wallet,
					points: baseline.points,
					vault: opening.accounts.vault ?? 0,
					company: opening.accounts.company ?? 0,
					cityBank: opening.accounts.bank ?? 0,
					caymanBank: opening.accounts.cayman ?? 0,
					piggyBank: opening.accounts.piggy ?? 0,
					bookie: opening.accounts.bookie ?? 0,
					itemsValue: opening.holdingsValue,
					trackedNetWorth: computeTrackedNetWorth({
						wallet: opening.wallet,
						accounts: opening.accounts,
						holdingsValue: opening.holdingsValue,
					}),
					tornNetWorth: baseline.tornNetWorth,
					netWorthDrift: null,
					raw: baseline.raw,
				},
			});

		const written = await writeEvents(events);
		const companyEvents = await writeCompanyProfitEvents(anchorDate);
		await writeOpeningAssets(baseline, events, prices);

		state.totalIndexedEvents = written + companyEvents;
		state.status = "completed";
		// The anchor row exists, so the ledger is genuinely usable now.
		state.initialised = true;
		state.lastReconciledAt = new Date().toISOString();
		state.lastError =
			baseline.failures.length > 0
				? `Baseline incomplete for: ${baseline.failures.join("; ")}`
				: null;
		await persistWealthState(state);

		logger.info(
			`Wealth ledger anchored. ${written + companyEvents} events indexed, ` +
				`opening wallet $${opening.wallet.toLocaleString()}, ` +
				`holdings $${opening.holdingsValue.toLocaleString()}.`,
		);

		return { state, eventsWritten: written + companyEvents, baseline };
	} catch (error) {
		logger.error("Failed to anchor the wealth ledger:", error);
		state.status = "error";
		state.lastError = error instanceof Error ? error.message : String(error);
		await persistWealthState(state);
		return {
			state,
			eventsWritten: 0,
			baseline: {
				wallet: 0,
				points: 0,
				vault: 0,
				company: 0,
				cityBank: 0,
				caymanBank: 0,
				tornNetWorth: null,
				items: [],
				holdingsValue: 0,
				pointsValue: 0,
				failures: ["init failed"],
				raw: {},
			},
		};
	}
}

// ─── Live ingest and reconcile ───────────────────────────────────────────────

/** Classifies and writes a freshly polled page of logs from the live stream. */
export async function handleIncomingWealthLogs(
	logs: TornSchema<"UserLog">[],
): Promise<number> {
	const state = getWealthState();
	if (!state.initialised || state.anchorTimestamp === null) return 0;

	const anchorDate = new Date(state.anchorTimestamp * 1000);
	const fresh = logs.filter(
		(log) => new Date(Number(log.timestamp) * 1000) >= anchorDate,
	);
	if (fresh.length === 0) return 0;

	const [prices, unitRates] = await Promise.all([
		loadItemPrices(),
		loadUnitRates(),
	]);
	const events: WealthEvent[] = [];
	for (const log of fresh) {
		const details = log.details as { id?: number; title?: string } | undefined;
		const event = classifyWealthLog(
			{
				id: String(log.id),
				log: Number(details?.id ?? 0),
				title: (details?.title as string | undefined) ?? null,
				timestamp: new Date(Number(log.timestamp) * 1000),
				// The live stream hands over the parsed log object, which is the same
				// shape `personal_logs.data` holds, so one classifier serves both.
				data: log as unknown as Record<string, unknown>,
			},
			{ itemPrices: prices, unitRates },
		);
		if (event) events.push(event);
	}

	const written = await writeEvents(events);
	if (written > 0) {
		state.totalIndexedEvents += written;
		state.lastError = null;
		await persistWealthState(state);
	}
	return written;
}

/**
 * Fills in any log the live path missed.
 *
 * An anti-join rather than a timestamp window: a dropped page, a restart or an
 * out-of-order insert all leave a hole that a "since last seen" scan silently
 * steps over, and the ledger would then be quietly short.
 */
export async function reconcileWealthTracker(): Promise<number> {
	const state = await loadWealthState();

	// Reconciling means filling in logs the ledger missed. There is nothing to
	// fill in until the ledger has an anchor, so this anchors instead — which also
	// makes the hourly cadence a retry loop: a ledger that could not be built at
	// boot because no API key was registered gets built as soon as one is.
	if (
		!state.initialised ||
		state.anchorTimestamp === null ||
		!(await hasAnchorSnapshot())
	) {
		logger.info(
			"The wealth ledger has no anchor yet. Anchoring it at 00:00 UTC of today...",
		);
		const result = await initWealthTracking();
		return result.eventsWritten;
	}

	state.status = "running";
	await persistWealthState(state);

	try {
		const anchorDate = new Date(state.anchorTimestamp * 1000);
		const missing = await db
			.select({
				id: personalLogs.id,
				log: personalLogs.log,
				title: personalLogs.title,
				timestamp: personalLogs.timestamp,
				data: personalLogs.data,
			})
			.from(personalLogs)
			.leftJoin(ledgerEvents, eq(personalLogs.id, ledgerEvents.logId))
			.where(
				and(gte(personalLogs.timestamp, anchorDate), isNull(ledgerEvents.id)),
			)
			.orderBy(personalLogs.timestamp);

		let written = 0;
		if (missing.length > 0) {
			const events = await classifyRows(missing);
			written = await writeEvents(events);
			await writeCompanyProfitEvents(anchorDate);
		}

		// Refresh the log-type reference and record a snapshot, so drift is
		// measured against a fresh Torn figure rather than a stale one.
		await syncTornLogTypes();
		await recordSnapshot();

		state.status = "completed";
		state.totalIndexedEvents += written;
		state.lastReconciledAt = new Date().toISOString();
		state.lastError = null;
		await persistWealthState(state);

		if (written > 0) {
			logger.info(`Wealth reconciliation indexed ${written} missing events.`);
		}
		return written;
	} catch (error) {
		logger.error("Wealth reconciliation failed:", error);
		state.status = "error";
		state.lastError = error instanceof Error ? error.message : String(error);
		await persistWealthState(state);
		return 0;
	}
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

/**
 * Reads the live balances and records what the ledger thinks the account is worth.
 *
 * The `daily_networth` comparison is the point of this: a tracked figure that
 * drifts away from Torn's own means a rule is wrong, and this is the only place
 * that can be noticed without a human reading every category.
 */
export async function recordSnapshot(): Promise<WealthBalances> {
	const balances = await computeBalances();
	const key = await getPersonalKey();
	if (!key) {
		logger.warn(
			"No personal API key is registered, so no balance snapshot was recorded.",
		);
		return balances;
	}
	try {
		const observed = await snapshotBalances(key);
		const tracked = balances.trackedNetWorth;
		const drift =
			observed.tornNetWorth === null ? null : tracked - observed.tornNetWorth;

		await db
			.insert(wealthAccountSnapshots)
			.values({
				id: `wealth_snapshot_${Math.floor(Date.now() / 1000)}`,
				timestamp: new Date(),
				source: "api",
				wallet: observed.wallet,
				points: observed.points,
				vault: observed.vault,
				company: observed.company,
				cityBank: observed.cityBank,
				caymanBank: observed.caymanBank,
				piggyBank: 0,
				bookie: balances.accounts.bookie ?? 0,
				itemsValue: observed.holdingsValue,
				trackedNetWorth: tracked,
				tornNetWorth: observed.tornNetWorth,
				netWorthDrift: drift,
				raw: observed.raw,
			})
			.onConflictDoNothing({ target: wealthAccountSnapshots.id });

		return {
			...balances,
			tornNetWorth: observed.tornNetWorth,
			netWorthDrift: drift,
			cityBank:
				observed.cityBank > 0
					? {
							amount: observed.cityBank,
							profit: 0,
							until: null,
						}
					: null,
		};
	} catch (error) {
		logger.warn(
			`Could not record a wealth snapshot: ${error instanceof Error ? error.message : String(error)}`,
		);
		return balances;
	}
}

// ─── Worker ──────────────────────────────────────────────────────────────────

/**
 * Starts the wealth module:
 *   1. Loads persisted state, anchoring the ledger if it has never run.
 *   2. Follows the `logs_inserted` stream for live tracking.
 *   3. Reconciles hourly, which also refreshes coverage and drift.
 */
export function startWealthModule(options?: WorkerStartOptions): void {
	// Both paths below ask the data rather than the flag: a ledger whose anchor row
	// is missing is rebuilt, however confident its saved state is.
	loadWealthState()
		.then(async () => {
			await reconcileWealthTracker();
		})
		.catch((error) => {
			logger.error("Failed to start the wealth module:", error);
		});

	// A completed log backfill is the moment the ledger can be made whole.
	schedulerEvents.on("log_backfill_completed", () => {
		reconcileWealthTracker().catch((error) => {
			logger.error("Wealth reconcile after backfill failed:", error);
		});
	});

	schedulerEvents.on("logs_inserted", (logs) => {
		handleIncomingWealthLogs(logs).catch((error) => {
			logger.error("Live wealth ingest failed:", error);
		});
	});

	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: CADENCE_SEC,
		initialDelayMs: options?.initialDelayMs,
		handler: reconcileWealthTracker,
	});
}

/** Exposed for the audit script: how many rules the table carries. */
export function wealthRuleCount(): number {
	return WEALTH_LOG_RULES.length;
}
