import { beforeEach, describe, expect, test } from "bun:test";
import {
	db,
	eq,
	like,
	travelDestinations,
	verificationLogs,
	warLedgers,
} from "@sentinel/database";
import { executeMaintenance } from "../src/workers/system/maintenance";

describe("System Maintenance Worker", () => {
	const TEST_WAR_OLD = "WAR_TEST_OLD_90D";
	const TEST_WAR_FRESH = "WAR_TEST_FRESH_10D";
	const TEST_LOG_OLD = "LOG_TEST_OLD_30D";
	const TEST_LOG_FRESH = "LOG_TEST_FRESH_5D";
	const TEST_DEST_ID = "TEST_DEST_HAWAII";

	beforeEach(async () => {
		// Clean test records
		await db.delete(warLedgers).where(like(warLedgers.id, "WAR_TEST_%"));
		await db.delete(verificationLogs).where(like(verificationLogs.id, "LOG_TEST_%"));
		await db.delete(travelDestinations).where(eq(travelDestinations.id, TEST_DEST_ID));

		const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
		const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

		// 1. Insert WarLedgers (1 old finished, 1 fresh finished)
		await db.insert(warLedgers).values([
			{
				id: TEST_WAR_OLD,
				tt: "PAR",
				assaultingFaction: 1,
				defendingFaction: 2,
				startTime: hundredDaysAgo,
				endTime: hundredDaysAgo,
			},
			{
				id: TEST_WAR_FRESH,
				tt: "PAR2",
				assaultingFaction: 1,
				defendingFaction: 2,
				startTime: tenDaysAgo,
				endTime: tenDaysAgo,
			},
		]);

		// 2. Insert VerificationLogs (1 old, 1 fresh)
		await db.insert(verificationLogs).values([
			{
				id: TEST_LOG_OLD,
				guildId: "g1",
				discordId: "d1",
				status: "success",
				createdAt: fortyDaysAgo,
			},
			{
				id: TEST_LOG_FRESH,
				guildId: "g1",
				discordId: "d2",
				status: "success",
				createdAt: fiveDaysAgo,
			},
		]);

		// 3. Insert TravelDestination with old (30h ago) and fresh (1h ago) stock history
		const thirtyHoursAgo = Date.now() - 30 * 60 * 60 * 1000;
		const oneHourAgo = Date.now() - 1 * 60 * 60 * 1000;

		await db.insert(travelDestinations).values({
			id: TEST_DEST_ID,
			name: "Hawaii",
			stocks: [
				{
					id: 101,
					name: "Plumeria Flower",
					quantity: 50,
					cost: 100,
					history: [
						{ timestamp: thirtyHoursAgo, quantity: 100 },
						{ timestamp: oneHourAgo, quantity: 50 },
					],
				},
			],
		});
	});

	test("prunes WarLedger > 90d, VerificationLogs > 30d, and travel stock history > 24h", async () => {
		await executeMaintenance();

		// Verify old war was pruned, fresh war remains
		const oldWar = await db.query.warLedgers.findFirst({
			where: eq(warLedgers.id, TEST_WAR_OLD),
		});
		const freshWar = await db.query.warLedgers.findFirst({
			where: eq(warLedgers.id, TEST_WAR_FRESH),
		});

		expect(oldWar).toBeUndefined();
		expect(freshWar).toBeDefined();

		// Verify old verification log was pruned, fresh log remains
		const oldLog = await db.query.verificationLogs.findFirst({
			where: eq(verificationLogs.id, TEST_LOG_OLD),
		});
		const freshLog = await db.query.verificationLogs.findFirst({
			where: eq(verificationLogs.id, TEST_LOG_FRESH),
		});

		expect(oldLog).toBeUndefined();
		expect(freshLog).toBeDefined();

		// Verify travel stock history older than 24h was pruned
		const dest = await db.query.travelDestinations.findFirst({
			where: eq(travelDestinations.id, TEST_DEST_ID),
		});

		expect(dest).toBeDefined();
		if (dest) {
			const stocks = dest.stocks as unknown as { history: { timestamp: number }[] }[];
			const history = stocks[0]?.history ?? [];
			expect(history.length).toBe(1);
		}
	});
});
