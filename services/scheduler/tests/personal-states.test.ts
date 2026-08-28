import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { apiKeys, db, eq, systemStates } from "@sentinel/database";
import { tornApi } from "@sentinel/torn-api";
import {
	getPersonalLiveState,
	loadPersonalLiveStateFromDb,
	resetPersonalLiveState,
	runPersonalStateSync,
} from "../src/workers/personal/states";

describe("Personal State Sync Worker", () => {
	let getPersonalSpy: ReturnType<typeof spyOn>;
	const TEST_STATE_ID = "personal:live_state";
	const TEST_KEY_ID = "test_personal_state_sync_key";
	const originalEnvKey = process.env.TORN_API_KEY;

	beforeEach(async () => {
		// Clean up fixtures
		await db.delete(systemStates).where(eq(systemStates.id, TEST_STATE_ID));
		await db.delete(apiKeys).where(eq(apiKeys.id, TEST_KEY_ID));

		// Insert personal API key fixture
		await db.insert(apiKeys).values({
			id: TEST_KEY_ID,
			userId: 99999,
			keyType: "personal",
			apiKeyEncrypted: "test_personal_key_state_sync_123",
			apiKeyHash: "hash_personal_key_state_sync_123",
			isValid: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		resetPersonalLiveState();
	});

	afterEach(async () => {
		process.env.TORN_API_KEY = originalEnvKey;
		if (getPersonalSpy) {
			getPersonalSpy.mockRestore();
		}
		await db.delete(systemStates).where(eq(systemStates.id, TEST_STATE_ID));
		await db.delete(apiKeys).where(eq(apiKeys.id, TEST_KEY_ID));
	});

	test("initializes default state and can load from DB if record exists", async () => {
		const defaultState = getPersonalLiveState();
		expect(defaultState.bars.energy.current).toBe(0);
		expect(defaultState.cooldowns.drug).toBe(0);
		expect(defaultState.battlestats.strength).toBe(0);

		// Seed a database record
		await db.insert(systemStates).values({
			id: TEST_STATE_ID,
			init: true,
			data: {
				bars: {
					energy: {
						current: 100,
						maximum: 100,
						increment: 5,
						interval: 300,
						fullTime: 0,
					},
					nerve: {
						current: 30,
						maximum: 30,
						increment: 1,
						interval: 300,
						fullTime: 0,
					},
					happy: {
						current: 5000,
						maximum: 5000,
						increment: 5,
						interval: 300,
						fullTime: 0,
					},
					life: {
						current: 1500,
						maximum: 1500,
						increment: 10,
						interval: 300,
						fullTime: 0,
					},
				},
				cooldowns: { drug: 120, medical: 0, booster: 0 },
				money: { points: 500, wallet: 1000000 },
				battlestats: {
					strength: 50000,
					defense: 40000,
					speed: 60000,
					dexterity: 30000,
					total: 180000,
				},
				lastSyncDurationMs: 45,
				updatedAt: new Date().toISOString(),
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const loaded = await loadPersonalLiveStateFromDb();
		expect(loaded.bars.energy.current).toBe(100);
		expect(loaded.cooldowns.drug).toBe(120);
		expect(loaded.battlestats.strength).toBe(50000);
	});

	test("executes single-request live state sync and persists to SQLite", async () => {
		const mockResponse = {
			bars: {
				energy: {
					current: 150,
					maximum: 150,
					increment: 5,
					interval: 300,
					full_time: 0,
				},
				nerve: {
					current: 45,
					maximum: 45,
					increment: 1,
					interval: 300,
					full_time: 0,
				},
				happy: {
					current: 4200,
					maximum: 5000,
					increment: 5,
					interval: 300,
					full_time: 1200,
				},
				life: {
					current: 2500,
					maximum: 2500,
					increment: 10,
					interval: 300,
					full_time: 0,
				},
			},
			cooldowns: {
				drug: 0,
				medical: 300,
				booster: 0,
			},
			money: {
				points: 1200,
				wallet: 5400000,
				vault: 25000000,
				daily_networth: 500000000,
			},
			battlestats: {
				strength: { value: 1250000 },
				defense: { value: 980000 },
				speed: { value: 1500000 },
				dexterity: { value: 850000 },
				total: 4580000,
			},
		};

		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation((async (
			path: string,
			options?: unknown,
		) => {
			expect(path).toBe("/user");
			const opts = options as { queryParams?: { selections?: string[] } };
			expect(opts?.queryParams?.selections).toEqual([
				"bars",
				"cooldowns",
				"money",
				"battlestats",
			]);
			return mockResponse;
		}) as unknown as typeof tornApi.getPersonal);

		await runPersonalStateSync();

		const state = getPersonalLiveState();
		expect(state.bars.energy.current).toBe(150);
		expect(state.bars.happy.fullTime).toBe(1200);
		expect(state.cooldowns.medical).toBe(300);
		expect(state.battlestats.strength).toBe(1250000);
		expect(state.battlestats.total).toBe(4580000);

		// Verify database persistence
		const dbRecord = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, TEST_STATE_ID),
		});
		expect(dbRecord).toBeDefined();
		expect(dbRecord?.init).toBe(true);
		const data = dbRecord?.data as Record<string, unknown>;
		expect(data).toBeDefined();
	});

	test("handles missing personal key gracefully without throwing", async () => {
		delete process.env.TORN_API_KEY;
		await db.delete(apiKeys).where(eq(apiKeys.id, TEST_KEY_ID));

		await expect(runPersonalStateSync()).resolves.toBeUndefined();
	});

	test("handles API errors gracefully without crashing", async () => {
		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation(
			(async () => {
				throw new Error("Network timeout or connection reset");
			}) as unknown as typeof tornApi.getPersonal,
		);

		await expect(runPersonalStateSync()).resolves.toBeUndefined();
	});
});
