import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as databaseModule from "@sentinel/database";
import * as tornApiModule from "@sentinel/torn-api";
import {
	MAX_RANKED_WAR_DURATION_SECONDS,
	resetRecruitmentCache,
	runRecruitmentCycle,
	SUBVERSIVE_RECRUITMENT_CONFIG_ID,
	SUBVERSIVE_RECRUITMENT_STATE_ID,
} from "../src/workers/subversive/recruitment-worker";
import * as keyPoolModule from "../src/workers/subversive/subversive-key-pool";

class MockQuery<T> extends Promise<T> {
	orderBy(): this {
		return this;
	}
	limit(): this {
		return this;
	}
}

function createMockQuery<T>(executor: () => T | Promise<T>): MockQuery<T> {
	return new MockQuery((resolve, reject) => {
		try {
			Promise.resolve(executor()).then(resolve, reject);
		} catch (err) {
			reject(err);
		}
	});
}

class MockInsertQuery<T> extends Promise<T> {
	onConflictDoNothing(): this {
		return this;
	}
	onConflictDoUpdate(): this {
		return this;
	}
}

function createMockInsertQuery<T>(
	executor: () => T | Promise<T>,
): MockInsertQuery<T> {
	return new MockInsertQuery((resolve, reject) => {
		try {
			Promise.resolve(executor()).then(resolve, reject);
		} catch (err) {
			reject(err);
		}
	});
}

function extractConditionValue(condition: unknown): unknown {
	if (!condition || typeof condition !== "object") return undefined;
	const cond = condition as Record<string, unknown>;
	if (cond.value !== undefined) return cond.value;
	if (
		cond.right &&
		typeof cond.right === "object" &&
		"value" in (cond.right as Record<string, unknown>)
	) {
		return (cond.right as Record<string, unknown>).value;
	}
	if (cond.right !== undefined) return cond.right;
	if (Array.isArray(cond.queryChunks)) {
		for (const chunk of cond.queryChunks) {
			if (chunk && typeof chunk === "object" && "value" in chunk) {
				const val = (chunk as Record<string, unknown>).value;
				if (typeof val === "string" || typeof val === "number") {
					return val;
				}
			}
		}
	}
	return undefined;
}

describe("Subversive Recruitment Worker", () => {
	let getKeySpy: ReturnType<typeof spyOn>;
	let tornGetSpy: ReturnType<typeof spyOn>;
	let getPlayerStatsSpy: ReturnType<typeof spyOn>;
	let dbSelectSpy: ReturnType<typeof spyOn>;
	let dbInsertSpy: ReturnType<typeof spyOn>;

	let mockRankedWarsRows: Array<{ id: number }> = [];
	let mockCandidatesRows: Array<{ warId: number; playerId: number }> = [];
	let mockConfig: Record<string, unknown> = {
		minStats: 50_000_000,
		minAttacks: 10,
		minAttackPercentage: 5.0,
		notificationChannelId: null,
		notificationsEnabled: false,
		termedClusterPercentage: 60,
		autoScanEnabled: true,
		excludedFactionIds: [],
	};
	let mockState: { init: boolean; data: Record<string, unknown> } | null = null;

	beforeEach(() => {
		resetRecruitmentCache();
		mockRankedWarsRows = [];
		mockCandidatesRows = [];
		mockState = null;
		mockConfig = {
			minStats: 50_000_000,
			minAttacks: 10,
			minAttackPercentage: 5.0,
			notificationChannelId: null,
			notificationsEnabled: false,
			termedClusterPercentage: 60,
			autoScanEnabled: true,
			excludedFactionIds: [],
		};

		// Mock Drizzle db.select
		dbSelectSpy = spyOn(databaseModule.db, "select").mockImplementation(
			(() => ({
				from: (table: unknown) => ({
					where: (condition: unknown) =>
						createMockQuery(() => {
							const targetVal = extractConditionValue(condition);
							if (table === databaseModule.systemStates) {
								if (targetVal === SUBVERSIVE_RECRUITMENT_CONFIG_ID) {
									return [{ init: true, data: mockConfig }];
								}
								if (targetVal === SUBVERSIVE_RECRUITMENT_STATE_ID) {
									return mockState ? [mockState] : [];
								}
								return [{ init: true, data: mockConfig }];
							}
							if (table === databaseModule.subversiveRankedWars) {
								const warId = targetVal;
								const found = mockRankedWarsRows.find(
									(r) =>
										r.id === warId ||
										(typeof warId === "number" && r.id === warId),
								);
								return found ? [{ id: found.id }] : [];
							}
							if (table === databaseModule.workerSchedules) {
								return [{ forceRun: false }];
							}
							return [];
						}),
					orderBy: () =>
						createMockQuery(() => {
							if (table === databaseModule.subversiveRankedWars) {
								return mockRankedWarsRows.map((r) => ({ id: r.id }));
							}
							return [];
						}),
				}),
			})) as unknown as typeof databaseModule.db.select,
		);

		// Mock Drizzle db.insert
		dbInsertSpy = spyOn(databaseModule.db, "insert").mockImplementation(((
			table: unknown,
		) => ({
			values: (val: unknown) =>
				createMockInsertQuery(() => {
					const rec = val as Record<string, unknown>;
					if (table === databaseModule.subversiveRankedWars) {
						mockRankedWarsRows.push({ id: Number(rec.id) });
					} else if (table === databaseModule.subversiveRecruitmentCandidates) {
						mockCandidatesRows.push({
							warId: Number(rec.warId),
							playerId: Number(rec.playerId),
						});
					} else if (table === databaseModule.systemStates) {
						mockState = {
							init: Boolean(rec.init),
							data: rec.data as Record<string, unknown>,
						};
					}
					return [val];
				}),
		})) as unknown as typeof databaseModule.db.insert);

		getPlayerStatsSpy = spyOn(
			tornApiModule,
			"getPlayerStats",
		).mockImplementation(
			async (ids) =>
				ids.map((id) => ({
					player_id: id,
					bs_estimate: 150_000_000,
					fair_fight: 2.5,
				})) as unknown as tornApiModule.FFScouterTargetResult[],
		);
	});

	afterEach(() => {
		getKeySpy?.mockRestore();
		tornGetSpy?.mockRestore();
		getPlayerStatsSpy?.mockRestore();
		dbSelectSpy?.mockRestore();
		dbInsertSpy?.mockRestore();
	});

	it("uses keys from subversive script key pool and returns 0 when no keys are available", async () => {
		getKeySpy = spyOn(
			keyPoolModule,
			"getNextSubversiveUserKey",
		).mockImplementation(async () => null);

		const result = await runRecruitmentCycle({ force: true });
		expect(result.scannedWars).toBe(0);
		expect(result.completedWars).toBe(0);
		expect(result.candidatesFound).toBe(0);
	});

	it("Niche Case 1: paginates past scheduled wars spanning multiple pages to find completed wars", async () => {
		const mockKey = {
			apiKey: "subversive_key_1",
			userId: 1001,
			keyType: "custom" as const,
		};
		getKeySpy = spyOn(
			keyPoolModule,
			"getNextSubversiveUserKey",
		).mockImplementation(async () => mockKey);

		const nowSec = Math.floor(Date.now() / 1000);
		mockState = {
			init: true,
			data: { lastScanTimestamp: nowSec - 14400 },
		};

		// Page 1: 100 scheduled wars with future start times (end === 0)
		const scheduledWarsPage1 = Array.from({ length: 100 }, (_, i) => ({
			id: 80000 + i,
			start: nowSec + 3600 + i * 60,
			end: 0,
			target: 5000,
			winner: null,
			factions: [],
		}));

		// Page 2: completed war 99901 (started yesterday, completed 2 hours ago)
		const completedWarsPage2 = [
			{
				id: 99901,
				start: nowSec - 86400,
				end: nowSec - 7200,
				target: 5000,
				winner: 200,
				factions: [],
			},
		];

		tornGetSpy = spyOn(tornApiModule.tornApi, "get").mockImplementation((async (
			path: string,
			options?: unknown,
		) => {
			const opts = options as { queryParams?: { to?: number } } | undefined;

			if (path === "/faction/warfareranked") {
				if (!opts?.queryParams?.to) {
					// Page 1
					return {
						warfareranked: scheduledWarsPage1,
						_metadata: {
							links: {
								next: `https://api.torn.com/v2/faction/warfareranked?to=${nowSec}&limit=100&sort=DESC`,
								prev: null,
							},
						},
					};
				}
				// Page 2
				return {
					warfareranked: completedWarsPage2,
					_metadata: {
						links: {
							next: null,
							prev: null,
						},
					},
				};
			}

			if (path === "/faction/{rankedWarId}/rankedwarreport") {
				return {
					rankedwarreport: {
						id: 99901,
						start: nowSec - 86400,
						end: nowSec - 7200,
						target: 5000,
						winner: 200,
						forfeit: false,
						factions: [
							{
								id: 200,
								name: "Alpha Faction",
								attacks: 100,
								score: 5000,
								members: [
									{
										id: 5501,
										name: "TopAttacker",
										level: 60,
										attacks: 25,
										score: 1200,
									},
								],
							},
						],
					},
				};
			}

			if (path === "/faction/{id}/members") {
				return {
					members: [
						{
							id: 5501,
							name: "TopAttacker",
							level: 60,
							days_in_faction: 45,
							position: "Member",
						},
					],
				};
			}

			return {};
		}) as unknown as typeof tornApiModule.tornApi.get);

		const result = await runRecruitmentCycle({ force: true });
		// Should have scanned scheduled wars on page 1 + completed war on page 2 (101 wars)
		expect(result.scannedWars).toBe(101);
		expect(result.completedWars).toBe(1);
		expect(result.candidatesFound).toBe(1);

		// Verify candidate was inserted
		const candidate = mockCandidatesRows.find((c) => c.warId === 99901);
		expect(candidate).toBeDefined();
		expect(candidate?.playerId).toBe(5501);
	});

	it("Niche Case 2: continues paginating when page 1 contains already-evaluated wars, discovering new finishes on page 2", async () => {
		const mockKey = {
			apiKey: "subversive_key_1",
			userId: 1001,
			keyType: "custom" as const,
		};
		getKeySpy = spyOn(
			keyPoolModule,
			"getNextSubversiveUserKey",
		).mockImplementation(async () => mockKey);

		const nowSec = Math.floor(Date.now() / 1000);
		mockState = {
			init: true,
			data: { lastScanTimestamp: nowSec - 14400 },
		};

		// Simulate War 99902 on Page 1 already evaluated in a previous cycle
		mockRankedWarsRows.push({ id: 99902 });

		// Page 1: War 99902 (started recently, already evaluated)
		const page1Wars = [
			{
				id: 99902,
				start: nowSec - 10000,
				end: nowSec - 8000,
				target: 5000,
				winner: 100,
				factions: [],
			},
		];

		// Page 2: War 99903 (started earlier, just finished 10 minutes ago, NOT yet evaluated)
		const page2Wars = [
			{
				id: 99903,
				start: nowSec - 70000,
				end: nowSec - 600,
				target: 5000,
				winner: 200,
				factions: [],
			},
		];

		tornGetSpy = spyOn(tornApiModule.tornApi, "get").mockImplementation((async (
			path: string,
			options?: unknown,
		) => {
			const opts = options as { queryParams?: { to?: number } } | undefined;

			if (path === "/faction/warfareranked") {
				if (!opts?.queryParams?.to) {
					// Page 1
					return {
						warfareranked: page1Wars,
						_metadata: {
							links: {
								next: `https://api.torn.com/v2/faction/warfareranked?to=${nowSec - 20000}&limit=100&sort=DESC`,
								prev: null,
							},
						},
					};
				}
				// Page 2
				return {
					warfareranked: page2Wars,
					_metadata: {
						links: {
							next: null,
							prev: null,
						},
					},
				};
			}

			if (path === "/faction/{rankedWarId}/rankedwarreport") {
				return {
					rankedwarreport: {
						id: 99903,
						start: nowSec - 70000,
						end: nowSec - 600,
						target: 5000,
						winner: 200,
						forfeit: false,
						factions: [
							{
								id: 200,
								name: "Bravo Faction",
								attacks: 100,
								score: 5000,
								members: [
									{
										id: 5502,
										name: "GrindAttacker",
										level: 70,
										attacks: 30,
										score: 1500,
									},
								],
							},
						],
					},
				};
			}

			if (path === "/faction/{id}/members") {
				return {
					members: [
						{
							id: 5502,
							name: "GrindAttacker",
							level: 70,
							days_in_faction: 100,
							position: "Member",
						},
					],
				};
			}

			return {};
		}) as unknown as typeof tornApiModule.tornApi.get);

		const result = await runRecruitmentCycle({ force: true });
		// Scanned both wars (99902 and 99903)
		expect(result.scannedWars).toBe(2);
		// 99902 was already evaluated, only 99903 is evaluated as newly completed
		expect(result.completedWars).toBe(1);
		expect(result.candidatesFound).toBe(1);

		const candidate = mockCandidatesRows.find((c) => c.warId === 99903);
		expect(candidate).toBeDefined();
		expect(candidate?.playerId).toBe(5502);
	});

	it("stops pagination early when wars on a page exceed the 123-hour duration cutoff", async () => {
		const mockKey = {
			apiKey: "subversive_key_1",
			userId: 1001,
			keyType: "custom" as const,
		};
		getKeySpy = spyOn(
			keyPoolModule,
			"getNextSubversiveUserKey",
		).mockImplementation(async () => mockKey);

		// Cutoff: startOfCurrentDayUtc - 123h
		const startOfToday = Math.floor(new Date().setUTCHours(0, 0, 0, 0) / 1000);
		const ancientStart = startOfToday - MAX_RANKED_WAR_DURATION_SECONDS - 86400; // Well past 123h cutoff

		let pageRequests = 0;

		tornGetSpy = spyOn(tornApiModule.tornApi, "get").mockImplementation((async (
			path: string,
		) => {
			if (path === "/faction/warfareranked") {
				pageRequests++;
				return {
					// All wars started long before cutoff
					warfareranked: [
						{
							id: 77701,
							start: ancientStart,
							end: ancientStart + 3600,
							target: 5000,
							winner: 1,
							factions: [],
						},
					],
					_metadata: {
						links: {
							next: "https://api.torn.com/v2/faction/warfareranked?to=1000&limit=100&sort=DESC",
							prev: null,
						},
					},
				};
			}
			return {};
		}) as unknown as typeof tornApiModule.tornApi.get);

		const result = await runRecruitmentCycle({ force: true });
		// Even though links.next exists, it must have stopped immediately at page 1 due to the 123-hour cutoff
		expect(pageRequests).toBe(1);
		expect(result.scannedWars).toBe(1);
		expect(result.completedWars).toBe(0);
	});
});
