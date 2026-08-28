import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	crimeActionMappings,
	crimeLogs,
	db,
	eq,
	inArray,
	personalLogs,
	systemStates,
	tornItems,
} from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";
import { schedulerEvents } from "../src/lib/events";
import {
	getCrimeTotals,
	processCrimeLogsBatch,
	reconcileHistoricalCrimeLogs,
	startCrimesLedger,
} from "../src/workers/personal/crimes";

type UserLog = TornSchema<"UserLog">;
type CrimeLog = typeof crimeLogs.$inferSelect;

describe("Crimes Ledger Worker & Ingestion Pipeline", () => {
	const TEST_STATE_ID = "personal:crimes_ledger";
	const LOG_ID_1 = "test_crime_log_1";
	const LOG_ID_2 = "test_crime_log_2";
	const LOG_ID_3 = "test_crime_log_3";
	const LOG_ID_NON_CRIME = "test_crime_non_crime";
	const ALL_TEST_LOG_IDS = [
		LOG_ID_1,
		LOG_ID_2,
		LOG_ID_3,
		LOG_ID_NON_CRIME,
	] as const;
	const TEST_CUSTOM_ACTION = "test_custom_heist";

	const ALL_TEST_ITEM_IDS = [
		"test_item_1",
		"test_item_2",
		"test_item_3",
	] as const;

	let originalState: typeof systemStates.$inferSelect | undefined;

	beforeAll(async () => {
		originalState = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, TEST_STATE_ID),
		});
	});

	afterAll(async () => {
		if (originalState) {
			await db
				.insert(systemStates)
				.values(originalState)
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						init: originalState.init,
						data: originalState.data,
						updatedAt: originalState.updatedAt,
					},
				});
		}
	});

	beforeEach(async () => {
		// Clean up only our specific test fixtures
		await db.delete(systemStates).where(eq(systemStates.id, TEST_STATE_ID));
		await db.delete(crimeLogs).where(inArray(crimeLogs.id, ALL_TEST_LOG_IDS));
		await db
			.delete(personalLogs)
			.where(inArray(personalLogs.id, ALL_TEST_LOG_IDS));
		await db
			.delete(crimeActionMappings)
			.where(eq(crimeActionMappings.id, TEST_CUSTOM_ACTION));
		await db.delete(tornItems).where(inArray(tornItems.id, ALL_TEST_ITEM_IDS));
	});

	afterEach(async () => {
		await db.delete(systemStates).where(eq(systemStates.id, TEST_STATE_ID));
		await db.delete(crimeLogs).where(inArray(crimeLogs.id, ALL_TEST_LOG_IDS));
		await db
			.delete(personalLogs)
			.where(inArray(personalLogs.id, ALL_TEST_LOG_IDS));
		await db
			.delete(crimeActionMappings)
			.where(eq(crimeActionMappings.id, TEST_CUSTOM_ACTION));
		await db.delete(tornItems).where(inArray(tornItems.id, ALL_TEST_ITEM_IDS));
	});

	test("processCrimeLogsBatch indexes crime logs and ignores non-crime logs", async () => {
		const logs: UserLog[] = [
			{
				id: LOG_ID_1 as unknown as string,
				timestamp: 1710000000,
				log: 9010,
				title: "Search for cash",
				details: { id: 9010, title: "Crime: Search for cash" },
				data: {
					crime_action: "Search the junkyard",
					nerve: 2,
					money_gained: 500,
				},
			} as unknown as UserLog,
			{
				id: LOG_ID_2 as unknown as string,
				timestamp: 1710000100,
				log: 9050,
				title: "Shoplifting",
				details: { id: 9050, title: "Crime: Shoplifting" },
				data: {
					crime_action: "Shoplift from sweet shop",
					nerve: 4,
					money_gained: 1200,
				},
			} as unknown as UserLog,
			{
				id: LOG_ID_NON_CRIME as unknown as string,
				timestamp: 1710000200,
				log: 1234, // Non-crime log ID
				title: "Gym Train",
				details: { id: 1234, title: "Gym Train" },
				data: { energy_used: 10 },
			} as unknown as UserLog,
		];

		const result = await processCrimeLogsBatch(logs);
		expect(result.processed).toBe(2);
		expect(result.skipped).toBe(1);

		const indexed: CrimeLog[] = await db
			.select()
			.from(crimeLogs)
			.where(inArray(crimeLogs.id, [LOG_ID_1, LOG_ID_2]))
			.all();

		expect(indexed.length).toBe(2);

		const searchLog = indexed.find((r: CrimeLog) => r.id === LOG_ID_1);
		expect(searchLog).toBeDefined();
		expect(searchLog?.crimeId).toBe(1); // "search" -> Crime ID 1
		expect(searchLog?.nerve).toBe(2);
		expect(searchLog?.value).toBe(500);

		const shopliftLog = indexed.find((r: CrimeLog) => r.id === LOG_ID_2);
		expect(shopliftLog).toBeDefined();
		expect(shopliftLog?.crimeId).toBe(4); // "shoplift" -> Crime ID 4
		expect(shopliftLog?.nerve).toBe(4);
		expect(shopliftLog?.value).toBe(1200);
	});

	test("respects custom crime action mappings", async () => {
		await db.insert(crimeActionMappings).values({
			id: TEST_CUSTOM_ACTION,
			crimeId: 99,
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const customLog: UserLog = {
			id: LOG_ID_1 as unknown as string,
			timestamp: 1710000000,
			log: 9010,
			title: "Custom Heist",
			details: { id: 9010, title: "Custom Heist" },
			data: {
				crime_action: TEST_CUSTOM_ACTION,
				nerve: 15,
				money_gained: 50000,
			},
		} as unknown as UserLog;

		await processCrimeLogsBatch([customLog]);

		const record = await db.query.crimeLogs.findFirst({
			where: eq(crimeLogs.id, LOG_ID_1),
		});

		expect(record).toBeDefined();
		expect(record?.crimeId).toBe(99);
		expect(record?.nerve).toBe(15);
		expect(record?.value).toBe(50000);
	});

	test("factors in real market values for items gained and lost from torn_items", async () => {
		// Insert mock items with market values
		await db.insert(tornItems).values([
			{
				id: "test_item_1",
				name: "Diamond Ring",
				data: { value: { market_price: 25000 } },
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: "test_item_2",
				name: "Gold Watch",
				data: { market_value: 50000 },
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: "test_item_3",
				name: "Lockpick",
				data: { value: { market_price: 5000 } },
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		const crimeLogWithItems: UserLog = {
			id: LOG_ID_1 as unknown as string,
			timestamp: 1710000000,
			log: 9050,
			title: "Burglary",
			details: { id: 9050, title: "Crime: Burglary" },
			data: {
				crime_action: "Burgle a house",
				nerve: 8,
				money_gained: 10000,
				money_lost: 2000,
				items_gained: { test_item_1: 2, test_item_2: 1 }, // (2 * 25000) + (1 * 50000) = 100,000
				items_lost: { test_item_3: 1 }, // 1 * 5000 = 5,000
			},
		} as unknown as UserLog;

		await processCrimeLogsBatch([crimeLogWithItems]);

		const record = await db.query.crimeLogs.findFirst({
			where: eq(crimeLogs.id, LOG_ID_1),
		});

		// 10000 - 2000 + 100000 - 5000 = 103000
		expect(record).toBeDefined();
		expect(record?.crimeId).toBe(7); // "burgle" -> Crime ID 7
		expect(record?.nerve).toBe(8);
		expect(record?.value).toBe(103000);
	});

	test("reconcileHistoricalCrimeLogs non-destructively replays historical crime logs with item market values", async () => {
		// Insert mock items
		await db.insert(tornItems).values([
			{
				id: "test_item_1",
				name: "Rare Artifact",
				data: { market_value: 75000 },
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		// Insert historical logs into personal_logs
		await db.insert(personalLogs).values([
			{
				id: LOG_ID_1,
				log: 9010,
				title: "Historical Crime 1",
				timestamp: new Date(1710000000 * 1000),
				data: {
					crime_action: "Search the cemetery",
					nerve: 2,
					money_gained: 100,
					items_gained: { test_item_1: 1 }, // 1 * 75000
				},
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: LOG_ID_2,
				log: 9060,
				title: "Historical Crime 2",
				timestamp: new Date(1710001000 * 1000),
				data: {
					crime_action: "Pickpocket the drunk",
					nerve: 3,
					money_gained: 300,
				},
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		const result = await reconcileHistoricalCrimeLogs();
		expect(result.replayed).toBeGreaterThanOrEqual(2);

		const indexed = await db
			.select()
			.from(crimeLogs)
			.where(inArray(crimeLogs.id, [LOG_ID_1, LOG_ID_2]))
			.all();

		expect(indexed.length).toBe(2);
		const log1 = indexed.find((r) => r.id === LOG_ID_1);
		expect(log1?.value).toBe(75100); // 100 + 75000

		const stateRecord = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, TEST_STATE_ID),
		});
		expect(stateRecord).toBeDefined();
		expect(stateRecord?.init).toBe(true);
	}, 120000);

	test("reconcileHistoricalCrimeLogs reconciles missing logs from stutter windows using anti-join", async () => {
		// Simulate LOG_ID_1 already processed by real-time stream
		await db.insert(crimeLogs).values({
			id: LOG_ID_1,
			crimeId: 1,
			action: "Search the dumpster",
			nerve: 2,
			value: 50,
			timestamp: new Date(1710000500 * 1000),
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		// Insert both logs in personal_logs (LOG_ID_2 was missed/stuttered)
		await db.insert(personalLogs).values([
			{
				id: LOG_ID_1,
				log: 9010,
				title: "Old Crime",
				timestamp: new Date(1710000500 * 1000),
				data: {
					crime_action: "Search the dumpster",
					nerve: 2,
					money_gained: 50,
				},
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: LOG_ID_2,
				log: 9050,
				title: "Stuttered / Missed Crime",
				timestamp: new Date(1710000200 * 1000), // Older timestamp than LOG_ID_1!
				data: {
					crime_action: "Shoplift clothes",
					nerve: 4,
					money_gained: 500,
				},
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		const result = await reconcileHistoricalCrimeLogs();
		// Only the unindexed log (LOG_ID_2) should be processed despite having an older timestamp
		expect(result.replayed).toBe(1);

		const missingLogIndexed = await db.query.crimeLogs.findFirst({
			where: eq(crimeLogs.id, LOG_ID_2),
		});
		expect(missingLogIndexed).toBeDefined();
		expect(missingLogIndexed?.value).toBe(500);

		// Subsequent run with no missing logs returns 0 immediately
		const followUpResult = await reconcileHistoricalCrimeLogs();
		expect(followUpResult.replayed).toBe(0);
	});

	test("getCrimeTotals aggregates nerve, value, and count", async () => {
		await db.insert(crimeLogs).values([
			{
				id: LOG_ID_1,
				crimeId: 1,
				action: "Search trash",
				nerve: 2,
				value: 100,
				timestamp: new Date(1710000000 * 1000),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: LOG_ID_2,
				crimeId: 1,
				action: "Search junkyard",
				nerve: 2,
				value: 250,
				timestamp: new Date(1710000100 * 1000),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: LOG_ID_3,
				crimeId: 4,
				action: "Shoplift clothes",
				nerve: 4,
				value: 1000,
				timestamp: new Date(1710000200 * 1000),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		const crime1Totals = await getCrimeTotals(1);
		expect(crime1Totals.length).toBe(1);
		const c1First = crime1Totals[0];
		expect(c1First?.crimeId).toBe(1);
		expect((c1First?.nerveSpent ?? 0) >= 4).toBe(true);
		expect((c1First?.totalValue ?? 0) >= 350).toBe(true);
		expect((c1First?.count ?? 0) >= 2).toBe(true);

		const allTotals = await getCrimeTotals();
		const c1 = allTotals.find((t) => t.crimeId === 1);
		const c4 = allTotals.find((t) => t.crimeId === 4);

		expect(c1).toBeDefined();
		expect((c1?.count ?? 0) >= 2).toBe(true);
		expect(c4).toBeDefined();
		expect((c4?.nerveSpent ?? 0) >= 4).toBe(true);
	});

	test("listens to logs_inserted event and processes crime logs", async () => {
		startCrimesLedger();

		const eventLog: UserLog = {
			id: LOG_ID_1 as unknown as string,
			timestamp: 1710000000,
			log: 9010,
			title: "Search for cash",
			details: { id: 9010, title: "Crime: Search for cash" },
			data: {
				crime_action: "Search the junkyard",
				nerve: 8,
				money_gained: 8000,
			},
		} as unknown as UserLog;

		schedulerEvents.emit("logs_inserted", [eventLog]);

		// Give async event listener microtask a moment to write to DB
		await new Promise((resolve) => setTimeout(resolve, 100));

		const record = await db.query.crimeLogs.findFirst({
			where: eq(crimeLogs.id, LOG_ID_1),
		});

		expect(record).toBeDefined();
		expect(record?.crimeId).toBe(1); // "Search the junkyard" -> Crime ID 1
		expect(record?.nerve).toBe(8);
		expect(record?.value).toBe(8000);
	});
});
