import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as ffscouterModule from "@sentinel/torn-api";
import * as managerModule from "@sentinel/torn-api";
import {
	computeAdaptivePageBudget,
	getCurrentSweepId,
	getDynamicFloorPageCount,
	getInMemoryBountyState,
	resetBountyFinderCooldown,
	resetBountyFinderState,
	runBountyFinderCycle,
	setDynamicFloorPageCount,
} from "../src/workers/subversive/bounty-finder";
import * as keyPoolModule from "../src/workers/subversive/subversive-key-pool";

describe("Personal Bounty Target Finder Worker", () => {
	let getPersonalKeySpy: ReturnType<typeof spyOn>;
	let tornApiGetSpy: ReturnType<typeof spyOn>;
	let getPlayerStatsSpy: ReturnType<typeof spyOn>;
	let getNextSubversiveUserKeySpy: ReturnType<typeof spyOn>;
	let hasActiveSubversiveKeysSpy: ReturnType<typeof spyOn>;
	let getSubversiveUserKeysSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		resetBountyFinderState();
		getPersonalKeySpy = spyOn(
			managerModule,
			"getPersonalKey",
		).mockResolvedValue({
			apiKey: "mock_personal_api_key_16char",
			userId: 999999,
			keyType: "personal",
		});

		getNextSubversiveUserKeySpy = spyOn(
			keyPoolModule,
			"getNextSubversiveUserKey",
		).mockImplementation(async () => ({
			apiKey: "mock_subversive_key_16ch",
			userId: 888888,
			keyType: "custom",
		}));

		hasActiveSubversiveKeysSpy = spyOn(
			keyPoolModule,
			"hasActiveSubversiveKeys",
		).mockImplementation(async () => true);

		getSubversiveUserKeysSpy = spyOn(
			keyPoolModule,
			"getSubversiveUserKeys",
		).mockImplementation(async () => [
			{
				apiKey: "mock_subversive_key_16ch",
				userId: 888888,
				keyType: "custom",
			},
		]);

		getPlayerStatsSpy = spyOn(
			ffscouterModule,
			"getPlayerStats",
		).mockResolvedValue([
			{
				player_id: 101, // Scouted: FF ~ 1.5 (Keep)
				fair_fight: 1.5,
				bs_estimate: 50_000,
				bs_estimate_human: "50k",
				bss_public: null,
				last_updated: Math.floor(Date.now() / 1000),
				source: "bss",
				premium_insights_available: false,
				distribution: null,
				spies: [],
				available_estimates: { bss: null, premium: null, spies: null },
			},
			{
				player_id: 102, // Scouted: FF ~ 4.5 (Discard > 4.0)
				fair_fight: 4.5,
				bs_estimate: 20_000_000,
				bs_estimate_human: "20m",
				bss_public: null,
				last_updated: Math.floor(Date.now() / 1000),
				source: "bss",
				premium_insights_available: false,
				distribution: null,
				spies: [],
				available_estimates: { bss: null, premium: null, spies: null },
			},
			// Target 103 is unscouted, level 10 (Keep)
			// Target 104 is unscouted, level 45 (Discard)
			// Target 105 is under 14 days old (Discard)
			// Target 106 is in hospital (Put in hospital queue)
		]);

		tornApiGetSpy = spyOn(managerModule.tornApi, "get").mockImplementation(
			(async (path: string, options: unknown) => {
				if (path === "/torn/bounties") {
					return {
						bounties: [
							{
								target_id: 101,
								target_name: "TargetOkayScouted",
								target_level: 25,
								reward: 500_000,
								quantity: 1,
								is_anonymous: false,
								valid_until: Math.floor(Date.now() / 1000) + 86400,
								lister_id: 1,
								lister_name: "Lister",
								reason: null,
							},
							{
								target_id: 102,
								target_name: "TargetHighFF",
								target_level: 60,
								reward: 1_000_000,
								quantity: 1,
								is_anonymous: false,
								valid_until: Math.floor(Date.now() / 1000) + 86400,
								lister_id: 1,
								lister_name: "Lister",
								reason: null,
							},
							{
								target_id: 103,
								target_name: "TargetLowLevelUnscouted",
								target_level: 10,
								reward: 200_000,
								quantity: 1,
								is_anonymous: false,
								valid_until: Math.floor(Date.now() / 1000) + 86400,
								lister_id: 1,
								lister_name: "Lister",
								reason: null,
							},
							{
								target_id: 104,
								target_name: "TargetHighLevelUnscouted",
								target_level: 45,
								reward: 750_000,
								quantity: 1,
								is_anonymous: false,
								valid_until: Math.floor(Date.now() / 1000) + 86400,
								lister_id: 1,
								lister_name: "Lister",
								reason: null,
							},
							{
								target_id: 105,
								target_name: "TargetTooYoung",
								target_level: 8,
								reward: 300_000,
								quantity: 1,
								is_anonymous: false,
								valid_until: Math.floor(Date.now() / 1000) + 86400,
								lister_id: 1,
								lister_name: "Lister",
								reason: null,
							},
							{
								target_id: 106,
								target_name: "TargetInHospital",
								target_level: 14,
								reward: 400_000,
								quantity: 1,
								is_anonymous: false,
								valid_until: Math.floor(Date.now() / 1000) + 86400,
								lister_id: 1,
								lister_name: "Lister",
								reason: null,
							},
							{
								target_id: 999,
								target_name: "TargetTinyReward",
								target_level: 5,
								reward: 10_000, // < 100k pre-filter
								quantity: 1,
								is_anonymous: false,
								valid_until: Math.floor(Date.now() / 1000) + 86400,
								lister_id: 1,
								lister_name: "Lister",
								reason: null,
							},
						],
						bounties_timestamp: Math.floor(Date.now() / 1000),
						bounties_delay: 30,
						_metadata: { links: { next: null, prev: null }, total: 7 },
					} as unknown as ReturnType<typeof managerModule.tornApi.get>;
				}

				if (path === "/user/{id}/profile") {
					const opt = options as { pathParams: { id: number } };
					const id = opt.pathParams.id;

					if (id === 101) {
						return {
							profile: {
								id: 101,
								name: "TargetOkayScouted",
								level: 25,
								age: 150, // >= 14d
								status: { state: "Okay" },
							},
						} as unknown as ReturnType<typeof managerModule.tornApi.get>;
					}

					if (id === 103) {
						return {
							profile: {
								id: 103,
								name: "TargetLowLevelUnscouted",
								level: 10,
								age: 50, // >= 14d
								status: { state: "Okay" },
							},
						} as unknown as ReturnType<typeof managerModule.tornApi.get>;
					}

					if (id === 105) {
						return {
							profile: {
								id: 105,
								name: "TargetTooYoung",
								level: 8,
								age: 5, // < 14d -> MUST BE DISCARDED!
								status: { state: "Okay" },
							},
						} as unknown as ReturnType<typeof managerModule.tornApi.get>;
					}

					if (id === 106) {
						return {
							profile: {
								id: 106,
								name: "TargetInHospital",
								level: 20,
								age: 200, // >= 14d
								status: {
									state: "Hospital",
									until: Math.floor(Date.now() / 1000) + 300,
								},
							},
						} as unknown as ReturnType<typeof managerModule.tornApi.get>;
					}
				}

				return {} as unknown as ReturnType<typeof managerModule.tornApi.get>;
			}) as unknown as typeof managerModule.tornApi.get,
		);
	});

	afterEach(() => {
		getPersonalKeySpy.mockRestore();
		tornApiGetSpy.mockRestore();
		getPlayerStatsSpy.mockRestore();
		getNextSubversiveUserKeySpy.mockRestore();
		hasActiveSubversiveKeysSpy.mockRestore();
		getSubversiveUserKeysSpy.mockRestore();
	});

	it("executes bounty finder cycle, filtering by FF, age, reward, and tracking hospital", async () => {
		await runBountyFinderCycle();

		const data = getInMemoryBountyState();

		// Target 101 (FF 1.5, age 150) -> in readyTargets
		// Target 103 (unscouted lvl 10, age 50) -> in readyTargets
		// Target 102 (FF 3.5) -> discarded (too strong)
		// Target 104 (unscouted lvl 45) -> discarded (unscouted high level)
		// Target 105 (age 5 < 14d) -> discarded (under 14 days old)
		// Target 999 (reward 10k < 100k) -> discarded (reward below 100k prefilter)
		const readyIds = data.readyTargets.map((t) => t.id);
		expect(readyIds).toContain(101);
		expect(readyIds).toContain(103);
		expect(readyIds).not.toContain(102);
		expect(readyIds).not.toContain(104);
		expect(readyIds).not.toContain(105);
		expect(readyIds).not.toContain(999);

		// Target 106 (in hospital) -> in hospitalQueue
		const hospIds = data.hospitalQueue.map((t) => t.id);
		expect(hospIds).toContain(106);

		// Verify zero calls to /user/battlestats
		expect(tornApiGetSpy).not.toHaveBeenCalledWith(
			"/user/battlestats",
			expect.anything(),
		);
	});

	it("prioritizes uninspected candidates by reward and never includes unprofiled candidates in readyTargets", async () => {
		// Mock 25 low-level unscouted bounties with distinct IDs and rewards
		const mockBounties = Array.from({ length: 25 }, (_, i) => ({
			target_id: 2000 + i,
			target_name: `Target_${2000 + i}`,
			target_level: 10, // low level unscouted -> qualifies
			reward: 100_000 + i * 10_000, // 2024 has the highest reward, 2000 has the lowest
			quantity: 1,
			is_anonymous: false,
			valid_until: Math.floor(Date.now() / 1000) + 86400,
			lister_id: 1,
			lister_name: "Lister",
			reason: null,
		}));

		getPlayerStatsSpy.mockResolvedValue([]); // Unscouted

		tornApiGetSpy.mockImplementation((async (
			path: string,
			options: unknown,
		) => {
			if (path === "/torn/bounties") {
				return {
					bounties: mockBounties,
					bounties_timestamp: Math.floor(Date.now() / 1000),
					bounties_delay: 30,
					_metadata: { links: { next: null, prev: null }, total: 25 },
				} as unknown as ReturnType<typeof managerModule.tornApi.get>;
			}

			if (path === "/user/{id}/profile") {
				const opt = options as { pathParams: { id: number } };
				return {
					profile: {
						id: opt.pathParams.id,
						name: `Target_${opt.pathParams.id}`,
						level: 10,
						age: 100, // >= 14d
						status: { state: "Okay" },
					},
				} as unknown as ReturnType<typeof managerModule.tornApi.get>;
			}

			return {} as unknown as ReturnType<typeof managerModule.tornApi.get>;
		}) as unknown as typeof managerModule.tornApi.get);

		await runBountyFinderCycle();

		const data = getInMemoryBountyState();

		// Exactly 10 should have been profiled and placed in readyTargets (10 * 1 key)
		expect(data.readyTargets.length).toBe(10);
		expect(data.pendingCount).toBe(15);

		// Highest reward candidates (IDs 2015 to 2024) must be in readyTargets
		const readyIds = data.readyTargets.map((t) => t.id);
		expect(readyIds).toContain(2024); // Highest reward (340k)
		expect(readyIds).toContain(2015);

		// Lower reward candidates (IDs 2000 to 2014) must NOT be in readyTargets
		expect(readyIds).not.toContain(2000);
		expect(readyIds).not.toContain(2005);
		expect(readyIds).not.toContain(2014);
	});

	it("skips execution if invoked within the minimum cooldown period", async () => {
		setDynamicFloorPageCount(1);
		tornApiGetSpy.mockResolvedValue({
			bounties: [],
			_metadata: { total: 0 },
		} as unknown as ReturnType<typeof managerModule.tornApi.get>);

		// First cycle runs
		await runBountyFinderCycle();
		expect(tornApiGetSpy).toHaveBeenCalledTimes(1);

		// Immediate second cycle should be skipped due to cooldown
		await runBountyFinderCycle();
		expect(tornApiGetSpy).toHaveBeenCalledTimes(1);

		// Second cycle with force=true should run
		await runBountyFinderCycle(true);
		expect(tornApiGetSpy).toHaveBeenCalledTimes(2);
	});

	it("computeAdaptivePageBudget dynamically scales page budget based on queue backlog", () => {
		// Empty queue / low backlog: ramp up to 5 pages
		expect(computeAdaptivePageBudget(0)).toBe(5);
		expect(computeAdaptivePageBudget(5)).toBe(5);
		expect(computeAdaptivePageBudget(14)).toBe(5);

		// Balanced backlog: 3 pages
		expect(computeAdaptivePageBudget(15)).toBe(3);
		expect(computeAdaptivePageBudget(25)).toBe(3);
		expect(computeAdaptivePageBudget(39)).toBe(3);

		// High backlog: ramp down to 1 page
		expect(computeAdaptivePageBudget(40)).toBe(1);
		expect(computeAdaptivePageBudget(80)).toBe(1);
	});

	it("fetches bounty pages in parallel up to dynamic floor and dynamically adjusts floor in memory", async () => {
		getPlayerStatsSpy.mockResolvedValue([]); // Unscouted

		// Setup mock bounties:
		// Page 0 (offset 0): 100 bounties @ 500k
		// Page 1 (offset 100): 100 bounties @ 400k
		// Page 2 (offset 200): 50 bounties @ 200k, 50 bounties @ 50k (< 100k floor hit!)
		// Page 3 (offset 300): 100 bounties @ 40k
		// Page 4 (offset 400): 100 bounties @ 30k
		tornApiGetSpy.mockImplementation((async (
			path: string,
			options: unknown,
		) => {
			if (path === "/torn/bounties") {
				const opt = options as {
					queryParams: { limit: number; offset: number };
				};
				const offset = opt.queryParams.offset;

				if (offset === 0) {
					return {
						bounties: Array.from({ length: 100 }, (_, i) => ({
							target_id: 3000 + i,
							target_name: `Target_${3000 + i}`,
							target_level: 10,
							reward: 500_000,
							quantity: 1,
							is_anonymous: false,
							valid_until: Math.floor(Date.now() / 1000) + 86400,
							lister_id: 1,
							lister_name: "Lister",
							reason: null,
						})),
						_metadata: {
							links: { next: "https://api.torn.com/next" },
							total: 500,
						},
					} as unknown as ReturnType<typeof managerModule.tornApi.get>;
				}

				if (offset === 100) {
					return {
						bounties: Array.from({ length: 100 }, (_, i) => ({
							target_id: 3100 + i,
							target_name: `Target_${3100 + i}`,
							target_level: 10,
							reward: 400_000,
							quantity: 1,
							is_anonymous: false,
							valid_until: Math.floor(Date.now() / 1000) + 86400,
							lister_id: 1,
							lister_name: "Lister",
							reason: null,
						})),
						_metadata: {
							links: { next: "https://api.torn.com/next" },
							total: 500,
						},
					} as unknown as ReturnType<typeof managerModule.tornApi.get>;
				}

				if (offset === 200) {
					return {
						bounties: [
							...Array.from({ length: 50 }, (_, i) => ({
								target_id: 3200 + i,
								target_name: `Target_${3200 + i}`,
								target_level: 10,
								reward: 200_000,
								quantity: 1,
								is_anonymous: false,
								valid_until: Math.floor(Date.now() / 1000) + 86400,
								lister_id: 1,
								lister_name: "Lister",
								reason: null,
							})),
							...Array.from({ length: 50 }, (_, i) => ({
								target_id: 3250 + i,
								target_name: `TargetSub100k_${3250 + i}`,
								target_level: 10,
								reward: 50_000, // < 100k floor reached
								quantity: 1,
								is_anonymous: false,
								valid_until: Math.floor(Date.now() / 1000) + 86400,
								lister_id: 1,
								lister_name: "Lister",
								reason: null,
							})),
						],
						_metadata: {
							links: { next: "https://api.torn.com/next" },
							total: 500,
						},
					} as unknown as ReturnType<typeof managerModule.tornApi.get>;
				}

				return {
					bounties: Array.from({ length: 100 }, (_, i) => ({
						target_id: 3300 + i,
						target_name: `Sub_${offset}_${i}`,
						target_level: 10,
						reward: 40_000,
						quantity: 1,
						is_anonymous: false,
						valid_until: Math.floor(Date.now() / 1000) + 86400,
						lister_id: 1,
						lister_name: "Lister",
						reason: null,
					})),
					_metadata: {
						links: { next: null },
						total: 500,
					},
				} as unknown as ReturnType<typeof managerModule.tornApi.get>;
			}

			if (path === "/user/{id}/profile") {
				const opt = options as { pathParams: { id: number } };
				return {
					profile: {
						id: opt.pathParams.id,
						name: `Target_${opt.pathParams.id}`,
						level: 10,
						age: 100,
						status: { state: "Okay" },
					},
				} as unknown as ReturnType<typeof managerModule.tornApi.get>;
			}

			return {} as unknown as ReturnType<typeof managerModule.tornApi.get>;
		}) as unknown as typeof managerModule.tornApi.get);

		// Initial state: dynamicFloorPageCount defaults to 5
		expect(getDynamicFloorPageCount()).toBe(5);

		// Execute Cycle 1: Fetches 5 pages in parallel (offsets 0, 100, 200, 300, 400).
		// Sub-100k floor is hit on offset 200 (page index 2).
		// Dynamic floor count dynamically adjusts to 3 in memory!
		await runBountyFinderCycle();

		expect(getDynamicFloorPageCount()).toBe(3);
		expect(getCurrentSweepId()).toBe(2);

		// Reset cooldown and execute Cycle 2:
		// Now it only fetches 3 pages in parallel (offsets 0, 100, 200) instead of 5!
		tornApiGetSpy.mockClear();
		resetBountyFinderCooldown();
		await runBountyFinderCycle();

		// Check how many calls to /torn/bounties were made: exactly 3 pages!
		const bountyCalls = tornApiGetSpy.mock.calls.filter(
			(call: unknown[]) => call[0] === "/torn/bounties",
		);
		expect(bountyCalls.length).toBe(3);
		expect(getDynamicFloorPageCount()).toBe(3);
	});

	it("continues parallel batches of default pages (5 + 5) if initial batch does not reach 100k floor", async () => {
		getPlayerStatsSpy.mockResolvedValue([]); // Unscouted

		// Setup mock bounties where first batch (pages 0..4 = offsets 0..400) is all >= 100k,
		// and second batch (pages 5..9 = offsets 500..900) hits the 100k floor at page index 6 (offset 600).
		tornApiGetSpy.mockImplementation((async (
			path: string,
			options: unknown,
		) => {
			if (path === "/torn/bounties") {
				const opt = options as {
					queryParams: { limit: number; offset: number };
				};
				const offset = opt.queryParams.offset;

				// Pages 0 to 5: all >= 100k
				if (offset < 600) {
					return {
						bounties: Array.from({ length: 100 }, (_, i) => ({
							target_id: 4000 + offset + i,
							target_name: `Target_${offset}_${i}`,
							target_level: 10,
							reward: 500_000 - offset * 500, // all well above 100k
							quantity: 1,
							is_anonymous: false,
							valid_until: Math.floor(Date.now() / 1000) + 86400,
							lister_id: 1,
							lister_name: "Lister",
							reason: null,
						})),
						_metadata: {
							links: { next: "https://api.torn.com/next" },
							total: 1000,
						},
					} as unknown as ReturnType<typeof managerModule.tornApi.get>;
				}

				// Page 6 (offset 600): hits sub-100k floor
				if (offset === 600) {
					return {
						bounties: [
							...Array.from({ length: 50 }, (_, i) => ({
								target_id: 5000 + i,
								target_name: `Target_${offset}_${i}`,
								target_level: 10,
								reward: 120_000,
								quantity: 1,
								is_anonymous: false,
								valid_until: Math.floor(Date.now() / 1000) + 86400,
								lister_id: 1,
								lister_name: "Lister",
								reason: null,
							})),
							...Array.from({ length: 50 }, (_, i) => ({
								target_id: 5050 + i,
								target_name: `TargetSub_${i}`,
								target_level: 10,
								reward: 50_000, // < 100k floor reached
								quantity: 1,
								is_anonymous: false,
								valid_until: Math.floor(Date.now() / 1000) + 86400,
								lister_id: 1,
								lister_name: "Lister",
								reason: null,
							})),
						],
						_metadata: {
							links: { next: "https://api.torn.com/next" },
							total: 1000,
						},
					} as unknown as ReturnType<typeof managerModule.tornApi.get>;
				}

				// Pages 7+: sub-100k
				return {
					bounties: Array.from({ length: 100 }, (_, i) => ({
						target_id: 6000 + offset + i,
						target_name: `Sub_${offset}_${i}`,
						target_level: 10,
						reward: 40_000,
						quantity: 1,
						is_anonymous: false,
						valid_until: Math.floor(Date.now() / 1000) + 86400,
						lister_id: 1,
						lister_name: "Lister",
						reason: null,
					})),
					_metadata: { links: { next: null }, total: 1000 },
				} as unknown as ReturnType<typeof managerModule.tornApi.get>;
			}

			if (path === "/user/{id}/profile") {
				const opt = options as { pathParams: { id: number } };
				return {
					profile: {
						id: opt.pathParams.id,
						name: `Target_${opt.pathParams.id}`,
						level: 10,
						age: 100,
						status: { state: "Okay" },
					},
				} as unknown as ReturnType<typeof managerModule.tornApi.get>;
			}

			return {} as unknown as ReturnType<typeof managerModule.tornApi.get>;
		}) as unknown as typeof managerModule.tornApi.get);

		// Starts at default 5 pages
		expect(getDynamicFloorPageCount()).toBe(5);

		// Cycle 1:
		// Batch 1 fetches pages 0..4 (offsets 0, 100, 200, 300, 400).
		// Floor is not reached, so it immediately triggers Batch 2 with 5 pages (pages 5..9).
		// Page 6 (offset 600) hits the sub-100k floor.
		// Floor is detected at page index 6 -> dynamicFloorPageCount dynamically becomes 7!
		await runBountyFinderCycle();

		expect(getDynamicFloorPageCount()).toBe(7);

		// Cycle 2:
		// Now it starts with dynamicFloorPageCount = 7, fetching all 7 pages (offsets 0..600) in 1 parallel batch!
		tornApiGetSpy.mockClear();
		resetBountyFinderCooldown();
		await runBountyFinderCycle();

		const bountyCalls = tornApiGetSpy.mock.calls.filter(
			(call: unknown[]) => call[0] === "/torn/bounties",
		);
		expect(bountyCalls.length).toBe(7);
		expect(getDynamicFloorPageCount()).toBe(7);
	});

	it("uses the Subversive key pool for bounty requests instead of only personal key", async () => {
		await runBountyFinderCycle();
		expect(getNextSubversiveUserKeySpy).toHaveBeenCalled();
	});
});
