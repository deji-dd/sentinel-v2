import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	apiKeys,
	db,
	elimsTeamPlayers,
	elimsTeamSnapshots,
	elimsTeams,
	eq,
	systemStates,
} from "@sentinel/database";
import {
	_resetSimulationInMemoryState,
	CODE_32_BACKOFF_MS,
	DEFAULT_TEAM_NAMES,
	ELIMS_SIMULATION_STATE_ID,
	ELIMS_TEAM_IDS,
	runElimsTrackingCycle,
} from "../src/workers/elimination/team-tracker";

describe("Elimination Team Tracker Worker", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	const TEST_KEY_USER_ID = 9999999;

	beforeEach(async () => {
		_resetSimulationInMemoryState();
		// Ensure an active system key exists in the pool for probe checks
		await db
			.insert(apiKeys)
			.values({
				userId: TEST_KEY_USER_ID,
				apiKeyEncrypted: "test_probe_key_16ch",
				apiKeyHash: "test_probe_hash",
				keyType: "system",
				isValid: true,
			})
			.onConflictDoNothing();

		// Clean up existing test records
		await db
			.delete(elimsTeamSnapshots)
			.where(eq(elimsTeamSnapshots.teamId, 70));
		await db.delete(elimsTeamPlayers).where(eq(elimsTeamPlayers.teamId, 70));
		await db.delete(elimsTeams).where(eq(elimsTeams.id, 70));
		await db
			.delete(elimsTeamSnapshots)
			.where(eq(elimsTeamSnapshots.isMock, true));
		await db.delete(elimsTeamPlayers).where(eq(elimsTeamPlayers.isMock, true));
		await db.delete(elimsTeams).where(eq(elimsTeams.isMock, true));
		await db
			.delete(systemStates)
			.where(eq(systemStates.id, ELIMS_SIMULATION_STATE_ID));
	});

	afterEach(async () => {
		fetchSpy?.mockRestore();
		_resetSimulationInMemoryState();
		await db.delete(apiKeys).where(eq(apiKeys.userId, TEST_KEY_USER_ID));
		await db
			.delete(elimsTeamSnapshots)
			.where(eq(elimsTeamSnapshots.teamId, 70));
		await db.delete(elimsTeamPlayers).where(eq(elimsTeamPlayers.teamId, 70));
		await db.delete(elimsTeams).where(eq(elimsTeams.id, 70));
		await db
			.delete(elimsTeamSnapshots)
			.where(eq(elimsTeamSnapshots.isMock, true));
		await db.delete(elimsTeamPlayers).where(eq(elimsTeamPlayers.isMock, true));
		await db.delete(elimsTeams).where(eq(elimsTeams.isMock, true));
		await db
			.delete(systemStates)
			.where(eq(systemStates.id, ELIMS_SIMULATION_STATE_ID));
	});

	test("ELIMS_TEAM_IDS contains exactly 12 teams (70, 80-90) with official names", () => {
		expect(ELIMS_TEAM_IDS).toEqual([
			70, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90,
		]);
		expect(ELIMS_TEAM_IDS.length).toBe(12);
		expect(DEFAULT_TEAM_NAMES[70]).toBe("Brain Surgeons");
		expect(DEFAULT_TEAM_NAMES[80]).toBe("Conspiracy Theorists");
		expect(DEFAULT_TEAM_NAMES[90]).toBe("Loose Cannons");
	});

	test("when Torn returns Code 32, pauses for 5 minutes without running simulation mode or seeding mock data", async () => {
		// Mock global fetch to return Torn Error Code 32 (closed until attacking period)
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () =>
				new Response(
					JSON.stringify({
						error: {
							code: 32,
							error: "Closed until the attacking period starts",
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				)) as unknown as typeof fetch,
		);

		const beforeRun = Date.now();
		const nextRunMs = await runElimsTrackingCycle();

		// Should pause for ~5 minutes (CODE_32_BACKOFF_MS)
		expect(nextRunMs).toBeGreaterThanOrEqual(
			beforeRun + CODE_32_BACKOFF_MS - 100,
		);
		expect(nextRunMs).toBeLessThanOrEqual(
			Date.now() + CODE_32_BACKOFF_MS + 2000,
		);

		// Verify zero mock teams or mock players were created
		const mockTeams = await db
			.select()
			.from(elimsTeams)
			.where(eq(elimsTeams.isMock, true));
		expect(mockTeams.length).toBe(0);

		const mockPlayers = await db
			.select()
			.from(elimsTeamPlayers)
			.where(eq(elimsTeamPlayers.isMock, true));
		expect(mockPlayers.length).toBe(0);

		// Subsequent call while within 5m backoff period returns remaining backoff immediately
		const immediateNextMs = await runElimsTrackingCycle();
		expect(immediateNextMs).toBe(nextRunMs);
	});

	test("executes parallel batch requests across all teams and persists player data when API is open", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url = String(input);

			if (url.includes("/torn/elimination")) {
				return new Response(
					JSON.stringify({
						elimination: ELIMS_TEAM_IDS.map((id) => ({
							id,
							name: DEFAULT_TEAM_NAMES[id] ?? `Team ${id}`,
							participants: 120,
							position: 1,
							score: 1000,
							lives: 50,
							wins: 2,
							losses: 0,
							eliminated: false,
							eliminated_timestamp: null,
						})),
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			if (url.includes("/torn/70/eliminationteam")) {
				return new Response(
					JSON.stringify({
						eliminationteam: [
							{
								id: 50001,
								name: "DocSurgeon",
								level: 75,
								score: 15,
								attacks: 3,
								last_action: {
									status: "Online",
									timestamp: Date.now(),
									relative: "1 minute ago",
								},
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			// All other teams return empty player lists
			return new Response(
				JSON.stringify({
					eliminationteam: [],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as unknown as typeof fetch);

		const nextRunMs = await runElimsTrackingCycle();
		expect(nextRunMs).toBeGreaterThan(Date.now());

		// Verify team record was upserted
		const team70 = await db.query.elimsTeams.findFirst({
			where: eq(elimsTeams.id, 70),
		});
		expect(team70).toBeDefined();
		expect(team70?.name).toBe("Brain Surgeons");
		expect(team70?.score).toBe(15);
		expect(team70?.attacks).toBe(3);
		expect(team70?.membersCount).toBe(1);

		// Verify player was upserted
		const player = await db.query.elimsTeamPlayers.findFirst({
			where: eq(elimsTeamPlayers.id, 50001),
		});
		expect(player).toBeDefined();
		expect(player?.name).toBe("DocSurgeon");
		expect(player?.teamId).toBe(70);
		expect(player?.score).toBe(15);
		expect(player?.attacks).toBe(3);

		// Verify snapshot was created
		const snapshot = await db.query.elimsTeamSnapshots.findFirst({
			where: eq(elimsTeamSnapshots.teamId, 70),
		});
		expect(snapshot).toBeDefined();
		expect(snapshot?.activeCount).toBe(1);
	});
});
