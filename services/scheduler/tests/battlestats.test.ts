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
	battlestatsLedgers,
	db,
	eq,
	inArray,
	personalLogs,
	systemStates,
} from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";
import { parseStatGainFromLog } from "@sentinel/utils";
import { schedulerEvents } from "../src/lib/events";
import {
	getBattlestatsTotals,
	processBattlestatsLogsBatch,
	reconcileHistoricalBattlestatsLogs,
	startBattlestatsLedger,
} from "../src/workers/personal/battlestats";

type UserLog = TornSchema<"UserLog">;
type BattlestatsLedgerEntry = typeof battlestatsLedgers.$inferSelect;

describe("Battlestats Ledger Worker & Ingestion Pipeline", () => {
	const TEST_STATE_ID = "personal:battlestats_ledger";
	const LOG_ID_1 = "test_gym_log_1";
	const LOG_ID_2 = "test_gym_log_2";
	const LOG_ID_3 = "test_gym_log_3";
	const LOG_ID_4 = "test_gym_log_4";
	const LOG_ID_NON_GYM = "test_gym_non_gym";
	const ALL_TEST_LOG_IDS = [
		LOG_ID_1,
		LOG_ID_2,
		LOG_ID_3,
		LOG_ID_4,
		LOG_ID_NON_GYM,
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
		await db.delete(systemStates).where(eq(systemStates.id, TEST_STATE_ID));
		await db
			.delete(battlestatsLedgers)
			.where(inArray(battlestatsLedgers.id, ALL_TEST_LOG_IDS));
		await db
			.delete(personalLogs)
			.where(inArray(personalLogs.id, ALL_TEST_LOG_IDS));
	});

	afterEach(async () => {
		await db.delete(systemStates).where(eq(systemStates.id, TEST_STATE_ID));
		await db
			.delete(battlestatsLedgers)
			.where(inArray(battlestatsLedgers.id, ALL_TEST_LOG_IDS));
		await db
			.delete(personalLogs)
			.where(inArray(personalLogs.id, ALL_TEST_LOG_IDS));
	});

	test("parseStatGainFromLog parses all stat types and sources correctly", () => {
		// 1. Gym Train (strength)
		const gymLog = {
			id: "1",
			log: 5300,
			details: { id: 5300, title: "Gym Train" },
			data: {
				strength_increased: 154.25,
				strength_before: 50000,
				strength_after: 50154.25,
				trains: 5,
				energy_used: 25,
			},
		};
		const parsedGym = parseStatGainFromLog(gymLog);
		expect(parsedGym).not.toBeNull();
		expect(parsedGym?.statType).toBe("strength");
		expect(parsedGym?.statGained).toBe(154.25);
		expect(parsedGym?.statBefore).toBe(50000);
		expect(parsedGym?.statAfter).toBe(50154.25);
		expect(parsedGym?.source).toBe("gym");
		expect(parsedGym?.trains).toBe(5);
		expect(parsedGym?.energyUsed).toBe(25);

		// 2. Stat Enhancer Item (defense)
		const enhancerLog = {
			id: "2",
			log: 2130,
			details: { id: 2130, title: "Stat Enhancer" },
			data: {
				defense_increased: 1000000,
				defense_before: 100000000,
				defense_after: 101000000,
			},
		};
		const parsedEnhancer = parseStatGainFromLog(enhancerLog);
		expect(parsedEnhancer).not.toBeNull();
		expect(parsedEnhancer?.statType).toBe("defense");
		expect(parsedEnhancer?.statGained).toBe(1000000);
		expect(parsedEnhancer?.source).toBe("item");

		// 3. Book (speed)
		const bookLog = {
			id: "3",
			log: 2054,
			details: { id: 2054, title: "Book Finish" },
			data: {
				speed_increased: 500000,
				speed_before: 5000000,
				speed_after: 5500000,
			},
		};
		const parsedBook = parseStatGainFromLog(bookLog);
		expect(parsedBook).not.toBeNull();
		expect(parsedBook?.statType).toBe("speed");
		expect(parsedBook?.statGained).toBe(500000);
		expect(parsedBook?.source).toBe("book");

		// 4. Company (dexterity)
		const companyLog = {
			id: "4",
			log: 6529,
			details: { id: 6529, title: "Company Special" },
			data: {
				dexterity_increased: 2500,
				dexterity_before: 250000,
				dexterity_after: 252500,
			},
		};
		const parsedCompany = parseStatGainFromLog(companyLog);
		expect(parsedCompany).not.toBeNull();
		expect(parsedCompany?.statType).toBe("dexterity");
		expect(parsedCompany?.statGained).toBe(2500);
		expect(parsedCompany?.source).toBe("company");

		// 5. Invalid / Non-stat
		expect(parseStatGainFromLog(null)).toBeNull();
		expect(parseStatGainFromLog({})).toBeNull();
		expect(
			parseStatGainFromLog({
				log: 1234,
				data: { something_else: 100 },
			}),
		).toBeNull();
	});

	test("processBattlestatsLogsBatch indexes stat gain logs and ignores non-gym logs", async () => {
		const logs: UserLog[] = [
			{
				id: LOG_ID_1 as unknown as string,
				timestamp: 1710000000,
				log: 5300,
				title: "Gym Train",
				details: { id: 5300, title: "Gym Train" },
				data: {
					strength_increased: 120.5,
					strength_before: 10000,
					strength_after: 10120.5,
					trains: 4,
					energy_used: 20,
				},
			} as unknown as UserLog,
			{
				id: LOG_ID_2 as unknown as string,
				timestamp: 1710000100,
				log: 2130,
				title: "Stat Enhancer",
				details: { id: 2130, title: "Stat Enhancer" },
				data: {
					defense_increased: 500000,
					defense_before: 50000000,
					defense_after: 50500000,
				},
			} as unknown as UserLog,
			{
				id: LOG_ID_NON_GYM as unknown as string,
				timestamp: 1710000200,
				log: 9010,
				title: "Search for cash",
				details: { id: 9010, title: "Crime: Search for cash" },
				data: { crime_action: "Search junkyard" },
			} as unknown as UserLog,
		];

		const result = await processBattlestatsLogsBatch(logs);
		expect(result.processed).toBe(2);
		expect(result.skipped).toBe(1);

		const indexed: BattlestatsLedgerEntry[] = await db
			.select()
			.from(battlestatsLedgers)
			.where(inArray(battlestatsLedgers.id, [LOG_ID_1, LOG_ID_2]));

		expect(indexed.length).toBe(2);

		const gymEntry = indexed.find((r) => r.id === LOG_ID_1);
		expect(gymEntry).toBeDefined();
		expect(gymEntry?.statType).toBe("strength");
		expect(gymEntry?.source).toBe("gym");
		expect(gymEntry?.statGained).toBe(120.5);
		expect(gymEntry?.trains).toBe(4);
		expect(gymEntry?.energyUsed).toBe(20);

		const itemEntry = indexed.find((r) => r.id === LOG_ID_2);
		expect(itemEntry).toBeDefined();
		expect(itemEntry?.statType).toBe("defense");
		expect(itemEntry?.source).toBe("item");
		expect(itemEntry?.statGained).toBe(500000);
	});

	test("reconcileHistoricalBattlestatsLogs anti-join queries and indexes unindexed gym logs from personal_logs", async () => {
		// Insert historical logs into personal_logs
		await db.insert(personalLogs).values([
			{
				id: LOG_ID_1,
				log: 5302,
				title: "Speed Train",
				timestamp: new Date(1710000000 * 1000),
				data: {
					speed_increased: 80.25,
					speed_before: 20000,
					speed_after: 20080.25,
					trains: 2,
					energy_used: 10,
				},
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: LOG_ID_2,
				log: 6529,
				title: "Company Special",
				timestamp: new Date(1710001000 * 1000),
				data: {
					dexterity_increased: 1000,
					dexterity_before: 100000,
					dexterity_after: 101000,
				},
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		const result = await reconcileHistoricalBattlestatsLogs();
		expect(result.replayed).toBeGreaterThanOrEqual(2);

		const indexed = await db
			.select()
			.from(battlestatsLedgers)
			.where(inArray(battlestatsLedgers.id, [LOG_ID_1, LOG_ID_2]));

		expect(indexed.length).toBe(2);
		const speedLog = indexed.find((r) => r.id === LOG_ID_1);
		expect(speedLog?.statType).toBe("speed");
		expect(speedLog?.statGained).toBe(80.25);
		expect(speedLog?.trains).toBe(2);

		const dexLog = indexed.find((r) => r.id === LOG_ID_2);
		expect(dexLog?.statType).toBe("dexterity");
		expect(dexLog?.source).toBe("company");

		const stateRecord = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, TEST_STATE_ID),
		});
		expect(stateRecord).toBeDefined();
		expect(stateRecord?.init).toBe(true);

		// Running reconciliation again when already up to date should result in 0 replayed
		const secondRun = await reconcileHistoricalBattlestatsLogs();
		expect(secondRun.replayed).toBe(0);
	});

	test("reconcileHistoricalBattlestatsLogs reconciles missing logs from stutter windows using anti-join", async () => {
		// Simulate LOG_ID_1 already processed by live stream
		await db.insert(battlestatsLedgers).values({
			id: LOG_ID_1,
			timestamp: new Date(1710000000 * 1000),
			statType: "speed",
			source: "gym",
			trains: 2,
			energyUsed: 10,
			statGained: 80.25,
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		// Insert both LOG_ID_1 and LOG_ID_2 into personal_logs
		await db.insert(personalLogs).values([
			{
				id: LOG_ID_1,
				log: 5302,
				title: "Speed Train",
				timestamp: new Date(1710000000 * 1000),
				data: {
					speed_increased: 80.25,
					speed_before: 20000,
					speed_after: 20080.25,
					trains: 2,
					energy_used: 10,
				},
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: LOG_ID_2,
				log: 6529,
				title: "Company Special",
				timestamp: new Date(1710001000 * 1000),
				data: {
					dexterity_increased: 1000,
					dexterity_before: 100000,
					dexterity_after: 101000,
				},
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		// Anti-join should only process LOG_ID_2 because LOG_ID_1 already exists in battlestatsLedgers
		const result = await reconcileHistoricalBattlestatsLogs();
		expect(result.replayed).toBe(1);

		const indexed = await db
			.select()
			.from(battlestatsLedgers)
			.where(inArray(battlestatsLedgers.id, [LOG_ID_1, LOG_ID_2]));

		expect(indexed.length).toBe(2);
		const dexLog = indexed.find((r) => r.id === LOG_ID_2);
		expect(dexLog).toBeDefined();
		expect(dexLog?.statType).toBe("dexterity");
		expect(dexLog?.statGained).toBe(1000);
	});

	test("getBattlestatsTotals aggregates stat gains, trains, and energy used", async () => {
		await db.insert(battlestatsLedgers).values([
			{
				id: LOG_ID_1,
				timestamp: new Date(1710000000 * 1000),
				statType: "strength",
				source: "gym",
				trains: 10,
				energyUsed: 50,
				statGained: 500,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: LOG_ID_2,
				timestamp: new Date(1710000100 * 1000),
				statType: "strength",
				source: "gym",
				trains: 5,
				energyUsed: 25,
				statGained: 250,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				id: LOG_ID_3,
				timestamp: new Date(1710000200 * 1000),
				statType: "speed",
				source: "gym",
				trains: 8,
				energyUsed: 40,
				statGained: 400,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);

		const strengthTotals = await getBattlestatsTotals("strength");
		expect(strengthTotals.length).toBe(1);
		const strEntry = strengthTotals[0];
		expect(strEntry?.statType).toBe("strength");
		expect((strEntry?.totalGained ?? 0) >= 750).toBe(true);
		expect((strEntry?.trains ?? 0) >= 15).toBe(true);
		expect((strEntry?.energyUsed ?? 0) >= 75).toBe(true);
		expect((strEntry?.count ?? 0) >= 2).toBe(true);

		const allTotals = await getBattlestatsTotals();
		const strTotal = allTotals.find((t) => t.statType === "strength");
		const spdTotal = allTotals.find((t) => t.statType === "speed");

		expect(strTotal).toBeDefined();
		expect(spdTotal).toBeDefined();
		expect((spdTotal?.totalGained ?? 0) >= 400).toBe(true);
	});

	test("listens to logs_inserted event and processes battlestats logs", async () => {
		startBattlestatsLedger();

		const eventLog: UserLog = {
			id: LOG_ID_4 as unknown as string,
			timestamp: 1710000000,
			log: 5300,
			title: "Gym Train",
			details: { id: 5300, title: "Gym Train" },
			data: {
				strength_increased: 300,
				strength_before: 15000,
				strength_after: 15300,
				trains: 6,
				energy_used: 30,
			},
		} as unknown as UserLog;

		schedulerEvents.emit("logs_inserted", [eventLog]);

		// Give async event listener microtask a moment to write to DB
		await new Promise((resolve) => setTimeout(resolve, 100));

		const record = await db.query.battlestatsLedgers.findFirst({
			where: eq(battlestatsLedgers.id, LOG_ID_4),
		});

		expect(record).toBeDefined();
		expect(record?.statType).toBe("strength");
		expect(record?.statGained).toBe(300);
		expect(record?.trains).toBe(6);
		expect(record?.energyUsed).toBe(30);
	});
});
