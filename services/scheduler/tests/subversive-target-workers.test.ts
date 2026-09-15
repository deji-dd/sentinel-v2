import { describe, expect, it, spyOn } from "bun:test";
import * as databaseModule from "@sentinel/database";
import * as tornApiModule from "@sentinel/torn-api";
import { crawlFFScouterTargets } from "../src/workers/subversive/ffscouter-target-crawler";
import { ingestDailyUserSnapshot } from "../src/workers/subversive/snapshot-ingestion-worker";
import * as keyPoolModule from "../src/workers/subversive/subversive-key-pool";
import { runTargetFinderCycle } from "../src/workers/subversive/target-finder-worker";
import { computeScoreFromEstimate } from "../src/workers/subversive/target-utils";

describe("Subversive Target Finder Workers & Key Pool", () => {
	it("computeScoreFromEstimate correctly calculates score with distribution and fallback", () => {
		// Default 50/50 balanced fallback: 2 * sqrt(10000) = 200
		const defaultScore = computeScoreFromEstimate(10000, null);
		expect(defaultScore).toBe(200);

		// With distribution: 25% str, 25% spd, 25% def, 25% dex = 4 * sqrt(2500) = 4 * 50 = 200
		const distScore = computeScoreFromEstimate(10000, {
			stats_percentage: {
				strength: 25,
				speed: 25,
				defense: 25,
				dexterity: 25,
			},
		});
		expect(distScore).toBe(200);

		// Zero or negative returns 0
		expect(computeScoreFromEstimate(0, null)).toBe(0);
		expect(computeScoreFromEstimate(-100, null)).toBe(0);
		expect(computeScoreFromEstimate(null, null)).toBe(0);
	});

	it("SubversiveKeyPool stays dormant when no active user keys are enrolled", async () => {
		const keySpy = spyOn(
			keyPoolModule,
			"hasActiveSubversiveKeys",
		).mockImplementation(async () => false);

		try {
			// Workers dependent on user keys should immediately return 0 and not throw
			const snapshotCount = await ingestDailyUserSnapshot();
			expect(snapshotCount).toBe(0);

			// Cycle should return cleanly without making API calls
			await runTargetFinderCycle();
		} finally {
			keySpy.mockRestore();
		}
	});

	it("crawlFFScouterTargets operates with FF_SCOUTER_KEY independent of user key pool", async () => {
		const origKey = process.env.FF_SCOUTER_KEY;
		process.env.FF_SCOUTER_KEY = "test_key_123456";

		const ffSpy = spyOn(
			tornApiModule,
			"getFFScouterTargets",
		).mockImplementation(async () => [
			{
				player_id: 999111,
				name: "ScoutedTarget",
				level: 50,
				bs_estimate: 250000,
				fair_fight: 2.1,
				faction_id: 1234,
				faction_name: "Some Faction",
				last_action: new Date(Date.now() - 30 * 86400000).toISOString(),
			},
		]);

		try {
			const count = await crawlFFScouterTargets();
			expect(count).toBe(1);

			const [saved] = await databaseModule.db
				.select()
				.from(databaseModule.subversiveTargetFinderTargets)
				.where(
					databaseModule.eq(
						databaseModule.subversiveTargetFinderTargets.targetId,
						999111,
					),
				);

			expect(saved).toBeDefined();
			expect(saved?.name).toBe("ScoutedTarget");
			expect(saved?.level).toBe(50);
			expect(saved?.estimatedScore).toBeGreaterThan(0);
			expect(saved?.inHospital).toBe(false);
		} finally {
			process.env.FF_SCOUTER_KEY = origKey;
			ffSpy.mockRestore();
			// Cleanup test row
			await databaseModule.db
				.delete(databaseModule.subversiveTargetFinderTargets)
				.where(
					databaseModule.eq(
						databaseModule.subversiveTargetFinderTargets.targetId,
						999111,
					),
				);
		}
	});

	it("SubversiveKeyPool falls back to load balance with system keys when only 1 user key is available", async () => {
		const userKeysSpy = spyOn(
			keyPoolModule,
			"getSubversiveUserKeys",
		).mockImplementation(async () => [
			{ apiKey: "1111222233334444", userId: 12345, keyType: "custom" },
		]);

		const systemKeysSpy = spyOn(
			tornApiModule,
			"getActiveSystemKeyPool",
		).mockImplementation(async () => [
			{ apiKey: "9999888877776666", userId: 99999, keyType: "system" },
		]);

		try {
			// First call gets user key
			const key1 = await keyPoolModule.getNextSubversiveUserKey();
			expect(key1).not.toBeNull();

			// Second call gets system key (round-robin load balanced across user + system)
			const key2 = await keyPoolModule.getNextSubversiveUserKey();
			expect(key2).not.toBeNull();

			const keys = [key1?.apiKey, key2?.apiKey];
			expect(keys).toContain("1111222233334444");
			expect(keys).toContain("9999888877776666");
		} finally {
			userKeysSpy.mockRestore();
			systemKeysSpy.mockRestore();
		}
	});

	it("SubversiveKeyPool suppresses temporarily disabled keys in-memory", async () => {
		const userKeysSpy = spyOn(
			keyPoolModule,
			"getSubversiveUserKeys",
		).mockImplementation(async () => [
			{ apiKey: "disabled_key_1111", userId: 12345, keyType: "custom" },
			{ apiKey: "healthy_key_2222", userId: 67890, keyType: "custom" },
		]);

		try {
			// Mark first key as disabled
			keyPoolModule.markSubversiveKeyDisabled("disabled_key_1111", 13);
			expect(
				keyPoolModule.subversiveKeyHealthManager.isKeyTemporarilyDisabled(
					"disabled_key_1111",
				),
			).toBe(true);

			// getNextSubversiveUserKey should skip the disabled key and return the healthy key
			const selected = await keyPoolModule.getNextSubversiveUserKey();
			expect(selected?.apiKey).toBe("healthy_key_2222");
		} finally {
			userKeysSpy.mockRestore();
		}
	});
});
