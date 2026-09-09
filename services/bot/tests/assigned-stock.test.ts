import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
	db,
	elimsStockHolders,
	eq,
	getHolderStock,
	systemStates,
} from "@sentinel/database";
import type {
	ChatInputCommandInteraction,
	EmbedBuilder,
	GuildMember,
	User,
} from "discord.js";
import { assignedStockCommand } from "../src/commands/assigned-stock";
import { elimsCommandsList, normalCommandsList } from "../src/commands/index";

describe("assigned-stock command", () => {
	const testGuildId = `guild-assigned-test-${crypto.randomUUID()}`;
	const holder1Id = `user-holder-1-${crypto.randomUUID()}`;
	const holder2Id = `user-holder-2-${crypto.randomUUID()}`;
	const managerId = `user-mgr-${crypto.randomUUID()}`;

	beforeAll(async () => {
		// Clean up any test records
		await db
			.delete(elimsStockHolders)
			.where(eq(elimsStockHolders.guildId, testGuildId));

		// Configure manager role requirement in systemStates
		await db
			.insert(systemStates)
			.values({
				id: "elims:item_requests_config",
				data: {
					managerRoleIds: ["role-manager-123"],
				},
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: {
					data: {
						managerRoleIds: ["role-manager-123"],
					},
					updatedAt: new Date(),
				},
			});

		// Seed stock for holder1
		await db.insert(elimsStockHolders).values([
			{
				guildId: testGuildId,
				discordUserId: holder1Id,
				discordUsername: "HolderOne",
				itemId: "367",
				itemName: "First Aid Kit",
				quantity: 50,
				isTest: false,
			},
			{
				guildId: testGuildId,
				discordUserId: holder1Id,
				discordUsername: "HolderOne",
				itemId: "366",
				itemName: "Morphine",
				quantity: 25,
				isTest: false,
			},
			{
				guildId: testGuildId,
				discordUserId: holder2Id,
				discordUsername: "HolderTwo",
				itemId: "814",
				itemName: "Tyrosine",
				quantity: 10,
				isTest: false,
			},
		]);
	});

	afterAll(async () => {
		await db
			.delete(elimsStockHolders)
			.where(eq(elimsStockHolders.guildId, testGuildId));
	});

	it("has correct command name and elims-only scope", () => {
		expect(assignedStockCommand.data.name).toBe("assigned-stock");
		expect(assignedStockCommand.scope).toBe("elims");

		const foundInElims = elimsCommandsList.find(
			(cmd) => cmd.data.name === "assigned-stock",
		);
		expect(foundInElims).toBeDefined();
		expect(foundInElims?.scope).toBe("elims");

		const foundInNormal = normalCommandsList.find(
			(cmd) => cmd.data.name === "assigned-stock",
		);
		expect(foundInNormal).toBeUndefined();

		const userOption = assignedStockCommand.data.options.find(
			(opt) => (opt.toJSON() as { name: string }).name === "user",
		);
		expect(userOption).toBeDefined();
	});

	it("getHolderStock correctly queries allocations for a user", async () => {
		const holder1Stock = await getHolderStock(testGuildId, holder1Id, false);
		expect(holder1Stock.length).toBe(2);

		const total = holder1Stock.reduce((sum, s) => sum + s.quantity, 0);
		expect(total).toBe(75);

		const holder2Stock = await getHolderStock(testGuildId, holder2Id, false);
		expect(holder2Stock.length).toBe(1);
		expect(holder2Stock[0]?.itemName).toBe("Tyrosine");
		expect(holder2Stock[0]?.quantity).toBe(10);

		const unknownStock = await getHolderStock(
			testGuildId,
			"non-existent-user",
			false,
		);
		expect(unknownStock.length).toBe(0);
	});

	it("rejects execution outside of a guild", async () => {
		let replyPayload: { embeds?: EmbedBuilder[]; flags?: number } = {};

		const mockInteraction = {
			guildId: null,
			reply: mock(
				async (payload: { embeds?: EmbedBuilder[]; flags?: number }) => {
					replyPayload = payload;
				},
			),
		} as unknown as ChatInputCommandInteraction;

		await assignedStockCommand.execute(mockInteraction);

		expect(mockInteraction.reply).toHaveBeenCalledTimes(1);
		const embed = replyPayload.embeds?.[0];
		expect(embed?.data.title).toBe("Guild Only");
	});

	it("displays empty message when caller has no assigned stock", async () => {
		let editReplyPayload: { embeds?: EmbedBuilder[] } = {};

		const mockUser = {
			id: "user-with-no-stock",
			username: "EmptyUser",
		} as User;

		const mockInteraction = {
			guildId: testGuildId,
			user: mockUser,
			options: {
				getUser: mock(() => null),
			},
			deferReply: mock(async () => {}),
			editReply: mock(async (payload: { embeds?: EmbedBuilder[] }) => {
				editReplyPayload = payload;
			}),
		} as unknown as ChatInputCommandInteraction;

		await assignedStockCommand.execute(mockInteraction);

		expect(mockInteraction.deferReply).toHaveBeenCalledTimes(1);
		expect(mockInteraction.editReply).toHaveBeenCalledTimes(1);

		const embed = editReplyPayload.embeds?.[0];
		expect(embed?.data.title).toBe("Your Assigned Stock");
		expect(embed?.data.description).toContain(
			"You do not currently have any armory stock assigned to you.",
		);
	});

	it("displays detailed stock breakdown when caller has assigned stock", async () => {
		let editReplyPayload: { embeds?: EmbedBuilder[] } = {};

		const mockUser = {
			id: holder1Id,
			username: "HolderOne",
		} as User;

		const mockInteraction = {
			guildId: testGuildId,
			user: mockUser,
			options: {
				getUser: mock(() => null),
			},
			deferReply: mock(async () => {}),
			editReply: mock(async (payload: { embeds?: EmbedBuilder[] }) => {
				editReplyPayload = payload;
			}),
		} as unknown as ChatInputCommandInteraction;

		await assignedStockCommand.execute(mockInteraction);

		expect(mockInteraction.deferReply).toHaveBeenCalledTimes(1);
		expect(mockInteraction.editReply).toHaveBeenCalledTimes(1);

		const embed = editReplyPayload.embeds?.[0];
		expect(embed?.data.title).toBe("Your Assigned Stock");
		expect(embed?.data.description).toContain(
			"You currently have **75** items assigned.",
		);

		const totalField = embed?.data.fields?.find(
			(f) => f.name === "Total Items",
		);
		expect(totalField?.value).toContain("75");

		const breakdownField = embed?.data.fields?.find(
			(f) => f.name === "Assigned Items",
		);
		expect(breakdownField?.value).toContain("• **First Aid Kit** — **50x**");
		expect(breakdownField?.value).toContain("• **Morphine** — **25x**");
	});

	it("prevents non-managers from viewing assigned stock for other members", async () => {
		let editReplyPayload: { embeds?: EmbedBuilder[] } = {};

		const caller = {
			id: holder1Id,
			username: "HolderOne",
		} as User;

		const target = {
			id: holder2Id,
			username: "HolderTwo",
		} as User;

		const mockMember = {
			roles: ["role-regular-member"],
			permissions: { has: () => false },
		} as unknown as GuildMember;

		const mockInteraction = {
			guildId: testGuildId,
			user: caller,
			member: mockMember,
			options: {
				getUser: mock(() => target),
			},
			deferReply: mock(async () => {}),
			editReply: mock(async (payload: { embeds?: EmbedBuilder[] }) => {
				editReplyPayload = payload;
			}),
		} as unknown as ChatInputCommandInteraction;

		await assignedStockCommand.execute(mockInteraction);

		const embed = editReplyPayload.embeds?.[0];
		expect(embed?.data.title).toBe("Permission Denied");
	});

	it("allows managers to view assigned stock for other members", async () => {
		let editReplyPayload: { embeds?: EmbedBuilder[] } = {};

		const caller = {
			id: managerId,
			username: "ManagerUser",
		} as User;

		const target = {
			id: holder2Id,
			username: "HolderTwo",
		} as User;

		const mockMember = {
			roles: ["role-manager-123"],
			permissions: { has: () => false },
		} as unknown as GuildMember;

		const mockInteraction = {
			guildId: testGuildId,
			user: caller,
			member: mockMember,
			options: {
				getUser: mock(() => target),
			},
			deferReply: mock(async () => {}),
			editReply: mock(async (payload: { embeds?: EmbedBuilder[] }) => {
				editReplyPayload = payload;
			}),
		} as unknown as ChatInputCommandInteraction;

		await assignedStockCommand.execute(mockInteraction);

		const embed = editReplyPayload.embeds?.[0];
		expect(embed?.data.title).toBe("Assigned Stock — HolderTwo");
		expect(embed?.data.description).toContain("<@user-holder-2-");
		const breakdownField = embed?.data.fields?.find(
			(f) => f.name === "Assigned Items",
		);
		expect(breakdownField?.value).toContain("• **Tyrosine** — **10x**");
	});
});
