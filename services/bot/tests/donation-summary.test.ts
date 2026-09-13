import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db, elimsArmoryDeposits, eq } from "@sentinel/database";
import type { ChatInputCommandInteraction } from "discord.js";
import {
	donationSummaryCommand,
	generateDonationSummary,
} from "../src/commands/donation-summary";

describe("donation-summary command", () => {
	const TEST_GUILD_ID = `test_guild_${crypto.randomUUID()}`;
	const OTHER_GUILD_ID = `other_guild_${crypto.randomUUID()}`;

	beforeEach(async () => {
		await db
			.delete(elimsArmoryDeposits)
			.where(eq(elimsArmoryDeposits.guildId, TEST_GUILD_ID));
		await db
			.delete(elimsArmoryDeposits)
			.where(eq(elimsArmoryDeposits.guildId, OTHER_GUILD_ID));
	});

	afterEach(async () => {
		await db
			.delete(elimsArmoryDeposits)
			.where(eq(elimsArmoryDeposits.guildId, TEST_GUILD_ID));
		await db
			.delete(elimsArmoryDeposits)
			.where(eq(elimsArmoryDeposits.guildId, OTHER_GUILD_ID));
	});

	test("has correct command definition and elims scope", () => {
		expect(donationSummaryCommand.data.name).toBe("donation-summary");
		expect(donationSummaryCommand.scope).toBe("elims");
	});

	test("generateDonationSummary aggregates quantities per (user, item) pair and exports valid CSV", async () => {
		// Insert 2 deposits of Xanax from Alice
		await db.insert(elimsArmoryDeposits).values([
			{
				guildId: TEST_GUILD_ID,
				discordUserId: "user_alice",
				discordUsername: "Alice#0001",
				tornId: 1001,
				tornName: "AliceTorn",
				itemId: "366",
				itemName: "Xanax",
				itemCategory: "Drug",
				quantity: 5,
				isTest: false,
			},
			{
				guildId: TEST_GUILD_ID,
				discordUserId: "user_alice",
				discordUsername: "Alice#0001",
				tornId: 1001,
				tornName: "AliceTorn",
				itemId: "366",
				itemName: "Xanax",
				itemCategory: "Drug",
				quantity: 10,
				isTest: false,
			},
			// Alice also deposited 2 Vicodin
			{
				guildId: TEST_GUILD_ID,
				discordUserId: "user_alice",
				discordUsername: "Alice#0001",
				tornId: 1001,
				tornName: "AliceTorn",
				itemId: "367",
				itemName: "Vicodin",
				itemCategory: "Drug",
				quantity: 2,
				isTest: false,
			},
			// Bob deposited 20 Xanax
			{
				guildId: TEST_GUILD_ID,
				discordUserId: "user_bob",
				discordUsername: "Bob#0002",
				tornId: 1002,
				tornName: "BobTorn",
				itemId: "366",
				itemName: "Xanax",
				itemCategory: "Drug",
				quantity: 20,
				isTest: false,
			},
		]);

		const result = await generateDonationSummary(TEST_GUILD_ID);
		expect(result.totalRows).toBe(3); // (Alice, Xanax), (Alice, Vicodin), (Bob, Xanax)
		expect(result.totalItems).toBe(37); // 5 + 10 + 2 + 20

		const csv = Buffer.from(result.attachment.attachment as Buffer).toString(
			"utf-8",
		);
		const lines = csv.trim().split("\n");

		expect(lines[0]).toBe(
			"Torn Name,Torn ID,Profile Link,Discord Username,Item,Category,Total Qty",
		);

		// Alice Xanax should be aggregated to 15
		const aliceXanax = lines.find(
			(l) => l.includes("AliceTorn") && l.includes("Xanax"),
		);
		expect(aliceXanax).toBeDefined();
		expect(aliceXanax).toContain("https://www.torn.com/profiles.php?XID=1001");
		expect(aliceXanax?.endsWith(",15")).toBe(true);
	});

	test("isolates records by guildId and excludes test deposits", async () => {
		// Insert record in target guild
		await db.insert(elimsArmoryDeposits).values({
			guildId: TEST_GUILD_ID,
			discordUserId: "user_alice",
			discordUsername: "Alice#0001",
			tornId: 1001,
			tornName: "AliceTorn",
			itemId: "366",
			itemName: "Xanax",
			itemCategory: "Drug",
			quantity: 10,
			isTest: false,
		});

		// Insert test record in target guild (should be ignored)
		await db.insert(elimsArmoryDeposits).values({
			guildId: TEST_GUILD_ID,
			discordUserId: "user_test",
			discordUsername: "Test#0001",
			tornId: 9999,
			tornName: "Tester",
			itemId: "366",
			itemName: "Xanax",
			itemCategory: "Drug",
			quantity: 50,
			isTest: true,
		});

		// Insert record in another guild (should be ignored)
		await db.insert(elimsArmoryDeposits).values({
			guildId: OTHER_GUILD_ID,
			discordUserId: "user_other",
			discordUsername: "Other#0001",
			tornId: 2001,
			tornName: "OtherTorn",
			itemId: "366",
			itemName: "Xanax",
			itemCategory: "Drug",
			quantity: 100,
			isTest: false,
		});

		const result = await generateDonationSummary(TEST_GUILD_ID);
		expect(result.totalRows).toBe(1);
		expect(result.totalItems).toBe(10);
	});

	test("rejects execution when called outside a guild", async () => {
		let replyCalled = false;
		let replyContent: unknown = null;

		const interaction = {
			guildId: null,
			reply: async (opts: unknown) => {
				replyCalled = true;
				replyContent = opts;
			},
		} as unknown as ChatInputCommandInteraction;

		await donationSummaryCommand.execute(interaction);
		expect(replyCalled).toBe(true);
		expect(replyContent).toBeDefined();
	});
});
