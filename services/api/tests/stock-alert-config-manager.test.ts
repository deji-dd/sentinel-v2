import { afterEach, describe, expect, it } from "bun:test";
import { db, eq, guildStockAlertConfigs } from "@sentinel/database";
import { DEFAULT_GUILD_STOCK_ALERT_CONFIG } from "@sentinel/schemas";
import {
	guildStockAlertManager,
	StockAlertConfigError,
} from "../src/lib/stock-alert-config-manager";

/**
 * The manager is intentionally uncached, so these tests exercise the real
 * database rather than a test seam. Every rejection below is raised by validation
 * *before* anything is written, so the invalid cases never touch a real row.
 */

const GUILD_ID = "777666555444333222";

async function cleanup(): Promise<void> {
	await db
		.delete(guildStockAlertConfigs)
		.where(eq(guildStockAlertConfigs.guildId, GUILD_ID));
}

/** Writes a stored row directly, standing in for an earlier dashboard save. */
async function seed(
	patch: Partial<typeof guildStockAlertConfigs.$inferInsert> = {},
): Promise<void> {
	await db.insert(guildStockAlertConfigs).values({
		guildId: GUILD_ID,
		enabled: false,
		channelId: null,
		changeRules: [],
		highLowRanges: [],
		cooldownMinutes: 30,
		...patch,
	});
}

describe("GuildStockAlertConfigManager", () => {
	afterEach(async () => {
		await cleanup();
	});

	describe("defaults", () => {
		it("falls back to the factory defaults when nothing is stored", async () => {
			await cleanup();

			await expect(guildStockAlertManager.getConfig(GUILD_ID)).resolves.toEqual(
				DEFAULT_GUILD_STOCK_ALERT_CONFIG,
			);
		});

		it("never leaks one guild's settings into another", async () => {
			await seed({ enabled: true, channelId: "123456789012345678" });

			const other =
				await guildStockAlertManager.getConfig("777666555444333223");
			expect(other.enabled).toBe(false);
			expect(other.channelId).toBeNull();
		});
	});

	describe("validation", () => {
		it("rejects an unsupported change window", async () => {
			await expect(
				guildStockAlertManager.updateConfig(
					{ changeRules: [{ windowMinutes: 7, thresholdPct: 1 }] },
					"tester",
					GUILD_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("rejects two rules on the same window", async () => {
			await expect(
				guildStockAlertManager.updateConfig(
					{
						changeRules: [
							{ windowMinutes: 30, thresholdPct: 0.5 },
							{ windowMinutes: 30, thresholdPct: 1 },
						],
					},
					"tester",
					GUILD_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("rejects more rules than the worker honours", async () => {
			await expect(
				guildStockAlertManager.updateConfig(
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
					GUILD_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("rejects a threshold outside the supported range", async () => {
			await expect(
				guildStockAlertManager.updateConfig(
					{ changeRules: [{ windowMinutes: 30, thresholdPct: 0.001 }] },
					"tester",
					GUILD_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);

			await expect(
				guildStockAlertManager.updateConfig(
					{ changeRules: [{ windowMinutes: 30, thresholdPct: 900 }] },
					"tester",
					GUILD_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("accepts a large threshold, which only a long window can reach", async () => {
			const updated = await guildStockAlertManager.updateConfig(
				{ changeRules: [{ windowMinutes: 525_600, thresholdPct: 250 }] },
				"tester",
				GUILD_ID,
			);

			expect(updated.changeRules).toEqual([
				{ windowMinutes: 525_600, thresholdPct: 250 },
			]);
		});

		it("rejects an unknown high/low range", async () => {
			await expect(
				guildStockAlertManager.updateConfig(
					{ highLowRanges: ["24h", "last_week"] },
					"tester",
					GUILD_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("stores every valid range in canonical order regardless of request order", async () => {
			const updated = await guildStockAlertManager.updateConfig(
				{ highLowRanges: ["all_time", "1h", "30d", "24h"] },
				"tester",
				GUILD_ID,
			);

			expect(updated.highLowRanges).toEqual(["1h", "24h", "30d", "all_time"]);
		});

		it("rejects an implausible cooldown", async () => {
			await expect(
				guildStockAlertManager.updateConfig(
					{ cooldownMinutes: -5 },
					"tester",
					GUILD_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);

			await expect(
				guildStockAlertManager.updateConfig(
					{ cooldownMinutes: 5000 },
					"tester",
					GUILD_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("rejects a malformed channel snowflake", async () => {
			await expect(
				guildStockAlertManager.updateConfig(
					{ channelId: "general" },
					"tester",
					GUILD_ID,
				),
			).rejects.toBeInstanceOf(StockAlertConfigError);
		});

		it("accepts null as an unrouted channel", async () => {
			await seed({ enabled: true, channelId: "123456789012345678" });

			const updated = await guildStockAlertManager.updateConfig(
				{ channelId: null },
				"tester",
				GUILD_ID,
			);

			expect(updated.channelId).toBeNull();
			expect(updated.enabled).toBe(true);
		});
	});

	describe("merging and persistence", () => {
		it("merges a partial patch and keeps the untouched fields", async () => {
			await seed({
				enabled: false,
				channelId: "123456789012345678",
				changeRules: [{ windowMinutes: 30, thresholdPct: 0.5 }],
				highLowRanges: ["24h"],
				cooldownMinutes: 30,
			});

			const updated = await guildStockAlertManager.updateConfig(
				{ enabled: true },
				"tester",
				GUILD_ID,
			);

			expect(updated.enabled).toBe(true);
			expect(updated.channelId).toBe("123456789012345678");
			expect(updated.changeRules).toEqual([
				{ windowMinutes: 30, thresholdPct: 0.5 },
			]);
			expect(updated.highLowRanges).toEqual(["24h"]);
			expect(updated.cooldownMinutes).toBe(30);
			expect(updated.updatedBy).toBe("tester");

			const [row] = await db
				.select()
				.from(guildStockAlertConfigs)
				.where(eq(guildStockAlertConfigs.guildId, GUILD_ID));
			expect(row?.enabled).toBe(true);

			// Read-through: a fresh read sees the write without any cache being
			// invalidated, which is what makes a second API replica safe.
			const reloaded = await guildStockAlertManager.getConfig(GUILD_ID);
			expect(reloaded.enabled).toBe(true);
		});

		it("creates the row for a guild that was never configured", async () => {
			await cleanup();

			const updated = await guildStockAlertManager.updateConfig(
				{ enabled: true, channelId: "123456789012345678" },
				"tester",
				GUILD_ID,
			);

			expect(updated.enabled).toBe(true);

			const rows = await db
				.select()
				.from(guildStockAlertConfigs)
				.where(eq(guildStockAlertConfigs.guildId, GUILD_ID));
			expect(rows).toHaveLength(1);
		});
	});
});
