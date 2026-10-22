import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
	apiKeys,
	db,
	eq,
	loadPersonalLiveState,
	personalLiveBars,
	type PersonalLiveStateData,
	personalLiveStates,
	savePersonalLiveState,
} from "@sentinel/database";
import { tornApi } from "@sentinel/torn-api";

import {
	getPersonalLiveState,
	loadPersonalLiveStateFromDb,
	resetPersonalLiveState,
	runPersonalStateSync,
} from "../src/workers/personal/states";

describe("Personal State Sync Worker", () => {
	/** Live state is now a typed singleton plus one row per bar. */
	async function clearLiveStateTables(): Promise<void> {
		await db.delete(personalLiveBars);
		await db.delete(personalLiveStates);
	}

	let getPersonalSpy: ReturnType<typeof spyOn>;
	const TEST_KEY_ID = "test_personal_state_sync_key";
	const originalEnvKey = process.env.TORN_API_KEY;

	beforeEach(async () => {
		// Clean up fixtures
		await clearLiveStateTables();
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
		await clearLiveStateTables();
		await db.delete(apiKeys).where(eq(apiKeys.id, TEST_KEY_ID));
	});

	test("initializes default state and can load from DB if record exists", async () => {
		const defaultState = getPersonalLiveState();
		expect(defaultState.bars.energy.current).toBe(0);
		expect(defaultState.cooldowns.drug).toBe(0);
		expect(defaultState.battlestats.strength).toBe(0);

		// Seed the snapshot the way the worker writes it.
		await savePersonalLiveState({
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
					current: 3000,
					maximum: 4000,
					increment: 5,
					interval: 300,
					fullTime: 0,
				},
				life: {
					current: 2500,
					maximum: 2500,
					increment: 10,
					interval: 300,
					fullTime: 0,
				},
			},
			cooldowns: { drug: 120, medical: 0, booster: 0 },
			money: { wallet: 1000 },
			battlestats: {
				strength: 50000,
				defense: 40000,
				speed: 30000,
				dexterity: 20000,
			},
			lastSyncDurationMs: 45,
		} satisfies PersonalLiveStateData);

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

		// Verify persistence through the typed tables, not a blob.
		const persisted = await loadPersonalLiveState();
		expect(persisted).not.toBeNull();
		expect(persisted?.bars.energy.current).toBe(150);
		expect(persisted?.cooldowns.medical).toBe(300);
		expect(persisted?.battlestats.total).toBe(4580000);
	});

	test("handles missing personal key gracefully without throwing", async () => {
		delete process.env.TORN_API_KEY;
		await db.delete(apiKeys).where(eq(apiKeys.id, TEST_KEY_ID));

		await expect(runPersonalStateSync()).resolves.toBeUndefined();
	});

	test("surfaces API errors to the runner instead of reporting a false success", async () => {
		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation(
			(async () => {
				throw new Error("Network timeout or connection reset");
			}) as unknown as typeof tornApi.getPersonal,
		);

		// The cycle must reject so `ScheduledRunner` records the failure, applies
		// its backoff and reports `degraded` on /health. Previously the error was
		// swallowed inside the handler, so this worker reported success on every
		// cycle while never actually syncing.
		//
		// "Graceful" is now the runner's job: it catches this rejection, so the
		// process still does not crash — that containment is covered by the
		// scheduler runner's own tests.
		await expect(runPersonalStateSync()).rejects.toThrow(
			"Network timeout or connection reset",
		);
	});
});
