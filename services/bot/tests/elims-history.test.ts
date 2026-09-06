import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, db, elimsItemRequests, eq } from "@sentinel/database";
import { getRequesterApprovedHistory } from "../src/lib/elims-item-requests";

describe("getRequesterApprovedHistory", () => {
	const testGuildId = `guild-test-${crypto.randomUUID()}`;
	const testUserId = `user-test-${crypto.randomUUID()}`;

	beforeAll(async () => {
		await db
			.delete(elimsItemRequests)
			.where(
				and(
					eq(elimsItemRequests.guildId, testGuildId),
					eq(elimsItemRequests.discordUserId, testUserId),
				),
			);
	});

	afterAll(async () => {
		await db
			.delete(elimsItemRequests)
			.where(
				and(
					eq(elimsItemRequests.guildId, testGuildId),
					eq(elimsItemRequests.discordUserId, testUserId),
				),
			);
	});

	test("returns 'None' when user has no previously approved requests", async () => {
		const liveHistory = await getRequesterApprovedHistory(
			testGuildId,
			testUserId,
			false,
		);
		expect(liveHistory.fieldName).toBe("Approved History");
		expect(liveHistory.fieldValue).toBe("None");

		const testHistory = await getRequesterApprovedHistory(
			testGuildId,
			testUserId,
			true,
		);
		expect(testHistory.fieldName).toBe("Approved History");
		expect(testHistory.fieldValue).toBe("None");
	});

	test("aggregates duplicate items into unified total and separates live from test", async () => {
		// Insert 2 live accepted requests for Xanax (5x and 5x)
		const [liveReq1] = await db
			.insert(elimsItemRequests)
			.values({
				guildId: testGuildId,
				discordUserId: testUserId,
				discordUsername: "Tester",
				itemId: "206",
				itemName: "Xanax",
				itemCategory: "Drugs",
				quantity: 5,
				status: "accepted",
				isTest: false,
			})
			.returning();

		await db.insert(elimsItemRequests).values({
			guildId: testGuildId,
			discordUserId: testUserId,
			discordUsername: "Tester",
			itemId: "206",
			itemName: "Xanax",
			itemCategory: "Drugs",
			quantity: 5,
			status: "accepted",
			isTest: false,
		});

		// Insert 1 live accepted request for Feathery Hotel Coupon (20x)
		await db.insert(elimsItemRequests).values({
			guildId: testGuildId,
			discordUserId: testUserId,
			discordUsername: "Tester",
			itemId: "367",
			itemName: "Feathery Hotel Coupon",
			itemCategory: "Boosters",
			quantity: 20,
			status: "accepted",
			isTest: false,
		});

		// Insert 1 test accepted request for Xanax (3x)
		await db.insert(elimsItemRequests).values({
			guildId: testGuildId,
			discordUserId: testUserId,
			discordUsername: "Tester",
			itemId: "206",
			itemName: "Xanax",
			itemCategory: "Drugs",
			quantity: 3,
			status: "accepted",
			isTest: true,
		});

		// Insert 1 rejected and 1 pending request which should NOT be counted
		await db.insert(elimsItemRequests).values({
			guildId: testGuildId,
			discordUserId: testUserId,
			discordUsername: "Tester",
			itemId: "206",
			itemName: "Xanax",
			itemCategory: "Drugs",
			quantity: 10,
			status: "pending",
			isTest: false,
		});

		await db.insert(elimsItemRequests).values({
			guildId: testGuildId,
			discordUserId: testUserId,
			discordUsername: "Tester",
			itemId: "206",
			itemName: "Xanax",
			itemCategory: "Drugs",
			quantity: 10,
			status: "rejected",
			isTest: false,
		});

		// Check live history: should show 10x Xanax (unified from 5+5) and 20x Feathery Hotel Coupon
		const liveHistory = await getRequesterApprovedHistory(
			testGuildId,
			testUserId,
			false,
		);
		expect(liveHistory.fieldName).toBe("Approved History");
		expect(liveHistory.fieldValue).toContain("• **10x** Xanax");
		expect(liveHistory.fieldValue).toContain("• **20x** Feathery Hotel Coupon");
		expect(liveHistory.fieldValue).toContain("**Total**: 30 items");

		// Check test history: should only show 3x Xanax
		const testHistory = await getRequesterApprovedHistory(
			testGuildId,
			testUserId,
			true,
		);
		expect(testHistory.fieldName).toBe("Approved History");
		expect(testHistory.fieldValue).toContain("• **3x** Xanax");
		expect(testHistory.fieldValue).toContain("**Total**: 3 items");
		expect(testHistory.fieldValue).not.toContain("Feathery Hotel Coupon");

		// When currentRequestId is passed, it excludes that specific request
		if (liveReq1) {
			const excludedHistory = await getRequesterApprovedHistory(
				testGuildId,
				testUserId,
				false,
				liveReq1.id,
			);
			expect(excludedHistory.fieldValue).toContain("• **5x** Xanax");
			expect(excludedHistory.fieldValue).toContain(
				"• **20x** Feathery Hotel Coupon",
			);
			expect(excludedHistory.fieldValue).toContain("**Total**: 25 items");
		}
	});
});
