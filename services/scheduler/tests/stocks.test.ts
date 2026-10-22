import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";

import {
	db,
	eq,
	inArray,
	personalLedgerSyncStates,
	personalLogs,
	stockLedgers,
	tornItems,
	tornStocks,
	userStocks,
} from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";

import { schedulerEvents } from "../src/lib/events";
import {
	getStocksTotals,
	parseStockGainLog,
	processStockLogsBatch,
	reconcileHistoricalStockLogs,
	startStocksLedger,
} from "../src/workers/personal/stocks";

type UserLog = TornSchema<"UserLog">;

describe("Stocks Ledger Worker & Ingestion Pipeline", () => {
	const TEST_STATE_ID = "stocks";
	const LOG_ID_1 = "test_stock_log_1";
	const LOG_ID_2 = "test_stock_log_2";
	const LOG_ID_3 = "test_stock_log_3";
	const LOG_ID_4 = "test_stock_log_4";
	const LOG_ID_NON_STOCK = "test_stock_non_stock";
	const ALL_TEST_LOG_IDS = [
		LOG_ID_1,
		LOG_ID_2,
		LOG_ID_3,
		LOG_ID_4,
		LOG_ID_NON_STOCK,
	] as const;

	// Synthetic ids on purpose. `torn_stocks` and `torn_items` are reference data
	// cloned from the service database, so Torn's real stocks 12/34 and item 500
	// already exist here. Seeding fixtures under those ids was silently ignored
	// (`onConflictDoNothing`), which left `parseStockGainLog` reading the live
	// rows: the real stock 12 demands 6,000,000 shares and the real stock 34 has a
	// passive bonus, so the below-requirement and passive-bonus guards skipped
	// every dividend these tests expect to be booked. Synthetic ids also keep this
	// suite's cleanup from deleting reference rows other suites read.
	const TEST_STOCK_ID_1 = 900012;
	const TEST_STOCK_ID_2 = 900034;
	/** Passive bonus: never pays a dividend, however many shares are held. */
	const TEST_STOCK_ID_PASSIVE = 900035;
	/** Holds fewer shares than this stock's bonus requirement. */
	const TEST_STOCK_ID_UNDER_REQUIREMENT = 900036;
	const TEST_ITEM_ID_1 = 900500;
	const TEST_STOCK_ID_STRINGS = [
		TEST_STOCK_ID_1,
		TEST_STOCK_ID_2,
		TEST_STOCK_ID_PASSIVE,
		TEST_STOCK_ID_UNDER_REQUIREMENT,
	].map(String);

	let originalState: typeof personalLedgerSyncStates.$inferSelect | undefined;
	let fetchSpy: ReturnType<typeof spyOn>;

	beforeAll(async () => {
		originalState = await db.query.personalLedgerSyncStates.findFirst({
			where: eq(personalLedgerSyncStates.ledger, TEST_STATE_ID),
		});

		// Seed tornStocks & tornItems for dividend checks
		await db
			.insert(tornStocks)
			.values([
				{
					id: String(TEST_STOCK_ID_1),
					name: "Test Stock 1",
					acronym: "TS1",
					bonus: { requirement: 100, passive: false },
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				{
					id: String(TEST_STOCK_ID_2),
					name: "Test Stock 2",
					acronym: "TS2",
					bonus: { requirement: 50, passive: false },
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				{
					id: String(TEST_STOCK_ID_PASSIVE),
					name: "Test Passive Stock",
					acronym: "TPS",
					bonus: { requirement: 100, passive: true },
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				{
					id: String(TEST_STOCK_ID_UNDER_REQUIREMENT),
					name: "Test High Requirement Stock",
					acronym: "THR",
					bonus: { requirement: 1000, passive: false },
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			])
			.onConflictDoNothing();

		await db
			.insert(tornItems)
			.values([
				{
					id: String(TEST_ITEM_ID_1),
					name: "Test Item Box",
					data: { market_price: 250000 },
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			])
			.onConflictDoNothing();
	});

	afterAll(async () => {
		schedulerEvents.removeAllListeners();
		if (originalState) {
			await db;
			// Restore the whole typed row: the columns carry what the old blob held
			// as `data`, and there is no longer an `init` flag to put back.
			await db
				.insert(personalLedgerSyncStates)
				.values(originalState)
				.onConflictDoUpdate({
					target: personalLedgerSyncStates.ledger,
					set: {
						status: originalState.status,
						lastError: originalState.lastError,
						totalIndexed: originalState.totalIndexed,
						lastProcessedTimestamp: originalState.lastProcessedTimestamp,
						updatedAt: originalState.updatedAt,
					},
				});
		}

		await db
			.delete(tornStocks)
			.where(inArray(tornStocks.id, TEST_STOCK_ID_STRINGS));
		await db.delete(tornItems).where(eq(tornItems.id, String(TEST_ITEM_ID_1)));
	});

	beforeEach(async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			return new Response(JSON.stringify({ stocks: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch);

		await db
			.delete(personalLedgerSyncStates)
			.where(eq(personalLedgerSyncStates.ledger, TEST_STATE_ID));
		await db
			.delete(stockLedgers)
			.where(inArray(stockLedgers.id, ALL_TEST_LOG_IDS));
		await db
			.delete(personalLogs)
			.where(inArray(personalLogs.id, ALL_TEST_LOG_IDS));
		await db
			.delete(userStocks)
			.where(inArray(userStocks.id, TEST_STOCK_ID_STRINGS));
	});

	afterEach(async () => {
		fetchSpy?.mockRestore();
		schedulerEvents.removeAllListeners();
		await db
			.delete(personalLedgerSyncStates)
			.where(eq(personalLedgerSyncStates.ledger, TEST_STATE_ID));
		await db
			.delete(stockLedgers)
			.where(inArray(stockLedgers.id, ALL_TEST_LOG_IDS));
		await db
			.delete(personalLogs)
			.where(inArray(personalLogs.id, ALL_TEST_LOG_IDS));
		await db
			.delete(userStocks)
			.where(inArray(userStocks.id, TEST_STOCK_ID_STRINGS));
	});

	test("parseStockGainLog parses money and item dividends into stock_ledgers", async () => {
		// Seed active user stocks
		await db.insert(userStocks).values([
			{
				id: String(TEST_STOCK_ID_1),
				shares: 500,
				transactions: [{ timestamp: 1700000000 }],
				bonus: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: String(TEST_STOCK_ID_2),
				shares: 100,
				transactions: [{ timestamp: 1700000000 }],
				bonus: null,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		// 1. Money Dividend Log
		const moneyLog: UserLog = {
			id: LOG_ID_1 as unknown as number,
			timestamp: 1710000000,
			log: 5530,
			title: "Stock Dividend",
			details: { id: 5530, title: "Stock Dividend Money" },
			data: {
				stock: TEST_STOCK_ID_1,
				money: 5000000,
			},
		} as unknown as UserLog;

		const resMoney = await parseStockGainLog(moneyLog);
		expect(resMoney).toBe(true);

		const stockEntry1 = await db.query.stockLedgers.findFirst({
			where: eq(stockLedgers.id, LOG_ID_1),
		});
		expect(stockEntry1).toBeDefined();
		expect(stockEntry1?.stockId).toBe(TEST_STOCK_ID_1);
		expect(stockEntry1?.value).toBe(5000000);
		expect(stockEntry1?.logType).toBe(5530);

		// 2. Item Dividend Log
		const itemLog: UserLog = {
			id: LOG_ID_2 as unknown as number,
			timestamp: 1710000100,
			log: 5531,
			title: "Stock Dividend Item",
			details: { id: 5531, title: "Stock Dividend Item" },
			data: {
				stock: TEST_STOCK_ID_2,
				item: { [TEST_ITEM_ID_1]: 2 },
			},
		} as unknown as UserLog;

		const resItem = await parseStockGainLog(itemLog);
		expect(resItem).toBe(true);

		const stockEntry2 = await db.query.stockLedgers.findFirst({
			where: eq(stockLedgers.id, LOG_ID_2),
		});
		expect(stockEntry2).toBeDefined();
		expect(stockEntry2?.stockId).toBe(TEST_STOCK_ID_2);
		expect(stockEntry2?.itemId).toBe(TEST_ITEM_ID_1);
		expect(stockEntry2?.value).toBe(500000); // 2 * 250000
	});

	test("parseStockGainLog skips passive-bonus stocks and holdings below the share requirement", async () => {
		// The two guards that made every dividend assertion above vacuous while the
		// fixtures were colliding with Torn's real rows (a real passive stock and a
		// real multi-million share requirement). They are worth asserting directly.
		await db.insert(userStocks).values([
			{
				id: String(TEST_STOCK_ID_PASSIVE),
				shares: 500,
				transactions: [{ timestamp: 1700000000 }],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: String(TEST_STOCK_ID_UNDER_REQUIREMENT),
				shares: 10, // requirement is 1000
				transactions: [{ timestamp: 1700000000 }],
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		const passiveLog = {
			id: LOG_ID_3 as unknown as number,
			timestamp: 1710000000,
			log: 5530,
			details: { id: 5530, title: "Stock Dividend Money" },
			data: { stock: TEST_STOCK_ID_PASSIVE, money: 1000000 },
		} as unknown as UserLog;

		const underRequirementLog = {
			id: LOG_ID_4 as unknown as number,
			timestamp: 1710000100,
			log: 5530,
			details: { id: 5530, title: "Stock Dividend Money" },
			data: { stock: TEST_STOCK_ID_UNDER_REQUIREMENT, money: 1000000 },
		} as unknown as UserLog;

		expect(await parseStockGainLog(passiveLog)).toBe(false);
		expect(await parseStockGainLog(underRequirementLog)).toBe(false);

		const booked = await db
			.select({ id: stockLedgers.id })
			.from(stockLedgers)
			.where(inArray(stockLedgers.id, [LOG_ID_3, LOG_ID_4]));
		expect(booked).toEqual([]);
	});

	test("processStockLogsBatch processes dividend logs and skips non-stock logs", async () => {
		await db.insert(userStocks).values({
			id: String(TEST_STOCK_ID_1),
			shares: 500,
			transactions: [{ timestamp: 1700000000 }],
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const logs: UserLog[] = [
			{
				id: LOG_ID_1 as unknown as number,
				timestamp: 1710000000,
				log: 5530,
				details: { id: 5530, title: "Stock Dividend Money" },
				data: { stock: TEST_STOCK_ID_1, money: 1000000 },
			} as unknown as UserLog,
			{
				id: LOG_ID_NON_STOCK as unknown as number,
				timestamp: 1710000200,
				log: 9010,
				details: { id: 9010, title: "Crime: Search for cash" },
				data: { crime_action: "Search junkyard" },
			} as unknown as UserLog,
		];

		const result = await processStockLogsBatch(logs);
		expect(result.processed).toBe(1);
		expect(result.skipped).toBe(1);

		const indexed = await db.query.stockLedgers.findFirst({
			where: eq(stockLedgers.id, LOG_ID_1),
		});
		expect(indexed).toBeDefined();
		expect(indexed?.value).toBe(1000000);
	});

	test("reconcileHistoricalStockLogs anti-joins and indexes unindexed stock gain logs from personal_logs", async () => {
		await db.insert(userStocks).values({
			id: String(TEST_STOCK_ID_1),
			shares: 1000,
			transactions: [{ timestamp: 1700000000 }],
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		await db.insert(personalLogs).values({
			id: LOG_ID_1,
			log: 5530,
			title: "Stock Dividend",
			timestamp: new Date(1710000000 * 1000),
			data: { stock: TEST_STOCK_ID_1, money: 2000000 },
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const result = await reconcileHistoricalStockLogs();
		expect(result.replayed).toBeGreaterThanOrEqual(1);

		const indexed = await db.query.stockLedgers.findFirst({
			where: eq(stockLedgers.id, LOG_ID_1),
		});
		expect(indexed).toBeDefined();
		expect(indexed?.value).toBe(2000000);

		// Re-running when up to date should result in 0 replayed
		const secondRun = await reconcileHistoricalStockLogs();
		expect(secondRun.replayed).toBe(0);
	}, 20_000);

	test("getStocksTotals aggregates stock dividend values and counts", async () => {
		await db.insert(stockLedgers).values([
			{
				id: LOG_ID_1,
				timestamp: new Date(1710000000 * 1000),
				stockId: TEST_STOCK_ID_1,
				logType: 5530,
				value: 1000000,
				createdAt: new Date(),
			},
			{
				id: LOG_ID_2,
				timestamp: new Date(1710000100 * 1000),
				stockId: TEST_STOCK_ID_1,
				logType: 5530,
				value: 1500000,
				createdAt: new Date(),
			},
			{
				id: LOG_ID_3,
				timestamp: new Date(1710000200 * 1000),
				stockId: TEST_STOCK_ID_2,
				logType: 5531,
				value: 3000000,
				createdAt: new Date(),
			},
		]);

		const totals = await getStocksTotals(TEST_STOCK_ID_1);
		expect(totals.length).toBe(1);
		const stock1Total = totals[0];
		expect(stock1Total?.stockId).toBe(TEST_STOCK_ID_1);
		expect((stock1Total?.totalValue ?? 0) >= 2500000).toBe(true);
		expect((stock1Total?.count ?? 0) >= 2).toBe(true);

		const allTotals = await getStocksTotals();
		const s1 = allTotals.find((t) => t.stockId === TEST_STOCK_ID_1);
		const s2 = allTotals.find((t) => t.stockId === TEST_STOCK_ID_2);
		expect(s1).toBeDefined();
		expect(s2).toBeDefined();
		expect((s2?.totalValue ?? 0) >= 3000000).toBe(true);
	});

	test("listens to logs_inserted event and processes stock gain logs", async () => {
		await db.insert(userStocks).values({
			id: String(TEST_STOCK_ID_1),
			shares: 500,
			transactions: [{ timestamp: 1700000000 }],
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		startStocksLedger({ initialDelayMs: 60_000 });

		const eventLog: UserLog = {
			id: LOG_ID_1 as unknown as number,
			timestamp: 1710000000,
			log: 5530,
			details: { id: 5530, title: "Stock Dividend Money" },
			data: { stock: TEST_STOCK_ID_1, money: 750000 },
		} as unknown as UserLog;

		// Simulates the live forward poll; subscribers gate live API calls on this.
		schedulerEvents.emit("logs_inserted", [eventLog], { source: "forward" });

		// Wait for async event listener to finish writing to DB (poll up to 3s)
		let record: typeof stockLedgers.$inferSelect | undefined;
		const start = Date.now();
		while (Date.now() - start < 3000) {
			record = await db.query.stockLedgers.findFirst({
				where: eq(stockLedgers.id, LOG_ID_1),
			});
			if (record) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		expect(record).toBeDefined();
		expect(record?.stockId).toBe(TEST_STOCK_ID_1);
		expect(record?.value).toBe(750000);
	});
});
