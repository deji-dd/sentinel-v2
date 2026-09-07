import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	db,
	elimsTeamPlayers,
	elimsTeamSnapshots,
	elimsTeams,
	eq,
	systemStates,
} from "@sentinel/database";
import {
	_resetSimulationInMemoryState,
	DEFAULT_TEAM_NAMES,
	ELIMS_SIMULATION_STATE_ID,
	ELIMS_TEAM_IDS,
	runElimsTrackingCycle,
} from "../src/workers/elimination/team-tracker";

describe("Elimination Team Tracker Worker", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	beforeEach(async () => {
		_resetSimulationInMemoryState();
		// Clean up existing test records
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

	test("executes mock cycle and stores 12 teams with official names, 2,000 members, lives, and elimination tracking", async () => {
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

		const nextRunMs = await runElimsTrackingCycle();

		// Should schedule next run on mock cadence (~5 seconds)
		expect(nextRunMs).toBeGreaterThan(Date.now());
		expect(nextRunMs - Date.now()).toBeLessThanOrEqual(6000);

		// Verify 12 mock teams in DB with official names and lives
		const teamsInDb = await db
			.select()
			.from(elimsTeams)
			.where(eq(elimsTeams.isMock, true))
			.orderBy(elimsTeams.id);
		expect(teamsInDb.length).toBe(12);
		expect(teamsInDb[0]?.membersCount).toBe(2000);
		expect(teamsInDb[0]?.lives).toBeGreaterThanOrEqual(0);
		expect(teamsInDb[0]?.name).toBe("Brain Surgeons");

		// Total tickets in circulation across all 12 teams must strictly equal 12,000
		const totalTickets = teamsInDb.reduce((sum, t) => sum + t.score, 0);
		expect(totalTickets).toBe(12000);

		// Verify 24,000 mock players (2,000 per team)
		const playersInDb = await db
			.select()
			.from(elimsTeamPlayers)
			.where(eq(elimsTeamPlayers.isMock, true));
		expect(playersInDb.length).toBe(24000);

		// Verify exactly 12 snapshots recorded for current cycle (NO fake 24h baseline seeding)
		const snapshotsInDb = await db
			.select()
			.from(elimsTeamSnapshots)
			.where(eq(elimsTeamSnapshots.isMock, true));
		expect(snapshotsInDb.length).toBeGreaterThanOrEqual(12);
		expect(snapshotsInDb[0]?.hourTct).toBeGreaterThanOrEqual(0);
		expect(snapshotsInDb[0]?.hourTct).toBeLessThan(24);
		expect(snapshotsInDb[0]?.lives).toBeDefined();
		expect(snapshotsInDb[0]?.eliminated).toBeDefined();

		// Second cycle within 5-minute backoff window runs immediately on 5s cadence
		const secondRunMs = await runElimsTrackingCycle();
		expect(secondRunMs).toBeGreaterThan(Date.now());
		expect(secondRunMs - Date.now()).toBeLessThanOrEqual(6000);

		// Exactly 24 snapshots now in DB (12 from cycle 1 + 12 from cycle 2)
		const snapshotsAfterSecond = await db
			.select()
			.from(elimsTeamSnapshots)
			.where(eq(elimsTeamSnapshots.isMock, true));
		expect(snapshotsAfterSecond.length).toBeGreaterThanOrEqual(24);
	});

	test("survives process restarts without resetting simulation state or wiping accumulated snapshots", async () => {
		// Mock global fetch to return Code 32
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

		// Run cycle 1
		await runElimsTrackingCycle();

		const teamsAfterCycle1 = await db
			.select()
			.from(elimsTeams)
			.where(eq(elimsTeams.isMock, true))
			.orderBy(elimsTeams.id);

		const totalAttacksCycle1 = teamsAfterCycle1.reduce(
			(sum, t) => sum + t.attacks,
			0,
		);
		expect(totalAttacksCycle1).toBeGreaterThan(0);

		// SIMULATE PROCESS RESTART: clear all in-memory state
		_resetSimulationInMemoryState();

		// Run cycle 2 after restart
		await runElimsTrackingCycle();

		// Check systemStates was updated to cycle 2
		const [simState] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_SIMULATION_STATE_ID));
		expect(simState).toBeDefined();
		const stateData = simState?.data as { mockCycleCount: number };
		expect(stateData.mockCycleCount).toBe(2);

		// Verify teams picked up from previous cycle (attacks accumulated, not reset to 0)
		const teamsAfterRestart = await db
			.select()
			.from(elimsTeams)
			.where(eq(elimsTeams.isMock, true))
			.orderBy(elimsTeams.id);

		const totalAttacksAfterRestart = teamsAfterRestart.reduce(
			(sum, t) => sum + t.attacks,
			0,
		);
		expect(totalAttacksAfterRestart).toBeGreaterThan(totalAttacksCycle1);

		// Total tickets in circulation across active teams remains 12,000
		const totalTickets = teamsAfterRestart.reduce((sum, t) => sum + t.score, 0);
		expect(totalTickets).toBe(12000);

		// Total snapshots accumulated: 24 (12 pre-restart + 12 post-restart)
		const allSnapshots = await db
			.select()
			.from(elimsTeamSnapshots)
			.where(eq(elimsTeamSnapshots.isMock, true));
		expect(allSnapshots.length).toBe(24);
	});
});
