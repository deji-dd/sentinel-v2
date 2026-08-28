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
	apiKeys,
	db,
	eq,
	like,
	personalLogs,
	systemStates,
} from "@sentinel/database";
import { tornApi } from "@sentinel/torn-api";
import {
	getLogManagerState,
	loadStateFromDb,
	resetLogManagerState,
	resyncLogsRange,
	runLogSyncCycle,
	setBackfillPaused,
	syncForwardLogs,
	syncHistoricalBackfill,
} from "../src/workers/personal/log-manager";

describe("Personal Log Manager Worker", () => {
	let getPersonalSpy: ReturnType<typeof spyOn>;
	const TEST_STATE_ID = "personal:log_manager";
	const TEST_KEY_ID = "test_personal_log_key";

	let savedLogManagerState: typeof systemStates.$inferSelect | undefined;

	beforeAll(async () => {
		savedLogManagerState = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, TEST_STATE_ID),
		});
	});

	afterAll(async () => {
		if (savedLogManagerState) {
			await db
				.insert(systemStates)
				.values(savedLogManagerState)
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						init: savedLogManagerState.init,
						data: savedLogManagerState.data,
						updatedAt: savedLogManagerState.updatedAt,
					},
				});
			await loadStateFromDb();
		}
	});

	beforeEach(async () => {
		// Clean up database test fixtures
		await db.delete(systemStates).where(eq(systemStates.id, TEST_STATE_ID));
		await db.delete(personalLogs).where(like(personalLogs.id, "log_%"));
		await db.delete(apiKeys).where(eq(apiKeys.id, TEST_KEY_ID));

		// Insert dummy personal API key
		await db.insert(apiKeys).values({
			id: TEST_KEY_ID,
			userId: 12345,
			keyType: "personal",
			apiKeyEncrypted: "mock_personal_api_key_test_1234",
			apiKeyHash: "test_hash_personal_log_1234",
			isValid: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		await resetLogManagerState();
	});

	/**
	 * Seeds explicit backfill cursors for a test. Reset now preserves cursors
	 * (and self-heals them from existing personal_logs data), so tests that
	 * exercise from-scratch backfill behavior seed a known cursor instead.
	 */
	async function seedCursors(oldest: number, newest: number): Promise<void> {
		const data = {
			oldestTimestampReached: oldest,
			newestTimestampReached: newest,
		};
		await db
			.insert(systemStates)
			.values({
				id: TEST_STATE_ID,
				init: false,
				data,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: { data, updatedAt: new Date() },
			});
		await loadStateFromDb();
	}

	afterEach(async () => {
		if (getPersonalSpy) {
			getPersonalSpy.mockRestore();
		}
		await db.delete(systemStates).where(eq(systemStates.id, TEST_STATE_ID));
		await db.delete(personalLogs).where(like(personalLogs.id, "log_%"));
		await db.delete(apiKeys).where(eq(apiKeys.id, TEST_KEY_ID));
	});

	test("initializes default state and persists to database", async () => {
		const state = getLogManagerState();
		expect(state.status).toBe("idle");
		expect(state.backfillStatus).toBe("in_progress");
		expect(state.totalLogsRecorded).toBeGreaterThanOrEqual(0);
	});

	test("syncs forward real-time logs and updates newestTimestampReached", async () => {
		const nowSec = Math.floor(Date.now() / 1000);
		const mockLogs = [
			{
				id: "log_forward_1",
				timestamp: nowSec - 50,
				details: { id: 7201, title: "Message receive", category: "Messages" },
				data: {},
				params: {},
			},
			{
				id: "log_forward_2",
				timestamp: nowSec - 20,
				details: { id: 2290, title: "Item use xanax", category: "Drugs" },
				data: {},
				params: {},
			},
		];

		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation(
			// biome-ignore lint/suspicious/noExplicitAny: mock return
			(async (path: string, options?: any) => {
				if (path === "/user/log") {
					if (options?.queryParams?.from) {
						return {
							log: mockLogs,
							_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
						};
					}
				}
				return {
					log: [],
					_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
				};
			}) as unknown as typeof tornApi.getPersonal,
		);

		const result = await syncForwardLogs({ maxPages: 1 });
		expect(result.fetched).toBe(2);

		const state = getLogManagerState();
		expect(state.newestTimestampReached).toBe(nowSec - 20);
		expect(state.forwardLogsCount).toBe(2);

		const dbLogs = await db.query.personalLogs.findMany({
			where: like(personalLogs.id, "log_%"),
		});
		expect(dbLogs.length).toBe(2);
		expect(dbLogs.some((l) => l.id === "log_forward_1")).toBe(true);
		expect(dbLogs.some((l) => l.id === "log_forward_2")).toBe(true);
	});

	test("returns 0 fetched when no new real-time logs exist", async () => {
		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation((async (
			path: string,
		) => {
			if (path === "/user/log") {
				return {
					log: [],
					_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
				};
			}
			return { log: [] };
		}) as unknown as typeof tornApi.getPersonal);

		const result = await syncForwardLogs({ maxPages: 1 });
		expect(result.fetched).toBe(0);
		expect(result.newLogs).toBe(0);
	});

	test("syncs historical backfill and completes when reaching end of logs", async () => {
		const nowSec = Math.floor(Date.now() / 1000);
		await seedCursors(nowSec, nowSec);
		const mockBackfillLogs = [
			{
				id: "log_backfill_1",
				timestamp: nowSec - 500,
				details: { id: 9010, title: "Crime success", category: "Crimes" },
				data: {},
				params: {},
			},
		];

		let callCount = 0;
		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation(
			// biome-ignore lint/suspicious/noExplicitAny: mock return
			(async (path: string, _options?: any) => {
				if (path === "/user/log") {
					callCount++;
					if (callCount === 1) {
						return {
							log: mockBackfillLogs,
							_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
						};
					}
					return {
						log: [],
						_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
					};
				}
				return {
					log: [],
					_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
				};
			}) as unknown as typeof tornApi.getPersonal,
		);

		// First burst batch
		const batch1 = await syncHistoricalBackfill(1);
		expect(batch1.fetched).toBe(1);
		expect(batch1.completed).toBe(false);

		const stateAfter1 = getLogManagerState();
		expect(stateAfter1.oldestTimestampReached).toBe(nowSec - 500);

		// Second burst batch (returns empty logs, finishes backfill)
		const batch2 = await syncHistoricalBackfill(1);
		expect(batch2.fetched).toBe(0);
		expect(batch2.completed).toBe(true);

		const stateAfter2 = getLogManagerState();
		expect(stateAfter2.backfillStatus).toBe("completed");
	});

	test("runs complete log sync cycle with forward and backward calls alongside each other", async () => {
		const nowSec = Math.floor(Date.now() / 1000);
		const forwardLog = {
			id: "log_cycle_forward",
			timestamp: nowSec - 10,
			details: { id: 1112, title: "Item market buy", category: "Item market" },
			data: {},
			params: {},
		};
		const backfillLog = {
			id: "log_cycle_backfill",
			timestamp: nowSec - 10000,
			details: { id: 5303, title: "Gym train dexterity", category: "Gym" },
			data: {},
			params: {},
		};

		let forwardCallDone = false;
		let backfillCallDone = false;

		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation(
			// biome-ignore lint/suspicious/noExplicitAny: mock return
			(async (path: string, options?: any) => {
				if (path === "/user/log") {
					if (options?.queryParams?.from !== undefined) {
						if (!forwardCallDone) {
							forwardCallDone = true;
							return {
								log: [forwardLog],
								_metadata: {
									links: { prev: null, next: null },
									nanostamp: "1",
								},
							};
						}
						return {
							log: [],
							_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
						};
					}
					if (!backfillCallDone) {
						backfillCallDone = true;
						return {
							log: [backfillLog],
							_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
						};
					}
					return {
						log: [],
						_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
					};
				}
				return {
					log: [],
					_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
				};
			}) as unknown as typeof tornApi.getPersonal,
		);

		await runLogSyncCycle();

		const state = getLogManagerState();
		expect(state.forwardLogsCount).toBe(1);
		expect(state.backfillLogsCount).toBe(1);
		expect(state.totalLogsRecorded).toBeGreaterThanOrEqual(2);

		const dbLogs = await db.query.personalLogs.findMany({
			where: like(personalLogs.id, "log_%"),
		});
		expect(dbLogs.length).toBe(2);
	});

	test("pauses and resumes backfill gracefully", async () => {
		await setBackfillPaused(true);
		let state = getLogManagerState();
		expect(state.backfillStatus).toBe("paused");

		// When paused, backfill does not execute
		const res = await syncHistoricalBackfill(1);
		expect(res.fetched).toBe(0);

		await setBackfillPaused(false);
		state = getLogManagerState();
		expect(state.backfillStatus).toBe("in_progress");
	});

	test("resyncLogsRange manually backfills specific date/time slice", async () => {
		const mockLogs = [
			{
				id: "log_resync_1",
				timestamp: 1700000050,
				details: {
					id: 4810,
					title: "Money receive",
					category: "Money sending",
				},
				data: {},
				params: {},
			},
		];

		let callCount = 0;
		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation(
			// biome-ignore lint/suspicious/noExplicitAny: mock return
			(async (path: string, _options?: any) => {
				if (path === "/user/log") {
					callCount++;
					if (callCount === 1) {
						return {
							log: mockLogs,
							_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
						};
					}
					return {
						log: [],
						_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
					};
				}
				return {
					log: [],
					_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
				};
			}) as unknown as typeof tornApi.getPersonal,
		);

		const res = await resyncLogsRange(1700000000, 1700000100);
		expect(res.fetched).toBe(1);
		expect(res.newLogs).toBe(1);

		const saved = await db.query.personalLogs.findFirst({
			where: eq(personalLogs.id, "log_resync_1"),
		});
		expect(saved).toBeDefined();
		expect(saved?.title).toBe("Money receive");
	});

	test("resyncLogsRange exhaustively paginates across multiple pages", async () => {
		const page1Logs = Array.from({ length: 100 }, (_, i) => ({
			id: `log_page1_${i}`,
			timestamp: 1700000000 + 500 - i * 2, // 1700000500 down to 1700000302
			details: { id: 4810, title: `Page1 Log ${i}`, category: "General" },
			data: {},
			params: {},
		}));

		const page2Logs = [
			{
				id: "log_page2_0",
				timestamp: 1700000100,
				details: { id: 4810, title: "Page2 Log 0", category: "General" },
				data: {},
				params: {},
			},
		];

		const calledToParams: number[] = [];

		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation(
			// biome-ignore lint/suspicious/noExplicitAny: mock return
			(async (path: string, options?: any) => {
				if (path === "/user/log") {
					const to = options?.queryParams?.to;
					calledToParams.push(to);
					if (calledToParams.length === 1) {
						return {
							log: page1Logs,
							_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
						};
					}
					if (calledToParams.length === 2) {
						return {
							log: page2Logs,
							_metadata: { links: { prev: null, next: null }, nanostamp: "2" },
						};
					}
					return {
						log: [],
						_metadata: { links: { prev: null, next: null }, nanostamp: "3" },
					};
				}
				return { log: [] };
			}) as unknown as typeof tornApi.getPersonal,
		);

		const res = await resyncLogsRange(1700000000, 1700000500);
		expect(res.fetched).toBe(101);
		expect(res.newLogs).toBe(101);
		expect(calledToParams.length).toBe(2);
		expect(calledToParams[0]).toBe(1700000501);
		expect(calledToParams[1]).toBe(1700000302);
	});

	test("continues backfill past start of year until reaching end of log history", async () => {
		const currentYear = new Date().getUTCFullYear();
		const startOfYearSec = Math.floor(Date.UTC(currentYear, 0, 1) / 1000);
		await seedCursors(startOfYearSec, startOfYearSec);

		const oldLog = {
			id: "log_past_year",
			timestamp: startOfYearSec - 100000,
			details: { id: 9010, title: "Old crime", category: "Crimes" },
			data: {},
			params: {},
		};

		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation(
			(async () => {
				return {
					log: [oldLog],
					_metadata: { links: { prev: null, next: null }, nanostamp: "1" },
				};
			}) as unknown as typeof tornApi.getPersonal,
		);

		const res = await syncHistoricalBackfill(1);
		expect(res.fetched).toBe(1);
		expect(res.completed).toBe(false);

		const state = getLogManagerState();
		expect(state.backfillStatus).toBe("in_progress");
		expect(state.oldestTimestampReached).toBe(startOfYearSec - 100000);
	});

	test("resetLogManagerState resets backfill cursor to null (now) while preserving DB records", async () => {
		await seedCursors(1600000000, 1700000000);
		const state = getLogManagerState();
		expect(state.oldestTimestampReached).toBe(1600000000);

		const resetState = await resetLogManagerState();
		expect(resetState.backfillStatus).toBe("in_progress");
		expect(resetState.oldestTimestampReached).toBeNull();
		expect(resetState.newestTimestampReached).toBe(1700000000);
	});
});
