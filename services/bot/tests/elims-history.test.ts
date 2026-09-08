import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, db, elimsItemRequests, eq } from "@sentinel/database";
import {
	getRequesterApprovedHistory,
	getRequesterRejectedHistory,
	getXanaxCooldownStatus,
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

describe("getRequesterRejectedHistory", () => {
	const testGuildId = `guild-rej-${crypto.randomUUID()}`;
	const testUserId = `user-rej-${crypto.randomUUID()}`;

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

	test("returns 'None' when user has no previously rejected requests", async () => {
		const res = await getRequesterRejectedHistory(
			testGuildId,
			testUserId,
			false,
		);
		expect(res.fieldName).toBe("Rejected History");
		expect(res.fieldValue).toBe("None");
	});

	test("aggregates duplicate rejected items into unified total", async () => {
		// Insert 2 rejected requests for Xanax (2x and 3x)
		await db.insert(elimsItemRequests).values([
			{
				guildId: testGuildId,
				discordUserId: testUserId,
				discordUsername: "RejTester",
				itemId: "206",
				itemName: "Xanax",
				itemCategory: "Drugs",
				quantity: 2,
				status: "rejected",
				isTest: false,
			},
			{
				guildId: testGuildId,
				discordUserId: testUserId,
				discordUsername: "RejTester",
				itemId: "206",
				itemName: "Xanax",
				itemCategory: "Drugs",
				quantity: 3,
				status: "rejected",
				isTest: false,
			},
			// Accepted request should NOT appear in rejected history
			{
				guildId: testGuildId,
				discordUserId: testUserId,
				discordUsername: "RejTester",
				itemId: "367",
				itemName: "Feathery Hotel Coupon",
				itemCategory: "Boosters",
				quantity: 10,
				status: "accepted",
				isTest: false,
			},
		]);

		const res = await getRequesterRejectedHistory(
			testGuildId,
			testUserId,
			false,
		);
		expect(res.fieldName).toBe("Rejected History");
		expect(res.fieldValue).toContain("• **5x** Xanax");
		expect(res.fieldValue).toContain("**Total**: 5 items");
		expect(res.fieldValue).not.toContain("Feathery Hotel Coupon");
	});
});

describe("getXanaxCooldownStatus", () => {
	const testGuildId = `guild-xanax-${crypto.randomUUID()}`;
	const testUserId = `user-xanax-${crypto.randomUUID()}`;
	const testAltUserId = `user-alt-xanax-${crypto.randomUUID()}`;
	const sharedTornId = 1234567;

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

	test("returns isOnCooldown: false when user has no accepted Xanax requests", async () => {
		const res = await getXanaxCooldownStatus({
			guildId: testGuildId,
			discordUserId: testUserId,
		});
		expect(res.isOnCooldown).toBe(false);
	});

	test("enforces 6 hours per Xanax: 1 Xanax = 6 hours", async () => {
		const baseTime = new Date("2026-09-08T12:00:00Z");

		await db.insert(elimsItemRequests).values({
			guildId: testGuildId,
			discordUserId: testUserId,
			discordUsername: "XanaxUser",
			itemId: "206",
			itemName: "Xanax",
			itemCategory: "Drugs",
			quantity: 1,
			status: "accepted",
			isTest: false,
			handledAt: baseTime,
			createdAt: baseTime,
		});

		// At 1 hour later: still on cooldown
		const check1h = await getXanaxCooldownStatus({
			guildId: testGuildId,
			discordUserId: testUserId,
			now: new Date("2026-09-08T13:00:00Z"),
		});
		expect(check1h.isOnCooldown).toBe(true);
		expect(check1h.cooldownExpiresAt).toEqual(new Date("2026-09-08T18:00:00Z"));
		expect(check1h.remainingMs).toBe(5 * 60 * 60 * 1000);

		// At 6 hours later: cooldown expired
		const check6h = await getXanaxCooldownStatus({
			guildId: testGuildId,
			discordUserId: testUserId,
			now: new Date("2026-09-08T18:00:01Z"),
		});
		expect(check6h.isOnCooldown).toBe(false);
	});

	test("enforces 6 hours per Xanax: 3 Xanax = 18 hours", async () => {
		await db
			.delete(elimsItemRequests)
			.where(eq(elimsItemRequests.guildId, testGuildId));

		const baseTime = new Date("2026-09-08T10:00:00Z");

		await db.insert(elimsItemRequests).values({
			guildId: testGuildId,
			discordUserId: testUserId,
			discordUsername: "XanaxUser",
			tornId: sharedTornId,
			itemId: "206",
			itemName: "Xanax",
			itemCategory: "Drugs",
			quantity: 3,
			status: "accepted",
			isTest: false,
			handledAt: baseTime,
			createdAt: baseTime,
		});

		// At 10 hours later: still on cooldown (8 hours remaining)
		const check10h = await getXanaxCooldownStatus({
			guildId: testGuildId,
			discordUserId: testUserId,
			now: new Date("2026-09-08T20:00:00Z"),
		});
		expect(check10h.isOnCooldown).toBe(true);
		// 10:00 + 18h = 04:00 next day
		expect(check10h.cooldownExpiresAt).toEqual(
			new Date("2026-09-09T04:00:00Z"),
		);
		expect(check10h.remainingMs).toBe(8 * 60 * 60 * 1000);

		// Anti-alt check: different Discord account with same Torn ID is ALSO on cooldown
		const checkAlt = await getXanaxCooldownStatus({
			guildId: testGuildId,
			discordUserId: testAltUserId,
			tornId: sharedTornId,
			now: new Date("2026-09-08T20:00:00Z"),
		});
		expect(checkAlt.isOnCooldown).toBe(true);
		expect(checkAlt.cooldownExpiresAt).toEqual(
			new Date("2026-09-09T04:00:00Z"),
		);

		// At 19 hours later: cooldown has expired
		const check19h = await getXanaxCooldownStatus({
			guildId: testGuildId,
			discordUserId: testUserId,
			now: new Date("2026-09-09T05:00:00Z"),
		});
		expect(check19h.isOnCooldown).toBe(false);
	});

	test("chains consecutive approvals: 2 Xanax + 1 Xanax = 18 hours total", async () => {
		await db
			.delete(elimsItemRequests)
			.where(eq(elimsItemRequests.guildId, testGuildId));

		const t0 = new Date("2026-09-08T10:00:00Z");
		const t1 = new Date("2026-09-08T14:00:00Z"); // 4 hours into request 1's 12h cooldown

		// Request 1: 2 Xanax (12 hours: 10:00 -> 22:00)
		await db.insert(elimsItemRequests).values({
			guildId: testGuildId,
			discordUserId: testUserId,
			discordUsername: "XanaxUser",
			itemId: "206",
			itemName: "Xanax",
			itemCategory: "Drugs",
			quantity: 2,
			status: "accepted",
			isTest: false,
			handledAt: t0,
			createdAt: t0,
		});

		// Request 2: 1 Xanax approved at 14:00 (chains from 22:00 -> 04:00 next day)
		await db.insert(elimsItemRequests).values({
			guildId: testGuildId,
			discordUserId: testUserId,
			discordUsername: "XanaxUser",
			itemId: "206",
			itemName: "Xanax",
			itemCategory: "Drugs",
			quantity: 1,
			status: "accepted",
			isTest: false,
			handledAt: t1,
			createdAt: t1,
		});

		// Check at 23:00 (after first request's 12h, but during chained 6h)
		const check23h = await getXanaxCooldownStatus({
			guildId: testGuildId,
			discordUserId: testUserId,
			now: new Date("2026-09-08T23:00:00Z"),
		});
		expect(check23h.isOnCooldown).toBe(true);
		expect(check23h.cooldownExpiresAt).toEqual(
			new Date("2026-09-09T04:00:00Z"),
		);
		expect(check23h.remainingMs).toBe(5 * 60 * 60 * 1000);
	});

	test("applies retroactively to past requests before this update without handledAt", async () => {
		await db
			.delete(elimsItemRequests)
			.where(eq(elimsItemRequests.guildId, testGuildId));

		const pastTime = new Date("2026-09-08T08:00:00Z");

		// Historical record before handledAt was populated (fallback to createdAt)
		await db.insert(elimsItemRequests).values({
			guildId: testGuildId,
			discordUserId: testUserId,
			discordUsername: "XanaxUser",
			itemId: "206",
			itemName: "Xanax",
			itemCategory: "Drugs",
			quantity: 2,
			status: "accepted",
			isTest: false,
			handledAt: null,
			createdAt: pastTime,
			updatedAt: pastTime,
		});

		// 2 Xanax = 12h from 08:00 = 20:00
		const check = await getXanaxCooldownStatus({
			guildId: testGuildId,
			discordUserId: testUserId,
			now: new Date("2026-09-08T15:00:00Z"),
		});
		expect(check.isOnCooldown).toBe(true);
		expect(check.cooldownExpiresAt).toEqual(new Date("2026-09-08T20:00:00Z"));
	});

	test("rejected or pending requests do not trigger Xanax cooldown", async () => {
		await db
			.delete(elimsItemRequests)
			.where(eq(elimsItemRequests.guildId, testGuildId));

		const now = new Date("2026-09-08T12:00:00Z");

		await db.insert(elimsItemRequests).values([
			{
				guildId: testGuildId,
				discordUserId: testUserId,
				discordUsername: "XanaxUser",
				itemId: "206",
				itemName: "Xanax",
				itemCategory: "Drugs",
				quantity: 5,
				status: "rejected",
				isTest: false,
				handledAt: now,
				createdAt: now,
			},
			{
				guildId: testGuildId,
				discordUserId: testUserId,
				discordUsername: "XanaxUser",
				itemId: "206",
				itemName: "Xanax",
				itemCategory: "Drugs",
				quantity: 5,
				status: "pending",
				isTest: false,
				createdAt: now,
			},
		]);

		const check = await getXanaxCooldownStatus({
			guildId: testGuildId,
			discordUserId: testUserId,
			now: new Date("2026-09-08T13:00:00Z"),
		});
		expect(check.isOnCooldown).toBe(false);
	});
});
