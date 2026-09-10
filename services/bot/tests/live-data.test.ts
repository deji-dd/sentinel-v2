import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { db, elimsTeams, eq, inArray, systemStates } from "@sentinel/database";
import type { Client, Message } from "discord.js";
import { commandsList, elimsCommandsList } from "../src/commands/index";
import {
	buildLiveDataEmbed,
	ELIMS_CONFIG_ID,
	updateElimsLiveDataChannel,
	updateElimsLiveDataMessage,
} from "../src/lib/elims-live-data";

describe("live-data channel configuration and standings embed", () => {
	const testTeamIds = [88801, 88802, 88803];
	const testGuildId = `guild-live-test-${crypto.randomUUID()}`;
	const testChannelId = `channel-live-test-${crypto.randomUUID()}`;

	beforeAll(async () => {
		// Clean up test records
		await db.delete(elimsTeams).where(inArray(elimsTeams.id, testTeamIds));
		await db.delete(systemStates).where(eq(systemStates.id, ELIMS_CONFIG_ID));

		// Insert 3 test teams with varying wins, losses, tickets, and lives
		await db.insert(elimsTeams).values([
			{
				id: 88801,
				name: "Top Winners",
				position: 1,
				score: 3000000,
				attacks: 1000,
				wins: 950,
				losses: 50,
				lives: 48,
				eliminated: false,
				isMock: true,
			},
			{
				id: 88802,
				name: "Middle Contenders",
				position: 2,
				score: 2000000,
				attacks: 600,
				wins: 500,
				losses: 100,
				lives: 30,
				eliminated: false,
				isMock: true,
			},
			{
				id: 88803,
				name: "Eliminated Underdogs",
				position: 3,
				score: 500000,
				attacks: 200,
				wins: 100,
				losses: 400,
				lives: 0,
				eliminated: true,
				isMock: true,
			},
		]);

		// Initialize guild configuration state
		await db.insert(systemStates).values({
			id: ELIMS_CONFIG_ID,
			init: true,
			data: {
				guildId: testGuildId,
				guildName: "Test Elims Guild",
				guildIcon: null,
				adminRoleIds: [],
				liveDataChannelId: testChannelId,
				liveDataEmbedMessageId: null,
				configuredAt: new Date().toISOString(),
				configuredBy: { discordId: "123", username: "tester" },
				updatedAt: new Date().toISOString(),
			},
		});
	});

	afterAll(async () => {
		await db.delete(elimsTeams).where(inArray(elimsTeams.id, testTeamIds));
		await db.delete(systemStates).where(eq(systemStates.id, ELIMS_CONFIG_ID));
	});

	it("verifies live-data slash command has been removed", () => {
		const inElims = elimsCommandsList.find((c) => c.data.name === "live-data");
		expect(inElims).toBeUndefined();

		const inAll = commandsList.find((c) => c.data.name === "live-data");
		expect(inAll).toBeUndefined();
	});

	it("buildLiveDataEmbed sorts teams by wins descending and computes stats correctly", async () => {
		const { embed, totalTeams, activeTeams } = await buildLiveDataEmbed();

		expect(totalTeams).toBeGreaterThanOrEqual(3);
		expect(activeTeams).toBeGreaterThanOrEqual(2);
		expect(embed.data.title).toBe("Live Standings");
		expect(embed.data.footer?.text).toBe("Sentinel");
		expect(embed.data.description).toContain("Teams Active:");
		expect(embed.data.description).toContain(
			"Ranked primarily by outgoing attacks.",
		);

		// Find our test team fields in the embed
		const fields = embed.data.fields ?? [];
		const winnerField = fields.find((f) => f.name.includes("Top Winners"));
		const middleField = fields.find((f) =>
			f.name.includes("Middle Contenders"),
		);
		const elimField = fields.find((f) =>
			f.name.includes("Eliminated Underdogs"),
		);

		expect(winnerField).toBeDefined();
		expect(middleField).toBeDefined();
		expect(elimField).toBeDefined();

		// Top Winners should have higher rank than Middle Contenders
		const winnerIndex = fields.findIndex((f) => f.name.includes("Top Winners"));
		const middleIndex = fields.findIndex((f) =>
			f.name.includes("Middle Contenders"),
		);
		const elimIndex = fields.findIndex((f) =>
			f.name.includes("Eliminated Underdogs"),
		);

		expect(winnerIndex).toBeLessThan(middleIndex);
		expect(middleIndex).toBeLessThan(elimIndex);

		// Check formatting of Top Winners: no medals, W/L Ratio
		expect(winnerField?.name).not.toContain("🥇");
		expect(winnerField?.name).toMatch(/^#1\s+Top Winners/);
		expect(winnerField?.value).toContain("W/L Ratio:");
		expect(winnerField?.value).toContain("19.00");
		expect(winnerField?.value).toContain("950W - 50L");
		expect(winnerField?.value).toContain("3,000,000");
		expect(winnerField?.value).toContain("48 HP");

		// Check eliminated status
		expect(elimField?.name).toContain("[ELIMINATED]");
		expect(elimField?.value).toContain("0 (Dead)");
	});

	it("updateElimsLiveDataChannel sends new embed and saves messageId to database", async () => {
		const createdMessageId = `msg-live-${crypto.randomUUID()}`;
		const sendMock = mock(async () => ({
			id: createdMessageId,
		}));

		const mockChannel = {
			id: testChannelId,
			isTextBased: () => true,
			send: sendMock,
			messages: {
				fetch: mock(async () => new Map()),
			},
		};

		const mockClient = {
			user: { id: "bot-client-user-id" },
			channels: {
				fetch: mock(async (id: string) =>
					id === testChannelId ? mockChannel : null,
				),
			},
		} as unknown as Client;

		// Set prototype so instanceof TextChannel works or simulate
		Object.setPrototypeOf(
			mockChannel,
			(await import("discord.js")).TextChannel.prototype,
		);

		await updateElimsLiveDataChannel(mockClient, testGuildId);

		expect(sendMock).toHaveBeenCalledTimes(1);

		// Verify that the messageId was stored in elims:guild_config
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_CONFIG_ID));

		const config = state?.data as {
			liveDataChannelId: string;
			liveDataEmbedMessageId: string;
		};
		expect(config.liveDataChannelId).toBe(testChannelId);
		expect(config.liveDataEmbedMessageId).toBe(createdMessageId);
	});

	it("updateElimsLiveDataMessage edits message in place", async () => {
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_CONFIG_ID));

		const config = state?.data as {
			liveDataEmbedMessageId: string;
		};

		const editMock = mock(async () => {});
		const mockMessage = {
			id: config.liveDataEmbedMessageId,
			edit: editMock,
		} as unknown as Message;

		const mockChannel = {
			id: testChannelId,
			messages: {
				fetch: mock(async (id: string) =>
					id === config.liveDataEmbedMessageId ? mockMessage : null,
				),
			},
		};
		Object.setPrototypeOf(
			mockChannel,
			(await import("discord.js")).TextChannel.prototype,
		);

		const mockClient = {
			user: { id: "bot-client-user-id" },
			channels: {
				fetch: mock(async (id: string) =>
					id === testChannelId ? mockChannel : null,
				),
			},
		} as unknown as Client;

		// Update team data to trigger payload change
		await db
			.update(elimsTeams)
			.set({ wins: 960 })
			.where(eq(elimsTeams.id, 88801));

		await updateElimsLiveDataMessage(mockClient);

		expect(editMock).toHaveBeenCalledTimes(1);
	});

	it("cleanly handles restarts by editing existing embed in-place and purging duplicate stray embeds", async () => {
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_CONFIG_ID));

		const config = state?.data as {
			liveDataEmbedMessageId: string;
		};

		const editExistingMock = mock(async () => {});
		const deleteStrayMock = mock(async () => {});
		const sendMock = mock(async () => ({ id: "msg-should-not-be-created" }));

		const existingMessage = {
			id: config.liveDataEmbedMessageId,
			author: { id: "bot-client-user-id" },
			embeds: [{ title: "Live Standings" }],
			edit: editExistingMock,
		} as unknown as Message;

		const strayMessage = {
			id: "msg-stray-leftover-123",
			author: { id: "bot-client-user-id" },
			embeds: [{ title: "Live Standings" }],
			delete: deleteStrayMock,
		} as unknown as Message;

		const mockChannel = {
			id: testChannelId,
			isTextBased: () => true,
			send: sendMock,
			messages: {
				fetch: mock(async (arg?: unknown) => {
					if (typeof arg === "string") {
						return arg === config.liveDataEmbedMessageId
							? existingMessage
							: null;
					}
					// Return map of recent messages containing existing and stray
					const map = new Map<string, Message>();
					map.set(existingMessage.id, existingMessage);
					map.set(strayMessage.id, strayMessage);
					return map;
				}),
			},
		};
		Object.setPrototypeOf(
			mockChannel,
			(await import("discord.js")).TextChannel.prototype,
		);

		const mockClient = {
			user: { id: "bot-client-user-id" },
			channels: {
				fetch: mock(async (id: string) =>
					id === testChannelId ? mockChannel : null,
				),
			},
		} as unknown as Client;

		// Trigger bot startup / restart handler
		await updateElimsLiveDataChannel(mockClient, testGuildId);

		// Assert zero new messages were sent to the channel
		expect(sendMock).toHaveBeenCalledTimes(0);

		// Assert existing embed was edited in place
		expect(editExistingMock).toHaveBeenCalledTimes(1);

		// Assert stray duplicate embed was deleted
		expect(deleteStrayMock).toHaveBeenCalledTimes(1);
	});
});
