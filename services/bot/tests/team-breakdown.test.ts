import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
	db,
	elimsMemberStats,
	elimsTeamPlayers,
	elimsTeams,
	inArray,
} from "@sentinel/database";
import type {
	AttachmentBuilder,
	ChatInputCommandInteraction,
	EmbedBuilder,
	StringSelectMenuInteraction,
} from "discord.js";
import { elimsCommandsList, normalCommandsList } from "../src/commands/index";
import {
	escapeCsvField,
	formatStatNumber,
	generateTeamBreakdown,
	handleTeamBreakdownSelect,
	TEAM_BREAKDOWN_SELECT_ID,
	teamBreakdownCommand,
} from "../src/commands/team-breakdown";

describe("team-breakdown command", () => {
	const testTeamId = 88; // Nine Lives
	const p1Id = 999001;
	const p2Id = 999002;
	const p3Id = 999003;
	const testPlayerIds = [p1Id, p2Id, p3Id];
	const testGuildId = `guild-elims-test-${crypto.randomUUID()}`;

	beforeAll(async () => {
		// Clean up any test records
		await db
			.delete(elimsTeamPlayers)
			.where(inArray(elimsTeamPlayers.id, testPlayerIds));
		await db
			.delete(elimsMemberStats)
			.where(inArray(elimsMemberStats.tornId, testPlayerIds));

		// Ensure team 88 exists
		await db
			.insert(elimsTeams)
			.values({
				id: testTeamId,
				name: "Nine Lives",
				score: 100,
				attacks: 50,
				membersCount: 3,
				isMock: true,
			})
			.onConflictDoUpdate({
				target: elimsTeams.id,
				set: { name: "Nine Lives" },
			});

		// Insert mock players
		await db.insert(elimsTeamPlayers).values([
			{
				id: p1Id,
				teamId: testTeamId,
				name: "Cat, Leader", // tests comma escaping
				level: 100,
				score: 10,
				attacks: 45,
				isMock: true,
			},
			{
				id: p2Id,
				teamId: testTeamId,
				name: 'Kitten "The Boss"', // tests quotes escaping
				level: 75,
				score: 5,
				attacks: 20,
				isMock: true,
			},
			{
				id: p3Id,
				teamId: testTeamId,
				name: "Stray Cat",
				level: 50,
				score: 1,
				attacks: 0,
				isMock: true,
			},
		]);

		// Insert mock stats for first 2 players (leaving 3rd without stats)
		await db.insert(elimsMemberStats).values([
			{
				guildId: testGuildId,
				discordId: `disc-user-${crypto.randomUUID()}`,
				tornId: p1Id,
				tornName: "Cat, Leader",
				bsEstimate: 3_500_000_000,
				bsEstimateHuman: "3.5b",
			},
			{
				guildId: testGuildId,
				discordId: `disc-user-${crypto.randomUUID()}`,
				tornId: p2Id,
				tornName: 'Kitten "The Boss"',
				bsEstimate: 450_000_000,
				bsEstimateHuman: null, // should be formatted to 450.00m
			},
		]);
	});

	afterAll(async () => {
		await db
			.delete(elimsTeamPlayers)
			.where(inArray(elimsTeamPlayers.id, testPlayerIds));
		await db
			.delete(elimsMemberStats)
			.where(inArray(elimsMemberStats.tornId, testPlayerIds));
	});

	it("has correct command registration and scope", () => {
		expect(teamBreakdownCommand.data.name).toBe("team-breakdown");
		expect(teamBreakdownCommand.scope).toBe("elims");

		const inElims = elimsCommandsList.find(
			(c) => c.data.name === "team-breakdown",
		);
		expect(inElims).toBeDefined();
		expect(inElims?.scope).toBe("elims");

		const inNormal = normalCommandsList.find(
			(c) => c.data.name === "team-breakdown",
		);
		expect(inNormal).toBeUndefined();

		const teamOption = teamBreakdownCommand.data.options.find(
			(opt) => (opt.toJSON() as { name: string }).name === "team",
		);
		expect(teamOption).toBeDefined();
	});

	it("formatStatNumber formats values correctly", () => {
		expect(formatStatNumber(1_500_000_000_000_000)).toBe("1.50q");
		expect(formatStatNumber(2_750_000_000_000)).toBe("2.75t");
		expect(formatStatNumber(3_500_000_000)).toBe("3.50b");
		expect(formatStatNumber(450_000_000)).toBe("450.00m");
		expect(formatStatNumber(15_000)).toBe("15.0k");
		expect(formatStatNumber(500)).toBe("500");
	});

	it("escapeCsvField handles quotes, commas, and edge cases", () => {
		expect(escapeCsvField(null)).toBe("");
		expect(escapeCsvField(undefined)).toBe("");
		expect(escapeCsvField("Simple")).toBe("Simple");
		expect(escapeCsvField(123)).toBe("123");
		expect(escapeCsvField("Name, With Comma")).toBe('"Name, With Comma"');
		expect(escapeCsvField('Name "With Quotes"')).toBe('"Name ""With Quotes"""');
		expect(escapeCsvField("Line1\nLine2")).toBe('"Line1\nLine2"');
	});

	it("generateTeamBreakdown produces valid CSV with expected columns", async () => {
		const result = await generateTeamBreakdown(testTeamId);

		expect(result.teamId).toBe(testTeamId);
		expect(result.teamName).toBe("Nine Lives");
		expect(result.playersCount).toBeGreaterThanOrEqual(3);
		expect(result.attachment.name).toBe("nine-lives-breakdown.csv");

		const lines = result.csvContent.trim().split("\n");
		expect(lines[0]).toBe("Name,ID,Level,Profile Link,Attacks Made,Est. Stats");

		// Check player 1: Cat, Leader
		const p1Line = lines.find((l) => l.includes("999001"));
		expect(p1Line).toBeDefined();
		expect(p1Line).toContain('"Cat, Leader"');
		expect(p1Line).toContain("100");
		expect(p1Line).toContain("https://www.torn.com/profiles.php?XID=999001");
		expect(p1Line).toContain("45");
		expect(p1Line).toContain("3.5b");

		// Check player 2: Kitten "The Boss"
		const p2Line = lines.find((l) => l.includes("999002"));
		expect(p2Line).toBeDefined();
		expect(p2Line).toContain('"Kitten ""The Boss"""');
		expect(p2Line).toContain("75");
		expect(p2Line).toContain("https://www.torn.com/profiles.php?XID=999002");
		expect(p2Line).toContain("20");
		expect(p2Line).toContain("450.00m");

		// Check player 3: Stray Cat (no stats -> N/A)
		const p3Line = lines.find((l) => l.includes("999003"));
		expect(p3Line).toBeDefined();
		expect(p3Line).toContain("Stray Cat");
		expect(p3Line).toContain("50");
		expect(p3Line).toContain("https://www.torn.com/profiles.php?XID=999003");
		expect(p3Line).toContain("0");
		expect(p3Line).toContain("N/A");
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

		await teamBreakdownCommand.execute(mockInteraction);
		expect(replyPayload.embeds?.[0]?.data.title).toBe("Guild Only");
	});

	it("presents interactive select menu if team option is not provided", async () => {
		let replyPayload: {
			embeds?: EmbedBuilder[];
			components?: unknown[];
			flags?: number;
		} = {};

		const mockInteraction = {
			guildId: "guild-123",
			options: {
				getInteger: mock((name: string) => (name === "team" ? null : null)),
			},
			reply: mock(
				async (payload: {
					embeds?: EmbedBuilder[];
					components?: unknown[];
					flags?: number;
				}) => {
					replyPayload = payload;
				},
			),
		} as unknown as ChatInputCommandInteraction;

		await teamBreakdownCommand.execute(mockInteraction);

		expect(replyPayload.embeds?.[0]?.data.title).toBe(
			"Elimination Team Breakdown",
		);
		expect(replyPayload.components?.length).toBe(1);
	});

	it("directly generates breakdown when team option is provided", async () => {
		let deferred = false;
		let editReplyPayload: {
			embeds?: EmbedBuilder[];
			files?: AttachmentBuilder[];
		} = {};

		const mockInteraction = {
			guildId: "guild-123",
			options: {
				getInteger: mock((name: string) =>
					name === "team" ? testTeamId : null,
				),
			},
			deferReply: mock(async () => {
				deferred = true;
			}),
			editReply: mock(
				async (payload: {
					embeds?: EmbedBuilder[];
					files?: AttachmentBuilder[];
				}) => {
					editReplyPayload = payload;
				},
			),
		} as unknown as ChatInputCommandInteraction;

		await teamBreakdownCommand.execute(mockInteraction);

		expect(deferred).toBe(true);
		expect(editReplyPayload.embeds?.[0]?.data.title).toBe(
			"Team Breakdown — Nine Lives",
		);
		expect(editReplyPayload.files?.length).toBe(1);
		expect(editReplyPayload.files?.[0]?.name).toBe("nine-lives-breakdown.csv");
	});

	it("handleTeamBreakdownSelect handles select menu submission", async () => {
		let deferred = false;
		let editReplyPayload: {
			embeds?: EmbedBuilder[];
			files?: AttachmentBuilder[];
			components?: unknown[];
		} = {};

		const mockInteraction = {
			customId: TEAM_BREAKDOWN_SELECT_ID,
			values: [String(testTeamId)],
			deferUpdate: mock(async () => {
				deferred = true;
			}),
			editReply: mock(
				async (payload: {
					embeds?: EmbedBuilder[];
					files?: AttachmentBuilder[];
					components?: unknown[];
				}) => {
					editReplyPayload = payload;
				},
			),
		} as unknown as StringSelectMenuInteraction;

		await handleTeamBreakdownSelect(mockInteraction);

		expect(deferred).toBe(true);
		expect(editReplyPayload.embeds?.[0]?.data.title).toBe(
			"Team Breakdown — Nine Lives",
		);
		expect(editReplyPayload.files?.length).toBe(1);
		expect(editReplyPayload.components?.length).toBe(0);
	});
});
