import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { db, elimsTeams, eq, inArray, systemStates } from "@sentinel/database";
import type {
	ButtonInteraction,
	ChatInputCommandInteraction,
	EmbedBuilder,
} from "discord.js";
import { elimsCommandsList, liveDataCommand } from "../src/commands/index";
import {
	buildLiveDataEmbed,
	ELIMS_LIVE_DATA_CONFIG_ID,
	handleLiveDataRefreshButton,
} from "../src/lib/elims-live-data";

describe("live-data command and standings embed", () => {
	const testTeamIds = [88801, 88802, 88803];
	const testGuildId = `guild-live-test-${crypto.randomUUID()}`;

	beforeAll(async () => {
		// Clean up test records
		await db.delete(elimsTeams).where(inArray(elimsTeams.id, testTeamIds));
		await db
			.delete(systemStates)
			.where(eq(systemStates.id, ELIMS_LIVE_DATA_CONFIG_ID));

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
	});

	afterAll(async () => {
		await db.delete(elimsTeams).where(inArray(elimsTeams.id, testTeamIds));
		await db
			.delete(systemStates)
			.where(eq(systemStates.id, ELIMS_LIVE_DATA_CONFIG_ID));
	});

	it("is registered with elims-only scope in elimsCommandsList", () => {
		expect(liveDataCommand.data.name).toBe("live-data");
		expect(liveDataCommand.scope).toBe("elims");

		const registered = elimsCommandsList.find(
			(c) => c.data.name === "live-data",
		);
		expect(registered).toBeDefined();
		expect(registered?.scope).toBe("elims");
	});

	it("buildLiveDataEmbed sorts teams by wins descending and computes stats", async () => {
		const { embed, totalTeams } = await buildLiveDataEmbed();

		expect(totalTeams).toBeGreaterThanOrEqual(3);
		expect(embed.data.title).toBe("Live Standings");

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

	it("rejects execution outside of a guild", async () => {
		const replyMock = mock(async () => {});
		const mockInteraction = {
			guildId: null,
			reply: replyMock,
		} as unknown as ChatInputCommandInteraction;

		await liveDataCommand.execute(mockInteraction);

		expect(replyMock).toHaveBeenCalledTimes(1);
		const calls = replyMock.mock.calls as unknown as Array<
			[{ embeds?: EmbedBuilder[] }]
		>;
		const firstCall = calls[0];
		expect(firstCall?.[0]?.embeds?.[0]?.data.title).toContain("Guild Only");
	});

	it("posts persistent embed and records message reference in systemStates", async () => {
		const deferReplyMock = mock(async () => {});
		const editReplyMock = mock(async () => ({
			id: "msg-live-data-12345",
		}));

		const mockInteraction = {
			guildId: testGuildId,
			channelId: "channel-live-data-789",
			deferReply: deferReplyMock,
			editReply: editReplyMock,
		} as unknown as ChatInputCommandInteraction;

		await liveDataCommand.execute(mockInteraction);

		expect(deferReplyMock).toHaveBeenCalledTimes(1);
		expect(editReplyMock).toHaveBeenCalledTimes(1);

		// Verify state was recorded in database
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_LIVE_DATA_CONFIG_ID));

		expect(state).toBeDefined();
		const config = state?.data as {
			guildId: string;
			channelId: string;
			messageId: string;
		};
		expect(config.guildId).toBe(testGuildId);
		expect(config.channelId).toBe("channel-live-data-789");
		expect(config.messageId).toBe("msg-live-data-12345");
	});

	it("handleLiveDataRefreshButton defers update and edits reply", async () => {
		const deferUpdateMock = mock(async () => {});
		const editReplyMock = mock(async () => {});

		const mockButtonInteraction = {
			deferUpdate: deferUpdateMock,
			editReply: editReplyMock,
		} as unknown as ButtonInteraction;

		await handleLiveDataRefreshButton(mockButtonInteraction);

		expect(deferUpdateMock).toHaveBeenCalledTimes(1);
		expect(editReplyMock).toHaveBeenCalledTimes(1);
		const editCalls = editReplyMock.mock.calls as unknown as Array<
			[{ embeds?: EmbedBuilder[] }]
		>;
		const firstEditCall = editCalls[0];
		expect(firstEditCall?.[0]?.embeds?.[0]?.data.title).toBe("Live Standings");
	});
});
