import { describe, expect, it, mock, spyOn } from "bun:test";
import * as database from "@sentinel/database";
import { ChannelType, type Client } from "discord.js";
import {
	archiveMercClientChannel,
	processExpiredMercContractTokens,
} from "../src/lib/merc-contract-creation";

describe("Mercenary Channel Archiving on Token Expiration", () => {
	it("archiveMercClientChannel strips client permissions, moves to archive category, and sends notice", async () => {
		const guildId = "guild-archive-test";
		const channelId = "chan-archive-test";
		const clientUserId = "user-123456";

		spyOn(database, "getMercChannelConfig").mockResolvedValue({
			contractCreation: null,
			upcomingContracts: null,
			targets: null,
			mercLog: null,
			clientCategory: null,
			archiveCategory: "archive-category",
		});

		let permEditedUser = "";
		let permOptions: Record<string, boolean> = {};
		let parentSetTo = "";
		let sentContent = "";

		const mockArchiveCat = {
			id: "cat-archive-999",
			name: "archive-category",
			type: ChannelType.GuildCategory,
		};

		const mockChannel = {
			id: channelId,
			name: "faction-test",
			parentId: "cat-active-111",
			type: ChannelType.GuildText,
			isTextBased: () => true,
			permissionOverwrites: {
				edit: mock(async (userId: string, opts: Record<string, boolean>) => {
					permEditedUser = userId;
					permOptions = opts;
				}),
			},
			setParent: mock(async (parentId: string) => {
				parentSetTo = parentId;
			}),
			send: mock(async (payload: { content: string }) => {
				sentContent = payload.content;
				return {};
			}),
		};

		const mockGuild = {
			id: guildId,
			name: "Test Guild",
			channels: {
				cache: new Map([
					[channelId, mockChannel],
					["cat-archive-999", mockArchiveCat],
				]),
				fetch: mock(async () => mockChannel),
			},
		};

		const mockClient = {
			guilds: {
				cache: new Map([[guildId, mockGuild]]),
				fetch: mock(async () => mockGuild),
			},
		} as unknown as Client;

		const success = await archiveMercClientChannel(
			mockClient,
			guildId,
			channelId,
			clientUserId,
			"Channel automatically archived because the contract creation link expired without submission. Client access has been revoked.",
		);

		expect(success).toBe(true);
		expect(permEditedUser).toBe(clientUserId);
		expect(permOptions.ViewChannel).toBe(false);
		expect(permOptions.SendMessages).toBe(false);
		expect(parentSetTo).toBe("cat-archive-999");
		expect(sentContent).toContain("Channel automatically archived");
	});

	it("processExpiredMercContractTokens auto-archives channels without active contract or newer token", async () => {
		const guildId = "guild-process-test";
		const channelId = "chan-process-1";
		const expiredTokenId = "token-expired-1";

		spyOn(database, "getExpiredUnusedMercContractTokens").mockResolvedValue([
			{
				token: expiredTokenId,
				guildId,
				channelId,
				discordUserId: "user-99",
				discordUsername: "User99",
				factionId: 7777,
				factionName: "Target Faction",
				used: false,
				archived: false,
				expiresAt: new Date(Date.now() - 120_000),
				createdAt: new Date(Date.now() - 1800_000),
			},
		]);

		spyOn(database, "hasActiveMercContractForChannel").mockResolvedValue(false);
		spyOn(database, "hasActiveMercContractTokenForChannel").mockResolvedValue(
			false,
		);

		let markedTokens: string[] = [];
		spyOn(database, "markMercContractTokensArchived").mockImplementation(
			async (tokens) => {
				markedTokens = tokens;
				return tokens.length;
			},
		);

		spyOn(database, "getMercChannelConfig").mockResolvedValue({
			contractCreation: null,
			upcomingContracts: null,
			targets: null,
			mercLog: null,
			clientCategory: null,
			archiveCategory: "archive-category",
		});

		let archivedCalled = false;
		const mockChannel = {
			id: channelId,
			name: "faction-7777",
			isTextBased: () => true,
			permissionOverwrites: {
				edit: mock(async () => {}),
			},
			setParent: mock(async () => {}),
			send: mock(async () => {
				archivedCalled = true;
				return {};
			}),
		};

		const mockGuild = {
			id: guildId,
			name: "Test Guild",
			channels: {
				cache: new Map([[channelId, mockChannel]]),
				fetch: mock(async () => mockChannel),
			},
		};

		const mockClient = {
			guilds: {
				cache: new Map([[guildId, mockGuild]]),
				fetch: mock(async () => mockGuild),
			},
		} as unknown as Client;

		const count = await processExpiredMercContractTokens(mockClient);
		expect(count).toBe(1);
		expect(archivedCalled).toBe(true);
		expect(markedTokens).toContain(expiredTokenId);
	});

	it("processExpiredMercContractTokens skips channel archiving if active contract or newer token exists", async () => {
		const guildId = "guild-skip-test";
		const channelWithContract = "chan-with-contract";
		const channelWithNewerToken = "chan-with-newer-token";

		spyOn(database, "getExpiredUnusedMercContractTokens").mockResolvedValue([
			{
				token: "token-exp-contract",
				guildId,
				channelId: channelWithContract,
				discordUserId: "user-1",
				discordUsername: "User1",
				factionId: 100,
				factionName: "Faction 1",
				used: false,
				archived: false,
				expiresAt: new Date(Date.now() - 60_000),
				createdAt: new Date(Date.now() - 1800_000),
			},
			{
				token: "token-exp-renewed",
				guildId,
				channelId: channelWithNewerToken,
				discordUserId: "user-2",
				discordUsername: "User2",
				factionId: 200,
				factionName: "Faction 2",
				used: false,
				archived: false,
				expiresAt: new Date(Date.now() - 60_000),
				createdAt: new Date(Date.now() - 1800_000),
			},
		]);

		spyOn(database, "hasActiveMercContractForChannel").mockImplementation(
			async (chId) => chId === channelWithContract,
		);
		spyOn(database, "hasActiveMercContractTokenForChannel").mockImplementation(
			async (chId) => chId === channelWithNewerToken,
		);

		let markedTokens: string[] = [];
		spyOn(database, "markMercContractTokensArchived").mockImplementation(
			async (tokens) => {
				markedTokens = tokens;
				return tokens.length;
			},
		);

		let channelSendCalled = false;
		const mockChannel = {
			id: "any",
			name: "any",
			isTextBased: () => true,
			permissionOverwrites: { edit: mock(async () => {}) },
			setParent: mock(async () => {}),
			send: mock(async () => {
				channelSendCalled = true;
				return {};
			}),
		};

		const mockGuild = {
			id: guildId,
			name: "Test Guild",
			channels: {
				cache: new Map([
					[channelWithContract, mockChannel],
					[channelWithNewerToken, mockChannel],
				]),
				fetch: mock(async () => mockChannel),
			},
		};

		const mockClient = {
			guilds: {
				cache: new Map([[guildId, mockGuild]]),
				fetch: mock(async () => mockGuild),
			},
		} as unknown as Client;

		const count = await processExpiredMercContractTokens(mockClient);
		expect(count).toBe(0);
		expect(channelSendCalled).toBe(false);
		// Tokens were marked archived so they don't get checked again
		expect(markedTokens).toEqual(["token-exp-contract", "token-exp-renewed"]);
	});
});
