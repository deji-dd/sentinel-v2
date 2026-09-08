import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	assignStockToHolder,
	db,
	deductHolderStock,
	elimsArmoryDeposits,
	elimsStockHolders,
	eq,
	getStockHolders,
	getUnassignedStock,
	reclaimStockFromHolder,
} from "@sentinel/database";
import { resolveTornItem } from "../src/lib/elims-armory-storage";
import { buildStockHolderItemEmbed } from "../src/lib/elims-stock-holders";

describe("Elims Stock Holders Module", () => {
	const testGuildId = `guild-sh-test-${crypto.randomUUID()}`;
	const holder1Id = `user-holder-1-${crypto.randomUUID()}`;
	const holder2Id = `user-holder-2-${crypto.randomUUID()}`;
	const testItemId = "test-item-smoke-grenade";
	const testItemName = "Smoke Grenade";

	beforeAll(async () => {
		// Clean up any test records
		await db
			.delete(elimsStockHolders)
			.where(eq(elimsStockHolders.guildId, testGuildId));
		await db
			.delete(elimsArmoryDeposits)
			.where(eq(elimsArmoryDeposits.guildId, testGuildId));

		// Seed 100x items into armory deposits
		await db.insert(elimsArmoryDeposits).values({
			guildId: testGuildId,
			discordUserId: "admin-1",
			discordUsername: "ArmoryAdmin",
			itemId: testItemId,
			itemName: testItemName,
			itemCategory: "Primary Weapon",
			quantity: 100,
			status: "available",
			isTest: false,
		});
	});

	afterAll(async () => {
		await db
			.delete(elimsStockHolders)
			.where(eq(elimsStockHolders.guildId, testGuildId));
		await db
			.delete(elimsArmoryDeposits)
			.where(eq(elimsArmoryDeposits.guildId, testGuildId));
	});

	test("buildStockHolderItemEmbed renders correct unassigned and active stock", () => {
		const { embed, row } = buildStockHolderItemEmbed({
			item: {
				id: testItemId,
				name: testItemName,
				category: "Primary Weapon",
			},
			unassigned: 60,
			totalAvailable: 100,
			holders: [
				{
					id: "alloc-1",
					guildId: testGuildId,
					discordUserId: holder1Id,
					discordUsername: "OfficerAlice",
					itemId: testItemId,
					itemName: testItemName,
					quantity: 40,
					isTest: false,
					updatedAt: new Date(),
				},
			],
		});

		expect(embed.data.title).toBe(`Item — ${testItemName}`);
		const unassignedField = embed.data.fields?.find(
			(f) => f.name === "Unassigned in Armory",
		);
		expect(unassignedField?.value).toContain("60");

		const totalField = embed.data.fields?.find(
			(f) => f.name === "Total Active Stock",
		);
		expect(totalField?.value).toContain("100");

		const holdersField = embed.data.fields?.find((f) =>
			f.name.startsWith("Current Holders"),
		);
		expect(holdersField?.value).toContain(`<@${holder1Id}>`);
		expect(holdersField?.value).toContain("40x");

		// Buttons enabled
		const assignBtn = row.components[0];
		const reclaimBtn = row.components[1];
		expect(assignBtn?.data.disabled).toBe(false);
		expect(reclaimBtn?.data.disabled).toBe(false);
	});

	test("buildStockHolderItemEmbed sets thumbnail from explicit image or numeric item id fallback", () => {
		const embedWithExplicitImage = buildStockHolderItemEmbed({
			item: {
				id: testItemId,
				name: testItemName,
				image: "https://example.com/custom-image.png",
			},
			unassigned: 10,
			totalAvailable: 10,
			holders: [],
		});
		expect(embedWithExplicitImage.embed.data.thumbnail?.url).toBe(
			"https://example.com/custom-image.png",
		);

		const embedWithNumericId = buildStockHolderItemEmbed({
			item: {
				id: "814",
				name: "Tyrosine",
			},
			unassigned: 1,
			totalAvailable: 1,
			holders: [],
		});
		expect(embedWithNumericId.embed.data.thumbnail?.url).toBe(
			"https://www.torn.com/images/items/814/large.png",
		);
	});

	test("resolveTornItem resolves images from whitelisted items and Torn CDN", async () => {
		// From allowedItems
		const fromAllowed = await resolveTornItem("Tyrosine", [
			{
				id: "814",
				name: "Tyrosine",
				category: "Weapon",
				image: "https://www.torn.com/images/items/814/large.png",
			},
		]);
		expect(fromAllowed.image).toBe(
			"https://www.torn.com/images/items/814/large.png",
		);

		// Fallback for numeric ID item
		const fallbackNumeric = await resolveTornItem("814", []);
		expect(fallbackNumeric.image).toBe(
			"https://www.torn.com/images/items/814/large.png",
		);
	});

	test("buildStockHolderItemEmbed disables buttons when appropriate", () => {
		const { row } = buildStockHolderItemEmbed({
			item: {
				id: testItemId,
				name: testItemName,
			},
			unassigned: 0,
			totalAvailable: 50,
			holders: [],
		});

		const assignBtn = row.components[0];
		const reclaimBtn = row.components[1];
		expect(assignBtn?.data.disabled).toBe(true);
		expect(reclaimBtn?.data.disabled).toBe(true);
	});

	test("getUnassignedStock accurately calculates unassigned stock", async () => {
		const stockInfo = await getUnassignedStock(
			testGuildId,
			false,
			testItemId,
			testItemName,
		);
		expect(stockInfo.availableTotal).toBe(100);
		expect(stockInfo.allocated).toBe(0);
		expect(stockInfo.unassigned).toBe(100);
	});

	test("assignStockToHolder rejects invalid quantities and amounts exceeding unassigned stock", async () => {
		const invalidZero = await assignStockToHolder({
			guildId: testGuildId,
			discordUserId: holder1Id,
			discordUsername: "OfficerAlice",
			itemId: testItemId,
			itemName: testItemName,
			quantity: 0,
			isTest: false,
		});
		expect(invalidZero.success).toBe(false);
		expect(invalidZero.error).toContain("greater than zero");

		const excessResult = await assignStockToHolder({
			guildId: testGuildId,
			discordUserId: holder1Id,
			discordUsername: "OfficerAlice",
			itemId: testItemId,
			itemName: testItemName,
			quantity: 150, // total is 100
			isTest: false,
		});
		expect(excessResult.success).toBe(false);
		expect(excessResult.error).toContain("Insufficient unassigned stock");
	});

	test("assignStockToHolder assigns stock and updates holder total", async () => {
		const assignResult = await assignStockToHolder({
			guildId: testGuildId,
			discordUserId: holder1Id,
			discordUsername: "OfficerAlice",
			itemId: testItemId,
			itemName: testItemName,
			quantity: 35,
			isTest: false,
		});

		expect(assignResult.success).toBe(true);
		expect(assignResult.updatedQuantity).toBe(35);

		// Second assignment accumulates
		const assignMore = await assignStockToHolder({
			guildId: testGuildId,
			discordUserId: holder1Id,
			discordUsername: "OfficerAlice",
			itemId: testItemId,
			itemName: testItemName,
			quantity: 15,
			isTest: false,
		});

		expect(assignMore.success).toBe(true);
		expect(assignMore.updatedQuantity).toBe(50);

		// Verify unassigned balance decreased from 100 to 50
		const stockInfo = await getUnassignedStock(
			testGuildId,
			false,
			testItemId,
			testItemName,
		);
		expect(stockInfo.allocated).toBe(50);
		expect(stockInfo.unassigned).toBe(50);
	});

	test("deductHolderStock validates sufficiency and decrements held stock", async () => {
		// Attempting to deduct more than held (50) fails
		const failDeduct = await deductHolderStock({
			guildId: testGuildId,
			discordUserId: holder1Id,
			itemId: testItemId,
			quantity: 60,
			isTest: false,
		});
		expect(failDeduct.success).toBe(false);
		expect(failDeduct.error).toContain("Insufficient held stock");

		// Non-holder fails
		const nonHolder = await deductHolderStock({
			guildId: testGuildId,
			discordUserId: holder2Id,
			itemId: testItemId,
			quantity: 5,
			isTest: false,
		});
		expect(nonHolder.success).toBe(false);

		// Valid deduction (approve request for 20 items)
		const validDeduct = await deductHolderStock({
			guildId: testGuildId,
			discordUserId: holder1Id,
			itemId: testItemId,
			quantity: 20,
			isTest: false,
		});
		expect(validDeduct.success).toBe(true);
		expect(validDeduct.remainingQuantity).toBe(30);

		const holders = await getStockHolders(testGuildId, false, testItemId);
		const holder = holders.find((h) => h.discordUserId === holder1Id);
		expect(holder?.quantity).toBe(30);
	});

	test("reclaimStockFromHolder returns stock to unassigned pool", async () => {
		// Attempting to reclaim more than held fails
		const failReclaim = await reclaimStockFromHolder({
			guildId: testGuildId,
			discordUserId: holder1Id,
			itemId: testItemId,
			quantity: 50,
			isTest: false,
		});
		expect(failReclaim.success).toBe(false);
		expect(failReclaim.error).toContain("only holds 30");

		// Reclaim 10 items
		const successReclaim = await reclaimStockFromHolder({
			guildId: testGuildId,
			discordUserId: holder1Id,
			itemId: testItemId,
			quantity: 10,
			isTest: false,
		});
		expect(successReclaim.success).toBe(true);
		expect(successReclaim.remainingQuantity).toBe(20);

		const holders = await getStockHolders(testGuildId, false, testItemId);
		const holder = holders.find((h) => h.discordUserId === holder1Id);
		expect(holder?.quantity).toBe(20);
	});

	test("hasManagerPermission correctly checks administrator permissions and manager roles", async () => {
		const { hasManagerPermission } = await import(
			"../src/lib/elims-stock-holders"
		);

		const adminInteraction = {
			member: {
				permissions: { has: (p: bigint) => p === BigInt(0x8) },
				roles: ["regular-role"],
			},
		} as unknown as Parameters<typeof hasManagerPermission>[0];

		expect(
			hasManagerPermission(adminInteraction, {
				managerRoleIds: ["manager-role-1"],
			} as unknown as Parameters<typeof hasManagerPermission>[1]),
		).toBe(true);

		const managerInteraction = {
			member: {
				permissions: { has: () => false },
				roles: ["manager-role-1"],
			},
		} as unknown as Parameters<typeof hasManagerPermission>[0];

		expect(
			hasManagerPermission(managerInteraction, {
				managerRoleIds: ["manager-role-1"],
			} as unknown as Parameters<typeof hasManagerPermission>[1]),
		).toBe(true);

		const regularInteraction = {
			member: {
				permissions: { has: () => false },
				roles: ["regular-role"],
			},
		} as unknown as Parameters<typeof hasManagerPermission>[0];

		expect(
			hasManagerPermission(regularInteraction, {
				managerRoleIds: ["manager-role-1"],
			} as unknown as Parameters<typeof hasManagerPermission>[1]),
		).toBe(false);
	});

	test("buildStockHolderItemEmbed enforces 1024 character limit for large numbers of holders", () => {
		const manyHolders = Array.from({ length: 50 }, (_, i) => ({
			id: `alloc-${i}`,
			guildId: testGuildId,
			discordUserId: `12345678901234567${i}`,
			discordUsername: `User_${i}`,
			itemId: testItemId,
			itemName: testItemName,
			quantity: 10 + i,
			isTest: false,
			updatedAt: new Date(),
		}));

		const { embed } = buildStockHolderItemEmbed({
			item: {
				id: testItemId,
				name: testItemName,
			},
			unassigned: 0,
			totalAvailable: 1000,
			holders: manyHolders,
		});

		const holdersField = embed.data.fields?.find((f) =>
			f.name.startsWith("Current Holders"),
		);
		expect(holdersField).toBeDefined();
		expect(holdersField?.value.length).toBeLessThanOrEqual(1024);
		expect(holdersField?.value).toContain("...and ");
		expect(holdersField?.value).toContain("more");
	});
});
