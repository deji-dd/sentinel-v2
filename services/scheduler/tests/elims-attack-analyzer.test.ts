import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db, elimsTeamAttacks, eq } from "@sentinel/database";
import {
	_resetAttackAnalyzerState,
	extractAttackerName,
	hydrateActiveHospitalStays,
	processAttackSnapshot,
} from "../src/workers/elimination/attack-analyzer";
import type { TornEliminationPlayerApiItem } from "../src/workers/elimination/team-tracker";

describe("Elimination Attack Analyzer", () => {
	beforeEach(async () => {
		_resetAttackAnalyzerState();
		// Clean up test attacks
		await db
			.delete(elimsTeamAttacks)
			.where(eq(elimsTeamAttacks.victimId, 999901));
		await db
			.delete(elimsTeamAttacks)
			.where(eq(elimsTeamAttacks.victimId, 999902));
	});

	afterEach(async () => {
		_resetAttackAnalyzerState();
		await db
			.delete(elimsTeamAttacks)
			.where(eq(elimsTeamAttacks.victimId, 999901));
		await db
			.delete(elimsTeamAttacks)
			.where(eq(elimsTeamAttacks.victimId, 999902));
	});

	describe("extractAttackerName", () => {
		test("extracts plain attacker names correctly", () => {
			expect(extractAttackerName("Hospitalized by JohnDoe")).toBe("JohnDoe");
			expect(extractAttackerName("Attacked by Jane_Doe-99")).toBe(
				"Jane_Doe-99",
			);
			expect(extractAttackerName("Mugged by Bob The Builder")).toBe(
				"Bob The Builder",
			);
		});

		test("extracts attacker names from HTML links", () => {
			expect(
				extractAttackerName(
					"Hospitalized by <a href='https://www.torn.com/profiles.php?XID=123'>JohnDoe</a>",
				),
			).toBe("JohnDoe");
		});

		test("discards stealth attacks ('by someone')", () => {
			expect(extractAttackerName("Attacked by someone")).toBeNull();
			expect(extractAttackerName("Hospitalized by someone")).toBeNull();
			expect(extractAttackerName("Mugged by someone")).toBeNull();
		});

		test("returns null for non-attack reasons", () => {
			expect(extractAttackerName("Overdosed on Ketamine")).toBeNull();
			expect(extractAttackerName("Collapsed from exhaustion")).toBeNull();
			expect(
				extractAttackerName("Suffered acute radiation sickness"),
			).toBeNull();
			expect(extractAttackerName(null)).toBeNull();
			expect(extractAttackerName(undefined)).toBeNull();
		});
	});

	describe("processAttackSnapshot", () => {
		test("detects valid attacks, discards friendly fire and stealth, and handles med-downs", async () => {
			// Setup test players
			// Attacker: Bob (id: 88001) on Team 88 (Nine Lives)
			// Victim 1: Alice (id: 999901) on Team 89 (High Voltage)
			// Victim 2: Charlie (id: 999902) on Team 88 (Nine Lives - friendly fire)
			const team88Map = new Map<number, TornEliminationPlayerApiItem>();
			const team89Map = new Map<number, TornEliminationPlayerApiItem>();

			const bob: TornEliminationPlayerApiItem = {
				id: 88001,
				name: "Bob",
				level: 50,
				status: {
					description: "Okay",
					details: null,
					state: "Okay",
					color: "green",
					until: null,
				},
			};
			const charlie: TornEliminationPlayerApiItem = {
				id: 999902,
				name: "Charlie",
				level: 30,
				status: {
					description: "In hospital",
					details: "Hospitalized by Bob",
					state: "Hospital",
					color: "red",
					until: 1726000000,
				},
			};
			const alice: TornEliminationPlayerApiItem = {
				id: 999901,
				name: "Alice",
				level: 40,
				status: {
					description: "In hospital",
					details: "Hospitalized by Bob",
					state: "Hospital",
					color: "red",
					until: 1726001000,
				},
			};

			team88Map.set(bob.id, bob);
			team88Map.set(charlie.id, charlie);
			team89Map.set(alice.id, alice);

			const teamPlayersMap = new Map<
				number,
				Map<number, TornEliminationPlayerApiItem>
			>();
			teamPlayersMap.set(88, team88Map);
			teamPlayersMap.set(89, team89Map);

			// Cycle 1: Alice is attacked by Bob (88 -> 89). Charlie is friendly fire (88 -> 88, ignored)
			const cycle1 = await processAttackSnapshot({
				capturedAt: new Date(),
				teamPlayersMap,
			});

			expect(cycle1.detectedCount).toBe(1);

			// Verify DB record
			const attacks = await db
				.select()
				.from(elimsTeamAttacks)
				.where(eq(elimsTeamAttacks.victimId, 999901));
			expect(attacks.length).toBe(1);
			expect(attacks[0]?.attackerId).toBe(88001);
			expect(attacks[0]?.attackerTeamId).toBe(88);
			expect(attacks[0]?.victimTeamId).toBe(89);

			// Cycle 2: Same status, same until -> should NOT count again
			const cycle2 = await processAttackSnapshot({
				capturedAt: new Date(),
				teamPlayersMap,
			});
			expect(cycle2.detectedCount).toBe(0);

			// Cycle 3: Alice meds down! (until decreases from 1726001000 to 1726000500)
			alice.status = {
				description: "In hospital",
				details: "Hospitalized by Bob",
				state: "Hospital",
				color: "red",
				until: 1726000500, // Medded down
			};

			const cycle3 = await processAttackSnapshot({
				capturedAt: new Date(),
				teamPlayersMap,
			});
			expect(cycle3.detectedCount).toBe(0); // Still 0, medded down in same hosp stay!

			// Cycle 4: Alice leaves hospital (state="Okay")
			alice.status = {
				description: "Okay",
				details: null,
				state: "Okay",
				color: "green",
				until: null,
			};

			const cycle4 = await processAttackSnapshot({
				capturedAt: new Date(),
				teamPlayersMap,
			});
			expect(cycle4.detectedCount).toBe(0);

			// Cycle 5: Alice is attacked AGAIN by Bob! (new hospital stay with until: 1726002000)
			alice.status = {
				description: "In hospital",
				details: "Hospitalized by Bob",
				state: "Hospital",
				color: "red",
				until: 1726002000,
			};

			const cycle5 = await processAttackSnapshot({
				capturedAt: new Date(),
				teamPlayersMap,
			});
			expect(cycle5.detectedCount).toBe(1); // Detected new attack!

			const attacksTotal = await db
				.select()
				.from(elimsTeamAttacks)
				.where(eq(elimsTeamAttacks.victimId, 999901));
			expect(attacksTotal.length).toBe(2);
		});

		test("hydrates active stays from database on service restart", async () => {
			const nowSec = Math.floor(Date.now() / 1000);
			const futureUntil = nowSec + 1800; // 30 mins in future

			// Pre-insert an attack into the database simulating a previous run
			await db.insert(elimsTeamAttacks).values({
				attackerId: 88001,
				attackerName: "Bob",
				attackerTeamId: 88,
				victimId: 999901,
				victimName: "Alice",
				victimTeamId: 89,
				hospitalUntil: futureUntil,
				details: "Hospitalized by Bob",
				isMock: true,
			});

			// Clear in-memory state simulating a service restart
			_resetAttackAnalyzerState();

			// Hydrate state
			await hydrateActiveHospitalStays();

			const team88Map = new Map<number, TornEliminationPlayerApiItem>();
			const team89Map = new Map<number, TornEliminationPlayerApiItem>();

			team88Map.set(88001, {
				id: 88001,
				name: "Bob",
				level: 50,
				status: {
					state: "Okay",
					description: "Okay",
					details: null,
					color: "green",
					until: null,
				},
			});
			team89Map.set(999901, {
				id: 999901,
				name: "Alice",
				level: 40,
				status: {
					state: "Hospital",
					description: "In hospital",
					details: "Hospitalized by Bob",
					color: "red",
					until: futureUntil,
				},
			});

			const teamPlayersMap = new Map<
				number,
				Map<number, TornEliminationPlayerApiItem>
			>();
			teamPlayersMap.set(88, team88Map);
			teamPlayersMap.set(89, team89Map);

			// Running snapshot after restart should NOT count Alice as a new attack!
			const result = await processAttackSnapshot({
				capturedAt: new Date(),
				teamPlayersMap,
			});

			expect(result.detectedCount).toBe(0);
		});
	});
});
