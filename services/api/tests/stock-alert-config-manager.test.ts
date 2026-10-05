import { afterEach, describe, expect, it } from "bun:test";
import { db, eq, subversiveStockAlertConfigs } from "@sentinel/database";
import { DEFAULT_SUBVERSIVE_STOCK_ALERT_CONFIG } from "@sentinel/schemas";
import {
	StockAlertConfigError,
	subversiveStockAlertManager,
} from "../src/lib/stock-alert-config-manager";

/**
 * Every rejection below is raised by validation *before* anything is written, so
 * the invalid cases never touch the real configuration rows.
 */

const FACTION_ID = 27312;

async function cleanup(): Promise<void> {
	await db
		.delete(subversiveStockAlertConfigs)
		.where(eq(subversiveStockAlertConfigs.factionId, FACTION_ID));
	subversiveStockAlertManager.clearCacheForTesting();
}

describe("SubversiveStockAlertConfigManager", () => {
	afterEach(async () => {
		await cleanup();
	});

	describe("defaults", () => {
		it("falls back to the factory defaults when nothing is stored", () => {
			subversiveStockAlertManager.clearCacheForTesting();
			subversiveStockAlertManager.setConfigForTesting();

			expect(subversiveStockAlertManager.getCachedConfig(FACTION_ID)).toEqual(
				DEFAULT_SUBVERSIVE_STOCK_ALERT_CONFIG,
			);
		});

		it("resolves an unknown faction id to the primary family faction", async () => {
			subversiveStockAlertManager.clearCacheForTesting();
			subversiveStockAlertManager.setFactionConfigForTesting(2013, {
				enabled: true,
				channelId: "123456789012345678",
			});

			const config = await subversiveStockAlertManager.getConfig(999_999);
			expect(config.enabled).toBe(true);
			expect(config.channelId).toBe("123456789012345678");
		});
	});

	describe("validation", () => {
		it("rejects an unsupported change window", async () => {
			subversiveStockAlertManager.setConfigForTesting();

			expect(
				subversiveStockAlertManager.updateConfig(
					{ changeRules: [{ windowMinutes: 7, thresholdPct: 1 }] },
					"tester",
					FACTION_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("rejects two rules on the same window", async () => {
			subversiveStockAlertManager.setConfigForTesting();

			expect(
				subversiveStockAlertManager.updateConfig(
					{
						changeRules: [
							{ windowMinutes: 30, thresholdPct: 0.5 },
							{ windowMinutes: 30, thresholdPct: 1 },
						],
					},
					"tester",
					FACTION_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("rejects more rules than the worker honours", async () => {
			subversiveStockAlertManager.setConfigForTesting();

			expect(
				subversiveStockAlertManager.updateConfig(
					{
						changeRules: [
							{ windowMinutes: 5, thresholdPct: 1 },
							{ windowMinutes: 10, thresholdPct: 1 },
							{ windowMinutes: 15, thresholdPct: 1 },
							{ windowMinutes: 20, thresholdPct: 1 },
							{ windowMinutes: 30, thresholdPct: 1 },
							{ windowMinutes: 45, thresholdPct: 1 },
							{ windowMinutes: 60, thresholdPct: 1 },
						],
					},
					"tester",
					FACTION_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("rejects a threshold outside the supported range", async () => {
			subversiveStockAlertManager.setConfigForTesting();

			expect(
				subversiveStockAlertManager.updateConfig(
					{ changeRules: [{ windowMinutes: 30, thresholdPct: 0.001 }] },
					"tester",
					FACTION_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);

			expect(
				subversiveStockAlertManager.updateConfig(
					{ changeRules: [{ windowMinutes: 30, thresholdPct: 90 }] },
					"tester",
					FACTION_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("rejects an unknown high/low window", async () => {
			subversiveStockAlertManager.setConfigForTesting();

			expect(
				subversiveStockAlertManager.updateConfig(
					{ highLowWindows: ["24h", "last_week"] },
					"tester",
					FACTION_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("rejects an implausible cooldown", async () => {
			subversiveStockAlertManager.setConfigForTesting();

			expect(
				subversiveStockAlertManager.updateConfig(
					{ cooldownMinutes: -5 },
					"tester",
					FACTION_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);

			expect(
				subversiveStockAlertManager.updateConfig(
					{ cooldownMinutes: 5000 },
					"tester",
					FACTION_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("rejects a malformed channel snowflake", async () => {
			subversiveStockAlertManager.setConfigForTesting();

			expect(
				subversiveStockAlertManager.updateConfig(
					{ channelId: "general" },
					"tester",
					FACTION_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("accepts null as an unrouted channel", async () => {
			subversiveStockAlertManager.clearCacheForTesting();
			subversiveStockAlertManager.setFactionConfigForTesting(FACTION_ID, {
				enabled: true,
				channelId: "123456789012345678",
			});

			const updated = await subversiveStockAlertManager.updateConfig(
				{ channelId: null },
				"tester",
				FACTION_ID,
			);

			expect(updated.channelId).toBeNull();
			expect(updated.enabled).toBe(true);
		});
	});

	describe("merging and persistence", () => {
		it("merges a partial patch and keeps the untouched fields", async () => {
			subversiveStockAlertManager.clearCacheForTesting();
			subversiveStockAlertManager.setFactionConfigForTesting(FACTION_ID, {
				enabled: false,
				channelId: "123456789012345678",
				changeRules: [{ windowMinutes: 30, thresholdPct: 0.5 }],
				highLowWindows: ["24h"],
				cooldownMinutes: 30,
			});

			const updated = await subversiveStockAlertManager.updateConfig(
				{ enabled: true },
				"tester",
				FACTION_ID,
			);

			expect(updated.enabled).toBe(true);
			expect(updated.channelId).toBe("123456789012345678");
			expect(updated.changeRules).toEqual([
				{ windowMinutes: 30, thresholdPct: 0.5 },
			]);
			expect(updated.highLowWindows).toEqual(["24h"]);
			expect(updated.cooldownMinutes).toBe(30);
			expect(updated.updatedBy).toBe("tester");

			// Persisted, and served from the refreshed cache afterwards.
			const [row] = await db
				.select()
				.from(subversiveStockAlertConfigs)
				.where(eq(subversiveStockAlertConfigs.factionId, FACTION_ID));
			expect(row?.enabled).toBe(true);

			const cached = subversiveStockAlertManager.getCachedConfig(FACTION_ID);
			expect(cached.enabled).toBe(true);
		});
	});
});
