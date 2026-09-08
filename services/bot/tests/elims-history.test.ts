import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, db, elimsItemRequests, eq } from "@sentinel/database";
import {
	getRequesterApprovedHistory,
	hasPendingItemRequest,
} from "../src/lib/elims-item-requests";

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

describe("hasPendingItemRequest guard", () => {
	const testGuildId = `guild-guard-${crypto.randomUUID()}`;
	const testUserId = `user-guard-${crypto.randomUUID()}`;
	const testAltUserId = `user-alt-${crypto.randomUUID()}`;
	const sharedTornId = 998877;

	beforeAll(async () => {
		await db
			.delete(elimsItemRequests)
			.where(eq(elimsItemRequests.guildId, testGuildId));
	});

	afterAll(async () => {
		await db
			.delete(elimsItemRequests)
			.where(eq(elimsItemRequests.guildId, testGuildId));
	});

	test("returns hasPending: false when user has no requests", async () => {
		const res = await hasPendingItemRequest({
			guildId: testGuildId,
			discordUserId: testUserId,
			itemId: "206",
		});
		expect(res.hasPending).toBe(false);
	});

	test("returns hasPending: true when user already has a pending request for the same item", async () => {
		const [created] = await db
			.insert(elimsItemRequests)
			.values({
				guildId: testGuildId,
				discordUserId: testUserId,
				discordUsername: "GuardUser",
				tornId: sharedTornId,
				tornName: "GuardTornUser",
				itemId: "206",
				itemName: "Xanax",
				itemCategory: "Drugs",
				quantity: 5,
				status: "pending",
				isTest: false,
			})
			.returning();

		const checkSameItem = await hasPendingItemRequest({
			guildId: testGuildId,
			discordUserId: testUserId,
			itemId: "206",
		});
		expect(checkSameItem.hasPending).toBe(true);
		expect(checkSameItem.existingRequestId).toBe(created?.id);

		// Different item should NOT be blocked
		const checkDifferentItem = await hasPendingItemRequest({
			guildId: testGuildId,
			discordUserId: testUserId,
			itemId: "367", // Flash Grenade
		});
		expect(checkDifferentItem.hasPending).toBe(false);

		// Anti-alt guard: same Torn ID on different Discord account should ALSO be blocked
		const checkAltAccount = await hasPendingItemRequest({
			guildId: testGuildId,
			discordUserId: testAltUserId,
			itemId: "206",
			tornId: sharedTornId,
		});
		expect(checkAltAccount.hasPending).toBe(true);
		expect(checkAltAccount.existingRequestId).toBe(created?.id);
	});

	test("returns hasPending: false once request is accepted or rejected", async () => {
		// Update status to accepted
		await db
			.update(elimsItemRequests)
			.set({ status: "accepted" })
			.where(
				and(
					eq(elimsItemRequests.guildId, testGuildId),
					eq(elimsItemRequests.discordUserId, testUserId),
					eq(elimsItemRequests.itemId, "206"),
				),
			);

		const checkAfterAccepted = await hasPendingItemRequest({
			guildId: testGuildId,
			discordUserId: testUserId,
			itemId: "206",
		});
		expect(checkAfterAccepted.hasPending).toBe(false);

		// Update status to rejected
		await db
			.update(elimsItemRequests)
			.set({ status: "rejected" })
			.where(
				and(
					eq(elimsItemRequests.guildId, testGuildId),
					eq(elimsItemRequests.discordUserId, testUserId),
					eq(elimsItemRequests.itemId, "206"),
				),
			);

		const checkAfterRejected = await hasPendingItemRequest({
			guildId: testGuildId,
			discordUserId: testUserId,
			itemId: "206",
		});
		expect(checkAfterRejected.hasPending).toBe(false);
	});

	test("distinguishes live and test requests", async () => {
		// Insert test request for item 500
		await db.insert(elimsItemRequests).values({
			guildId: testGuildId,
			discordUserId: testUserId,
			discordUsername: "GuardUser",
			itemId: "500",
			itemName: "TestItem",
			itemCategory: "General",
			quantity: 1,
			status: "pending",
			isTest: true,
		});

		// Live check for item 500 should be false
		const checkLive = await hasPendingItemRequest({
			guildId: testGuildId,
			discordUserId: testUserId,
			itemId: "500",
			isTest: false,
		});
		expect(checkLive.hasPending).toBe(false);

		// Test check for item 500 should be true
		const checkTest = await hasPendingItemRequest({
			guildId: testGuildId,
			discordUserId: testUserId,
			itemId: "500",
			isTest: true,
		});
		expect(checkTest.hasPending).toBe(true);
	});
});
