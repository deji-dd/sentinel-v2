import {
	db,
	eq,
	inArray,
	personalLogs,
	stockLedgers,
	systemStates,
	tornItems,
	tornStocks,
	userStocks,
} from "@sentinel/database";
import type {
	StockPortfolioResponse,
	StocksLedgerState,
} from "@sentinel/schemas";
import { getPersonalKey, tornApi } from "@sentinel/torn-api";
import {
	computeStockPortfolio,
	extractItemMarketPrice,
	Logger,
	normalizeStockLog,
	readTornStocksPayload,
	readUserStocksPayload,
	STOCK_CATALOG_ITEM_IDS,
	STOCK_LOG_IDS,
	type StockEvent,
	type StockReferenceRow,
} from "@sentinel/utils";
import { Elysia, t } from "elysia";
import { authenticateCrimeLedgerRequest } from "./crime-ledger";

/**
 * The personal stock portfolio endpoint: what is held, what it has paid, what it
 * is worth, and what the *current* term has actually returned.
 *
 * WHY THE API OWNS THE ARITHMETIC
 *
 * Everything needed lives server-side: the live position in `user_stocks`, the
 * full buy/sell/dividend history in `personal_logs`, share prices in
 * `torn_stocks` and item prices in `torn_items`. The userscript holds none of it
 * and has no Torn API key of its own, so it renders what this returns rather than
 * re-deriving it — the same rule the crime, battlestats and company surfaces
 * follow, so two clients can never disagree about the same holding.
 *
 * The engine itself is in `@sentinel/utils` and is pure, which is where the
 * interesting logic (term boundaries, average cost, unpriced benefits) is tested.
 */

const logger = new Logger("API", "StocksLedger");

const STOCKS_LEDGER_STATE_ID = "personal:stocks_ledger";
/** Prices older than this are refreshed on read, so the tab cannot go stale. */
const PRICE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

function parseRate(value: string | undefined): number {
	if (value === undefined) return 0;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Resource rates, in dollars per unit. Zero means "unpriced", never "worthless". */
function rateQuery(query: {
	energy?: string;
	nerve?: string;
	happy?: string;
	points?: string;
}) {
	return {
		energy: parseRate(query.energy),
		nerve: parseRate(query.nerve),
		happy: parseRate(query.happy),
		points: parseRate(query.points),
	};
}

function asList(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object") {
		return Object.values(value as Record<string, unknown>);
	}
	return [];
}

async function loadLedgerState(): Promise<StocksLedgerState> {
	const record = await db.query.systemStates.findFirst({
		where: eq(systemStates.id, STOCKS_LEDGER_STATE_ID),
	});
	const data =
		record?.data && typeof record.data === "object"
			? (record.data as Partial<StocksLedgerState>)
			: {};

	return {
		status: data.status ?? "idle",
		totalIndexedLogs: data.totalIndexedLogs ?? 0,
		lastProcessedTimestamp: data.lastProcessedTimestamp ?? null,
		lastError: data.lastError ?? null,
		updatedAt: data.updatedAt ?? new Date().toISOString(),
	};
}

/** The live position, with the per-stock bonus block Torn reports alongside it. */
async function loadPositions() {
	const rows = await db.query.userStocks.findMany();
	return rows
		.map((row) => ({
			stockId: Number.parseInt(row.id, 10),
			shares: row.shares,
			transactions: row.transactions,
			bonus: row.bonus,
			updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
		}))
		.filter((row) => Number.isFinite(row.stockId) && row.stockId > 0);
}

/**
 * Every stock event in the personal log, oldest first.
 *
 * Buys, sells, splits, merges and all eight dividend log ids: roughly a thousand
 * rows for a long-lived account, which is a cheap read next to reconstructing a
 * cost basis in the browser.
 */
async function loadStockEvents(): Promise<StockEvent[]> {
	const rows = await db
		.select({
			id: personalLogs.id,
			log: personalLogs.log,
			timestamp: personalLogs.timestamp,
			data: personalLogs.data,
		})
		.from(personalLogs)
		.where(inArray(personalLogs.log, [...STOCK_LOG_IDS]))
		.orderBy(personalLogs.timestamp);

	const events: StockEvent[] = [];
	for (const row of rows) {
		const event = normalizeStockLog({
			id: row.id,
			log: row.log,
			timestamp: Math.floor(new Date(row.timestamp).getTime() / 1000),
			data: row.data,
		});
		if (event) events.push(event);
	}
	return events;
}

/** Reference rows for every stock, plus how old those prices are. */
async function loadStockReferences(): Promise<{
	stocks: StockReferenceRow[];
	pricesAsOfIso: string | null;
	newestPriceAt: number | null;
}> {
	const rows = await db.query.tornStocks.findMany();
	let newestPriceAt: number | null = null;
	const stocks: StockReferenceRow[] = [];

	for (const row of rows) {
		const stockId = Number.parseInt(row.id, 10);
		if (!Number.isFinite(stockId) || stockId <= 0) continue;

		const parsed = readTornStocksPayload({
			stocks: [
				{
					id: stockId,
					name: row.name,
					acronym: row.acronym,
					market: row.market,
					bonus: row.bonus,
				},
			],
		})[0];
		if (!parsed) continue;
		stocks.push(parsed);

		const updated = row.updatedAt ? row.updatedAt.getTime() : 0;
		if (updated > 0 && (newestPriceAt === null || updated > newestPriceAt)) {
			newestPriceAt = updated;
		}
	}

	return {
		stocks,
		pricesAsOfIso:
			newestPriceAt === null ? null : new Date(newestPriceAt).toISOString(),
		newestPriceAt,
	};
}

/**
 * Item prices, for the payouts that are a specific item.
 *
 * Two sets of ids are read: every item the catalogue can pay out (so a stock that
 * has never yet paid a dividend can still be priced as a candidate), and anything
 * a loaded dividend log actually paid.
 */
async function loadItemPrices(events: readonly StockEvent[]) {
	const wanted = new Set<number>(STOCK_CATALOG_ITEM_IDS);
	for (const event of events) {
		if (event.kind === "dividend" && event.payment.kind === "item") {
			wanted.add(event.payment.itemId);
		}
	}

	const byId = new Map<number, number>();
	const namesById = new Map<number, string>();
	const byName = new Map<string, number>();
	if (wanted.size === 0) return { byId, namesById, byName };

	const rows = await db
		.select({ id: tornItems.id, name: tornItems.name, data: tornItems.data })
		.from(tornItems)
		.where(inArray(tornItems.id, [...wanted].map(String)));

	for (const row of rows) {
		const itemId = Number.parseInt(row.id, 10);
		if (!Number.isFinite(itemId)) continue;
		const price = extractItemMarketPrice(row.data);
		if (price > 0) byId.set(itemId, price);
		if (row.name) {
			namesById.set(itemId, row.name);
			if (price > 0) byName.set(row.name.toLowerCase(), price);
		}
	}

	return { byId, namesById, byName };
}

/** Dollar values the stocks ledger already recorded for each dividend log. */
async function loadRecordedDividendValues(): Promise<Map<string, number>> {
	const rows = await db
		.select({ id: stockLedgers.id, value: stockLedgers.value })
		.from(stockLedgers);
	return new Map(rows.map((row) => [row.id, Number(row.value) || 0]));
}

/** Pulls the stock list and current prices from Torn and stores them. */
export async function refreshStockReferences(): Promise<number> {
	const payload = (await tornApi.getPersonal("/torn", {
		queryParams: { selections: ["stocks"] },
	})) as { stocks?: unknown };

	const entries = asList(payload.stocks);
	if (entries.length === 0) return 0;

	const now = new Date();
	await db.transaction(async (tx) => {
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") continue;
			const record = entry as Record<string, unknown>;
			const id = Number(record.id);
			if (!Number.isFinite(id) || id <= 0) continue;

			const values = {
				name: typeof record.name === "string" ? record.name : `Stock ${id}`,
				acronym: typeof record.acronym === "string" ? record.acronym : "",
				market: record.market ?? null,
				bonus: record.bonus ?? null,
				images: record.images ?? null,
			};

			await tx
				.insert(tornStocks)
				.values({ id: String(id), ...values, createdAt: now, updatedAt: now })
				.onConflictDoUpdate({
					target: tornStocks.id,
					set: { ...values, updatedAt: now },
				});
		}
	});

	logger.info(`Refreshed ${entries.length} stock prices from Torn.`);
	return entries.length;
}

/** Pulls the live position from Torn and stores it, dropping what is no longer held. */
export async function syncUserStocksFromTorn(): Promise<number> {
	const keyEntry = await getPersonalKey();
	if (!keyEntry) {
		throw new Error(
			"No personal API key is registered, so the position cannot be read from Torn.",
		);
	}

	const positions = readUserStocksPayload(
		await tornApi.getPersonal("/user", {
			queryParams: { selections: ["stocks"] },
		}),
	);
	const now = new Date();

	for (const position of positions) {
		const id = String(position.stockId);
		await db
			.insert(userStocks)
			.values({
				id,
				shares: position.shares,
				transactions: position.transactions,
				bonus: position.bonus,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: userStocks.id,
				set: {
					shares: position.shares,
					transactions: position.transactions,
					bonus: position.bonus,
					updatedAt: now,
				},
			});
	}

	// A position that no longer appears in Torn's response has been sold out of;
	// leaving the stale row behind would keep reporting shares that are not held.
	const heldIds = new Set(positions.map((p) => String(p.stockId)));
	const stored = await db.select({ id: userStocks.id }).from(userStocks);
	const stale = stored.map((row) => row.id).filter((id) => !heldIds.has(id));
	if (stale.length > 0) {
		await db.delete(userStocks).where(inArray(userStocks.id, stale));
	}

	return positions.length;
}

interface PortfolioOptions {
	rates: ReturnType<typeof rateQuery>;
	/** Skip the stale-price refresh (used right after an explicit sync). */
	skipPriceRefresh?: boolean;
}

async function buildPortfolio(
	options: PortfolioOptions,
): Promise<StockPortfolioResponse> {
	const asOfSeconds = Math.floor(Date.now() / 1000);

	let references = await loadStockReferences();
	const pricesMissing = references.stocks.every((s) => s.price <= 0);
	const pricesStale =
		references.newestPriceAt !== null &&
		Date.now() - references.newestPriceAt > PRICE_REFRESH_INTERVAL_MS;

	// Self-healing prices. The daily reference sync owns `torn_stocks`, but it can
	// legitimately be empty on a fresh database or a skipped cycle, and a portfolio
	// that cannot mark to market is not worth showing. One Torn API call, only when
	// the data is actually missing or stale, and never fatal.
	if (!options.skipPriceRefresh && (pricesMissing || pricesStale)) {
		try {
			await refreshStockReferences();
			references = await loadStockReferences();
		} catch (error) {
			logger.warn(
				`Could not refresh stock prices on read: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const [positions, events, recordedDividendValues] = await Promise.all([
		loadPositions(),
		loadStockEvents(),
		loadRecordedDividendValues(),
	]);
	const itemPrices = await loadItemPrices(events);

	const positionAsOfIso =
		positions
			.map((p) => p.updatedAt)
			.filter((iso): iso is string => Boolean(iso))
			.sort()
			.at(-1) ?? null;

	const portfolio = computeStockPortfolio({
		asOfSeconds,
		holdings: positions,
		events,
		recordedDividendValues,
		stocks: references.stocks,
		rates: options.rates,
		itemPricesById: itemPrices.byId,
		itemPricesByName: itemPrices.byName,
		itemNamesById: itemPrices.namesById,
		positionAsOfIso,
		pricesAsOfIso: references.pricesAsOfIso,
	});

	if (positions.length === 0) {
		portfolio.message =
			"No stock positions are on record. The list below is what can be bought.";
	}

	return portfolio;
}

export const stocksLedgerRoutes = new Elysia({ prefix: "/stocks-ledger" })
	.derive(async ({ headers, set }) => {
		const isAuthed = await authenticateCrimeLedgerRequest(headers);
		if (!isAuthed) {
			set.status = 401;
			throw new Error("Unauthorized: Invalid API key.");
		}
		return {};
	})
	// GET /v2/system/stocks-ledger/state — indexing telemetry for the ledger
	.get("/state", async () => loadLedgerState(), {
		detail: {
			summary: "Stocks ledger state",
			description:
				"Reports how much of the personal log's stock history has been indexed into the stocks ledger.",
		},
	})
	// GET /v2/system/stocks-ledger/portfolio — current-term holdings, profit and ROI
	.get(
		"/portfolio",
		async ({ query }) => buildPortfolio({ rates: rateQuery(query) }),
		{
			query: t.Object({
				energy: t.Optional(t.String()),
				nerve: t.Optional(t.String()),
				happy: t.Optional(t.String()),
				points: t.Optional(t.String()),
			}),
			detail: {
				summary: "Personal stock portfolio",
				description:
					"Computes the current holding term for every owned stock — cost basis, dividends collected, mark-to-market value, realised and unrealised profit, term ROI and forward yield — plus the full stock list as candidates.",
			},
		},
	)
	// POST /v2/system/stocks-ledger/sync — pull the live position and prices from Torn
	.post(
		"/sync",
		async ({ query, set }) => {
			try {
				const [positionCount] = await Promise.all([
					syncUserStocksFromTorn(),
					refreshStockReferences(),
				]);
				logger.info(
					`Manual stock sync: ${positionCount} positions held, prices refreshed.`,
				);
				return await buildPortfolio({
					rates: rateQuery(query),
					skipPriceRefresh: true,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error(`Manual stock sync failed: ${message}`);
				set.status = 502;
				return {
					success: false,
					message,
				} satisfies Partial<StockPortfolioResponse>;
			}
		},
		{
			query: t.Object({
				energy: t.Optional(t.String()),
				nerve: t.Optional(t.String()),
				happy: t.Optional(t.String()),
				points: t.Optional(t.String()),
			}),
			detail: {
				summary: "Sync stock position from Torn",
				description:
					"Reads the live position and share prices from the Torn API on the user's behalf and re-computes the portfolio. Triggered by an explicit action in the client.",
			},
		},
	);
