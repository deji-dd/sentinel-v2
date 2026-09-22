import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as ffscouterModule from "@sentinel/torn-api";
import * as managerModule from "@sentinel/torn-api";
import {
	getCurrentBountyOffset,
	getCurrentSweepId,
	getInMemoryBountyState,
	resetBountyFinderCooldown,
	resetBountyFinderState,
	runBountyFinderCycle,
} from "../src/workers/personal/bounty-finder";

describe("Personal Bounty Target Finder Worker", () => {
	let getPersonalKeySpy: ReturnType<typeof spyOn>;
	let tornApiGetSpy: ReturnType<typeof spyOn>;
	let getPlayerStatsSpy: ReturnType<typeof spyOn>;

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

		// Exactly 20 should have been profiled and placed in readyTargets
		expect(data.readyTargets.length).toBe(20);
		expect(data.pendingCount).toBe(5);

		// Highest reward candidates (IDs 2005 to 2024) must be in readyTargets
		const readyIds = data.readyTargets.map((t) => t.id);
		expect(readyIds).toContain(2024); // Highest reward (340k)
		expect(readyIds).toContain(2005);

		// The 5 lowest reward candidates (IDs 2000, 2001, 2002, 2003, 2004) must NOT be in readyTargets
		expect(readyIds).not.toContain(2000);
		expect(readyIds).not.toContain(2001);
		expect(readyIds).not.toContain(2002);
		expect(readyIds).not.toContain(2003);
		expect(readyIds).not.toContain(2004);
	});

	it("skips execution if invoked within the minimum cooldown period", async () => {
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

	it("persists pagination offset across rounds and continues down pages until hitting < 100k bounties, then resets offset to 0", async () => {
		getPlayerStatsSpy.mockResolvedValue([]); // Unscouted

		// Setup mock bounties across offsets:
		// Round 1:
		// Offset 0: 100 bounties (rewards 500k)
		// Offset 100: 100 bounties (rewards 400k)
		// Offset 200: 100 bounties (rewards 300k)
		// Round 2:
		// Offset 300: 100 bounties (rewards 200k)
		// Offset 400: 100 bounties (first 50 are 150k, next 50 are 50k < 100k!)
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
						bounties: Array.from({ length: 100 }, (_, i) => ({
							target_id: 3200 + i,
							target_name: `Target_${3200 + i}`,
							target_level: 10,
							reward: 300_000,
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

				if (offset === 300) {
					return {
						bounties: Array.from({ length: 100 }, (_, i) => ({
							target_id: 3300 + i,
							target_name: `Target_${3300 + i}`,
							target_level: 10,
							reward: 200_000,
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

				if (offset === 400) {
					// 50 bounties at 150k, 50 bounties at 50k (< 100k)
					const bounties = [
						...Array.from({ length: 50 }, (_, i) => ({
							target_id: 3400 + i,
							target_name: `Target_${3400 + i}`,
							target_level: 10,
							reward: 150_000,
							quantity: 1,
							is_anonymous: false,
							valid_until: Math.floor(Date.now() / 1000) + 86400,
							lister_id: 1,
							lister_name: "Lister",
							reason: null,
						})),
						...Array.from({ length: 50 }, (_, i) => ({
							target_id: 3450 + i,
							target_name: `TargetSub100k_${3450 + i}`,
							target_level: 10,
							reward: 50_000, // < 100k
							quantity: 1,
							is_anonymous: false,
							valid_until: Math.floor(Date.now() / 1000) + 86400,
							lister_id: 1,
							lister_name: "Lister",
							reason: null,
						})),
					];
					return {
						bounties,
						_metadata: { links: { next: null }, total: 500 },
					} as unknown as ReturnType<typeof managerModule.tornApi.get>;
				}
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

		// Execute Round 1: should fetch 3 pages (offsets 0, 100, 200 = 300 bounties)
		await runBountyFinderCycle();

		expect(getCurrentBountyOffset()).toBe(300);
		expect(getCurrentSweepId()).toBe(1);

		// Reset cooldown and execute Round 2: should continue from offset 300,
		// fetch offset 300 (100 bounties) and offset 400 (hits < 100k),
		// complete the sweep, and reset offset to 0 while incrementing sweepId to 2!
		resetBountyFinderCooldown();
		await runBountyFinderCycle();

		expect(getCurrentBountyOffset()).toBe(0);
		expect(getCurrentSweepId()).toBe(2);

		// Verify state contains candidates from both Round 1 and Round 2
		const state = getInMemoryBountyState();
		expect(state.readyTargets.length).toBe(40); // 20 from round 1 + 20 from round 2
		expect(state.pendingCount).toBe(410); // 450 qualifying candidates - 40 profiled = 410 pending
		// 450 qualifying candidates in total (300 from round 1, 150 from round 2)
		// Sub-100k targets (IDs 3450..3499) were discarded
		expect(state.targetCount).toBe(40);
	});
});
