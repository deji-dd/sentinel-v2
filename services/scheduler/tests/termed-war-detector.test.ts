import { describe, expect, it } from "bun:test";
import {
	detectTermedWar,
	type RankedWarFactionReport,
} from "../src/workers/subversive/termed-war-detector";

describe("detectTermedWar", () => {
	it("identifies a genuine competitive war as not termed", () => {
		const competitiveWarFactions: RankedWarFactionReport[] = [
			{
				id: 101,
				name: "Hardcore Brawlers",
				attacks: 571,
				score: 4076,
				members: [
					{ id: 1, name: "Alpha", level: 50, attacks: 85, score: 900 },
					{ id: 2, name: "Bravo", level: 45, attacks: 68, score: 700 },
					{ id: 3, name: "Charlie", level: 30, attacks: 45, score: 400 },
					{ id: 4, name: "Delta", level: 25, attacks: 26, score: 250 },
					{ id: 5, name: "Echo", level: 20, attacks: 19, score: 180 },
					{ id: 6, name: "Foxtrot", level: 15, attacks: 10, score: 90 },
					{ id: 7, name: "Golf", level: 10, attacks: 4, score: 30 },
					{ id: 8, name: "Hotel", level: 10, attacks: 0, score: 0 },
				],
			},
			{
				id: 102,
				name: "Rival Syndicate",
				attacks: 307,
				score: 1423,
				members: [
					{ id: 9, name: "India", level: 60, attacks: 60, score: 500 },
					{ id: 10, name: "Juliet", level: 40, attacks: 36, score: 300 },
					{ id: 11, name: "Kilo", level: 35, attacks: 25, score: 200 },
					{ id: 12, name: "Lima", level: 28, attacks: 14, score: 100 },
					{ id: 13, name: "Mike", level: 18, attacks: 6, score: 40 },
				],
			},
		];

		const result = detectTermedWar(competitiveWarFactions);
		expect(result.isTermed).toBe(false);
		expect(result.reason).toBeNull();
	});

	it("detects a termed war where 75% of members hit a 25-hit quota", () => {
		const termedWarFactions: RankedWarFactionReport[] = [
			{
				id: 201,
				name: "Arranged Truce Fac",
				attacks: 255,
				score: 1500,
				members: [
					{ id: 1, name: "P1", level: 40, attacks: 25, score: 200 },
					{ id: 2, name: "P2", level: 40, attacks: 26, score: 200 },
					{ id: 3, name: "P3", level: 40, attacks: 24, score: 200 },
					{ id: 4, name: "P4", level: 40, attacks: 25, score: 200 },
					{ id: 5, name: "P5", level: 40, attacks: 25, score: 200 },
					{ id: 6, name: "P6", level: 40, attacks: 27, score: 200 },
					{ id: 7, name: "P7", level: 40, attacks: 24, score: 200 },
					{ id: 8, name: "P8", level: 40, attacks: 80, score: 600 }, // leader/outlier
				],
			},
		];

		const result = detectTermedWar(termedWarFactions);
		expect(result.isTermed).toBe(true);
		expect(result.reason).toContain("Arranged Truce Fac");
		expect(result.reason).toContain("clustered in [23, 27] hits");
	});

	it("handles factions with fewer than minimum active hitters gracefully", () => {
		const smallWarFactions: RankedWarFactionReport[] = [
			{
				id: 301,
				name: "Tiny Fac",
				attacks: 10,
				score: 100,
				members: [{ id: 1, name: "Solo", level: 20, attacks: 10, score: 100 }],
			},
		];

		const result = detectTermedWar(smallWarFactions);
		expect(result.isTermed).toBe(false);
	});
});
