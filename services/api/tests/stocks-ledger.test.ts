import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	db,
	eq,
	systemStates,
	tornStocks,
	userStocks,
} from "@sentinel/database";
import type { StockPortfolioResponse } from "@sentinel/schemas";
import { app } from "../src/app";

/**
 * Route-level coverage for the stock portfolio endpoint.
 *
 * The engine's arithmetic is covered by `packages/utils/tests/stock-portfolio`;
 * what is checked here is the wiring no unit test can see — that the route reads
 * the position and the price table, and that the payload it returns obeys the
 * shared contract the userscript renders.
 *
 * Every fixture uses a stock id no real stock can have, so this runs against a
 * database holding a live account without touching its rows. It writes nothing to
 * `personal_logs` on purpose: the scheduler's ledger tests reconcile that table
 * globally, so a stray row from another test file makes them fail.
 *
 * The one shared row it may write is the points-market price, and only when the
 * database has never synced one; see `seedPointsPrice`.
 */

const TEST_STOCK_ID = 9_000_001;
const TEST_STOCK_ID_STR = String(TEST_STOCK_ID);
const SHARES = 1_000;
const BUY_PRICE = 200;
const MARKET_PRICE = 250;
const DAY = 86_400;

/** State row the route prices payouts paid in points from. */
const POINTS_PRICE_STATE_ID = "points_market_price";
/** Stand-in points price, used only when the database holds no synced one. */
const TEST_POINTS_PRICE = 31_359;

/**
 * Supplies the points-market price when the database has none.
 *
 * `points_market_price` is written by the scheduler's daily Torn reference sync
 * and by nothing else, so a freshly migrated database — CI, or a new deployment
 * before the sync has run — has no row at all. The route then reports every
 * payout paid in points as unpriced, and the assertions below, which cover the
 * wiring between that row and the payload, would be measuring the presence of
 * the sync rather than the route.
 *
 * A row that is already there is left exactly as it is: on a database holding a
 * live account it is the real synced price, and a test must not overwrite it.
 * Only a fixture this file wrote is undone again.
 */
let seededPointsPrice = false;
let originalPointsPrice: typeof systemStates.$inferSelect | undefined;

/** The price a state row carries, mirroring how the route reads it. */
function readPointsPrice(data: unknown): number {
	if (!data || typeof data !== "object") return 0;
	const price = (data as Record<string, unknown>).price;
	return typeof price === "number" && Number.isFinite(price) && price > 0
		? price
		: 0;
}

async function seedPointsPrice(): Promise<void> {
	const existing = await db.query.systemStates.findFirst({
		where: eq(systemStates.id, POINTS_PRICE_STATE_ID),
	});
	if (readPointsPrice(existing?.data) > 0) return;

	originalPointsPrice = existing;
	const now = new Date();
	await db
		.insert(systemStates)
		.values({
			id: POINTS_PRICE_STATE_ID,
			data: { price: TEST_POINTS_PRICE },
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: systemStates.id,
			set: { data: { price: TEST_POINTS_PRICE }, updatedAt: now },
		});
	seededPointsPrice = true;
}

/** Puts back whatever the fixture replaced, so no test leaves state behind. */
async function restorePointsPrice(): Promise<void> {
	if (!seededPointsPrice) return;
	seededPointsPrice = false;

	const original = originalPointsPrice;
	originalPointsPrice = undefined;
	if (!original) {
		await db
			.delete(systemStates)
			.where(eq(systemStates.id, POINTS_PRICE_STATE_ID));
		return;
	}

	await db
		.insert(systemStates)
		.values(original)
		.onConflictDoUpdate({
			target: systemStates.id,
			set: {
				init: original.init,
				data: original.data,
				updatedAt: original.updatedAt,
			},
		});
}

async function cleanup(): Promise<void> {
	await db.delete(userStocks).where(eq(userStocks.id, TEST_STOCK_ID_STR));
	await db.delete(tornStocks).where(eq(tornStocks.id, TEST_STOCK_ID_STR));
}

async function seed(): Promise<void> {
	await cleanup();

	const now = new Date();
	const boughtAt = Math.floor(Date.now() / 1000) - 20 * DAY;

	// A stored price row also keeps the route's stale-price refresh from reaching
	// for Torn mid-test: prices exist, and they are fresh.
	await db.insert(tornStocks).values({
		id: TEST_STOCK_ID_STR,
		name: "Test Holdings",
		acronym: "TST",
		market: { price: MARKET_PRICE },
		bonus: {
			passive: false,
			frequency: 7,
			requirement: 1_000,
			description: "100 test credits",
		},
		createdAt: now,
		updatedAt: now,
	});

	await db.insert(userStocks).values({
		id: TEST_STOCK_ID_STR,
		shares: SHARES,
		transactions: [{ shares: SHARES, price: BUY_PRICE, timestamp: boughtAt }],
		bonus: { available: false, increment: 1, progress: 2, frequency: 7 },
		createdAt: now,
		updatedAt: now,
	});
}

async function getPortfolio(query = ""): Promise<StockPortfolioResponse> {
	const response = await app.handle(
		new Request(`http://localhost/v2/system/stocks-ledger/portfolio${query}`),
	);
	expect(response.status).toBe(200);
	return (await response.json()) as StockPortfolioResponse;
}

describe("Stock portfolio route", () => {
	beforeAll(async () => {
		await seedPointsPrice();
	});

	afterAll(async () => {
		await cleanup();
		await restorePointsPrice();
	});

	test("GET /v2/system/stocks-ledger/state reports the ledger state shape", async () => {
		const response = await app.handle(
			new Request("http://localhost/v2/system/stocks-ledger/state"),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as Record<string, unknown>;
		expect(typeof data.status).toBe("string");
		expect(typeof data.totalIndexedLogs).toBe("number");
		expect(typeof data.updatedAt).toBe("string");
	});

	test("GET /portfolio lists the whole catalogue even with nothing held", async () => {
		const portfolio = await getPortfolio();

		expect(portfolio.success).toBe(true);
		// The catalogue is the fallback for a database with no `torn_stocks` rows, so
		// it has to stand on its own rather than reflecting whatever is stored. Each
		// stock contributes at least two increments, so the row count is larger.
		expect(portfolio.blocks.length).toBeGreaterThanOrEqual(70);
		const mcsFirst = portfolio.blocks.find(
			(block) => block.acronym === "MCS" && block.increment === 1,
		);
		expect(mcsFirst?.held).toBe(false);
		expect(mcsFirst?.progressPct).toBe(0);
		// Points trade, so a points payout is priced from the points market; energy
		// cannot be sold for cash, so MCS's payout still carries no dollar figure.
		expect(portfolio.pointsPrice).toBeGreaterThan(0);
		const pts = portfolio.blocks.find(
			(block) => block.acronym === "PTS" && block.increment === 1,
		);
		expect(pts?.payoutValue).toBe(portfolio.pointsPrice * 100);
		expect(pts?.payoutNote).toBeUndefined();
		const mcsEnergy = portfolio.blocks.find(
			(block) => block.acronym === "MCS" && block.increment === 1,
		);
		expect(mcsEnergy?.payoutValue).toBeNull();
		expect(mcsEnergy?.annualizedAprPct).toBeNull();
	});

	test("reports a seeded position with its cost basis and progress", async () => {
		await seed();

		const portfolio = await getPortfolio();
		const holding = portfolio.holdings.find((h) => h.stockId === TEST_STOCK_ID);

		expect(holding).toBeDefined();
		expect(holding?.shares).toBe(SHARES);
		expect(holding?.price).toBe(MARKET_PRICE);
		// A purchase list but no log history, so the basis comes from Torn's own
		// transactions rather than from a replay.
		expect(holding?.reconciliation.source).toBe("transactions");
		expect(holding?.term.invested).toBe(SHARES * BUY_PRICE);
		expect(holding?.marketValue).toBe(SHARES * MARKET_PRICE);
		expect(holding?.unrealized).toBe(SHARES * (MARKET_PRICE - BUY_PRICE));
		// A stock the catalogue has never heard of cannot be priced, so its payout
		// has no dollar figure and no ROI is claimed for the movement alone.
		expect(holding?.benefit.valuation.priced).toBe(false);
		expect(holding?.benefit.valuation.pricingNote).toContain("catalogue");
		expect(holding?.roiPct).toBeNull();
		expect(holding?.roiNote).toContain("catalogue");
		expect(holding?.income).toBe(0);
		// Torn reports 2 of 7 days of progress.
		expect(holding?.progress?.daysUntil).toBe(5);
	});

	test("ignores the removed resource-rate parameters instead of failing", async () => {
		await seed();

		// The reader no longer supplies rates: points are priced from the points
		// market and energy, nerve and happiness are not priced at all. A stale
		// client sending the old query string must still get a portfolio back.
		const portfolio = await getPortfolio("?energy=5000&nerve=80000");
		expect(portfolio.success).toBe(true);
		expect(portfolio.pointsPrice).toBeGreaterThan(0);
	});
});
