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
	inArray,
	personalLogs,
	systemStates,
	tornGyms,
} from "@sentinel/database";
import { tornApi } from "@sentinel/torn-api";
import { schedulerEvents } from "../src/lib/events";
import {
	calculateTravelTimeSeconds,
	parseBoosterPerkModifiers,
	parseGymPerkModifiers,
	parseTravelPerkModifiers,
	runPersonalReferenceSync,
	startPersonalReferenceSync,
	syncGymUnlocks,
} from "../src/workers/personal/references";

describe("Personal Reference Sync Worker & Parsers", () => {
	let getPersonalSpy: ReturnType<typeof spyOn>;
	const TEST_KEY_ID = "test_personal_reference_sync_key";
	const PERKS_STATE_ID = "personal:user_perks";
	const GYM_UNLOCKS_STATE_ID = "personal:gym_unlocks";
	const LOG_MANAGER_STATE_ID = "personal:log_manager";
	const TEST_LOG_IDS = ["test_ref_log_1", "test_ref_log_2"];
	const TEST_GYM_IDS = ["1", "2", "3"];
	const originalEnvKey = process.env.TORN_API_KEY;

	let savedPerksState: typeof systemStates.$inferSelect | undefined;
	let savedGymState: typeof systemStates.$inferSelect | undefined;
	let savedLogManagerState: typeof systemStates.$inferSelect | undefined;

	beforeAll(async () => {
		savedPerksState = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, PERKS_STATE_ID),
		});
		savedGymState = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, GYM_UNLOCKS_STATE_ID),
		});
		savedLogManagerState = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, LOG_MANAGER_STATE_ID),
		});
	});

	afterAll(async () => {
		if (savedPerksState) {
			await db
				.insert(systemStates)
				.values(savedPerksState)
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						init: savedPerksState.init,
						data: savedPerksState.data,
						updatedAt: savedPerksState.updatedAt,
					},
				});
		}
		if (savedGymState) {
			await db
				.insert(systemStates)
				.values(savedGymState)
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						init: savedGymState.init,
						data: savedGymState.data,
						updatedAt: savedGymState.updatedAt,
					},
				});
		}
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
		}
	});

	beforeEach(async () => {
		// Clean up only test fixtures
		await db.delete(systemStates).where(eq(systemStates.id, PERKS_STATE_ID));
		await db
			.delete(systemStates)
			.where(eq(systemStates.id, GYM_UNLOCKS_STATE_ID));
		await db
			.delete(systemStates)
			.where(eq(systemStates.id, LOG_MANAGER_STATE_ID));
		await db.delete(apiKeys).where(eq(apiKeys.id, TEST_KEY_ID));
		await db.delete(personalLogs).where(inArray(personalLogs.id, TEST_LOG_IDS));
		await db.delete(tornGyms).where(inArray(tornGyms.id, TEST_GYM_IDS));

		// Insert personal API key fixture
		await db.insert(apiKeys).values({
			id: TEST_KEY_ID,
			userId: 88888,
			keyType: "personal",
			apiKeyEncrypted: "test_personal_key_ref_sync_123",
			apiKeyHash: "hash_personal_key_ref_sync_123",
			isValid: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
	});

	afterEach(async () => {
		process.env.TORN_API_KEY = originalEnvKey;
		if (getPersonalSpy) {
			getPersonalSpy.mockRestore();
		}
		schedulerEvents.removeAllListeners();
		await db.delete(systemStates).where(eq(systemStates.id, PERKS_STATE_ID));
		await db
			.delete(systemStates)
			.where(eq(systemStates.id, GYM_UNLOCKS_STATE_ID));
		await db
			.delete(systemStates)
			.where(eq(systemStates.id, LOG_MANAGER_STATE_ID));
		await db.delete(apiKeys).where(eq(apiKeys.id, TEST_KEY_ID));
		await db.delete(personalLogs).where(inArray(personalLogs.id, TEST_LOG_IDS));
		await db.delete(tornGyms).where(inArray(tornGyms.id, TEST_GYM_IDS));
	});

	describe("Perk Parsers", () => {
		test("parseGymPerkModifiers correctly computes stat-specific and generic multipliers", () => {
			const rawPerks = [
				"+ 10% Strength gym gains",
				"+ 5% speed gym gains",
				"+ 2.5% Defense gym gains",
				"+ 8% Dexterity gym gains",
				"+ 1% gym gains",
			];

			const modifiers = parseGymPerkModifiers(rawPerks);
			expect(modifiers.strength).toBeCloseTo(1.1 * 1.01, 4);
			expect(modifiers.speed).toBeCloseTo(1.05 * 1.01, 4);
			expect(modifiers.defense).toBeCloseTo(1.025 * 1.01, 4);
			expect(modifiers.dexterity).toBeCloseTo(1.08 * 1.01, 4);
		});

		test("parseBoosterPerkModifiers parses energy drink bonuses", () => {
			const perks = [
				"+ 50% energy gain from energy drinks",
				"+ 10% energy gain from energy drinks",
				"Unrelated perk",
			];

			const modifiers = parseBoosterPerkModifiers(perks);
			expect(modifiers.energyDrink).toBeCloseTo(1.6, 4);
		});

		test("parseTravelPerkModifiers extracts travel facilities and reductions", () => {
			const perks = [
				"Property has an Airstrip",
				"WLT Stock Benefit (Westside Travel)",
				"Book: Mailing Yourself Abroad",
				"- 10% travel time",
				"- 15% travel time",
			];

			const modifiers = parseTravelPerkModifiers(perks);
			expect(modifiers.hasAirstrip).toBe(true);
			expect(modifiers.hasWltBenefit).toBe(true);
			expect(modifiers.hasBookPerk).toBe(true);
			expect(modifiers.factionTravelReduction).toBeCloseTo(0.25, 4);
			expect(modifiers.totalTravelReduction).toBeCloseTo(0.5, 4); // 0.25 faction + 0.25 book
		});

		test("calculateTravelTimeSeconds computes accurate flight durations", () => {
			// Mexico standardSeconds = 1440
			const standardTime = calculateTravelTimeSeconds(1, "standard");
			expect(standardTime).toBe(1440);

			const airstripTime = calculateTravelTimeSeconds(1, "airstrip");
			expect(airstripTime).toBe(1008); // 1440 * 0.7

			const wltTime = calculateTravelTimeSeconds(1, "wlt");
			expect(wltTime).toBe(720); // 1440 * 0.5

			const businessTime = calculateTravelTimeSeconds(1, "business");
			expect(businessTime).toBe(432); // 1440 * 0.3

			const perks = {
				hasAirstrip: true,
				hasWltBenefit: false,
				hasBookPerk: true,
				factionTravelReduction: 0.1,
				totalTravelReduction: 0.35,
			};

			// Airstrip with Book (0.75x) and 10% Faction Reduction (0.9x)
			// 1440 * 0.7 * 0.75 * 0.9 = 680.4 -> 680
			const discountedTime = calculateTravelTimeSeconds(1, "airstrip", perks);
			expect(discountedTime).toBe(680);
		});
	});

	describe("syncGymUnlocks", () => {
		test("skips gym sync if log backfill is still in progress", async () => {
			await db.insert(systemStates).values({
				id: LOG_MANAGER_STATE_ID,
				init: false,
				data: { backfillStatus: "in_progress" },
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			await syncGymUnlocks();

			const gymState = await db.query.systemStates.findFirst({
				where: eq(systemStates.id, GYM_UNLOCKS_STATE_ID),
			});
			expect(gymState).toBeUndefined();
		});

		test("syncs gym unlocks and determines optimal stat gyms from log history", async () => {
			// Backfill is completed
			await db.insert(systemStates).values({
				id: LOG_MANAGER_STATE_ID,
				init: true,
				data: { backfillStatus: "completed" },
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			// Seed gyms
			await db.insert(tornGyms).values([
				{
					id: "1",
					name: "Premier Fitness",
					stage: 1,
					cost: 0,
					energy: 5,
					strength: 2.0,
					speed: 2.0,
					defense: 2.0,
					dexterity: 2.0,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				{
					id: "2",
					name: "Average Joes",
					stage: 1,
					cost: 10,
					energy: 5,
					strength: 3.5,
					speed: 2.5,
					defense: 2.0,
					dexterity: 1.8,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				{
					id: "3",
					name: "Woody's Workout",
					stage: 1,
					cost: 20,
					energy: 5,
					strength: 1.5,
					speed: 4.0,
					defense: 3.8,
					dexterity: 4.5,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			]);

			// Seed log 5320 unlocking gym 2 and gym 3
			await db.insert(personalLogs).values([
				{
					id: "test_ref_log_1",
					log: 5320,
					title: "Unlocked Gym 2",
					timestamp: new Date(),
					data: { gym: 2 },
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				{
					id: "test_ref_log_2",
					log: 5320,
					title: "Unlocked Gym 3",
					timestamp: new Date(),
					data: { data: { gym: 3 } },
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			]);

			await syncGymUnlocks();

			const gymState = await db.query.systemStates.findFirst({
				where: eq(systemStates.id, GYM_UNLOCKS_STATE_ID),
			});

			expect(gymState).toBeDefined();
			const data = gymState?.data as {
				strengthGym: number;
				defenseGym: number;
				speedGym: number;
				dexterityGym: number;
				unlockedGymIds: number[];
			};
			expect(data.strengthGym).toBeGreaterThanOrEqual(2);
			expect(data.speedGym).toBeGreaterThanOrEqual(3);
			expect(data.defenseGym).toBeGreaterThanOrEqual(3);
			expect(data.dexterityGym).toBeGreaterThanOrEqual(3);
			expect(data.unlockedGymIds).toContain(1);
			expect(data.unlockedGymIds).toContain(2);
			expect(data.unlockedGymIds).toContain(3);
		});
	});

	describe("runPersonalReferenceSync & Worker Events", () => {
		test("fetches raw perks from Torn API and saves user_perks state to database", async () => {
			const mockPerksResponse = {
				faction_perks: ["- 10% travel time", "+ 5% Strength gym gains"],
				job_perks: ["+ 10% energy gain from energy drinks"],
				property_perks: ["Property has an Airstrip"],
				education_perks: [],
				enhancer_perks: [],
				book_perks: ["Book: Mailing Yourself Abroad"],
				stock_perks: ["WLT Stock Benefit (Westside Travel)"],
				merit_perks: ["+ 3% gym gains"],
			};

			getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation((async (
				path: string,
				options?: unknown,
			) => {
				expect(path).toBe("/user");
				const opts = options as { queryParams?: { selections?: string[] } };
				expect(opts?.queryParams?.selections).toEqual(["perks"]);
				return mockPerksResponse;
			}) as unknown as typeof tornApi.getPersonal);

			// Mark backfill completed so gym unlock sync succeeds
			await db.insert(systemStates).values({
				id: LOG_MANAGER_STATE_ID,
				init: true,
				data: { backfillStatus: "completed" },
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			const nextRun = await runPersonalReferenceSync();
			expect(typeof nextRun).toBe("number");
			expect(nextRun).toBeGreaterThan(Date.now());

			const perksRecord = await db.query.systemStates.findFirst({
				where: eq(systemStates.id, PERKS_STATE_ID),
			});

			expect(perksRecord).toBeDefined();
			const data = perksRecord?.data as {
				allPerks: string[];
				travelPerks: {
					hasAirstrip: boolean;
					hasWltBenefit: boolean;
					hasBookPerk: boolean;
				};
			};
			expect(data.allPerks.length).toBe(7);
			expect(data.travelPerks.hasAirstrip).toBe(true);
			expect(data.travelPerks.hasWltBenefit).toBe(true);
			expect(data.travelPerks.hasBookPerk).toBe(true);
		});

		test("schedulerEvents log_backfill_completed triggers syncGymUnlocks", async () => {
			// Register worker event listener
			startPersonalReferenceSync({ initialDelayMs: 999999 });

			// Set backfill as completed
			await db.insert(systemStates).values({
				id: LOG_MANAGER_STATE_ID,
				init: true,
				data: { backfillStatus: "completed" },
				createdAt: new Date(),
				updatedAt: new Date(),
			});

			// Seed gym 1
			await db.insert(tornGyms).values([
				{
					id: "1",
					name: "Premier Fitness",
					stage: 1,
					cost: 0,
					energy: 5,
					strength: 2.0,
					speed: 2.0,
					defense: 2.0,
					dexterity: 2.0,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			]);

			// Trigger backfill completed event
			schedulerEvents.emit("log_backfill_completed");

			// Wait for asynchronous execution
			let gymState: typeof systemStates.$inferSelect | undefined;
			for (let i = 0; i < 30; i++) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				gymState = await db.query.systemStates.findFirst({
					where: eq(systemStates.id, GYM_UNLOCKS_STATE_ID),
				});
				if (gymState) break;
			}

			expect(gymState).toBeDefined();
		});
	});
});
