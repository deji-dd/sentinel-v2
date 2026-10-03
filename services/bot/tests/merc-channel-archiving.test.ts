import { describe, expect, it, mock, spyOn } from "bun:test";
import * as database from "@sentinel/database";
import {
	ChannelType,
	type Client,
	OverwriteType,
	PermissionFlagsBits,
} from "discord.js";
import {
	archiveMercClientChannel,
	cleanupOldArchivedMercChannels,
	processExpiredMercContractTokens,
} from "../src/lib/merc-contract-creation";

describe("Mercenary Channel Archiving on Token Expiration", () => {
	it("archiveMercClientChannel strips client permissions, moves to archive category, and sends notice", async () => {
		const guildId = "guild-archive-test";
		const channelId = "chan-archive-test";
		const clientUserId = "user-123456";

		spyOn(database, "getMercChannelConfig").mockResolvedValue({
			contractCreation: null,
			pastContracts: null,
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

	it("archiveMercClientChannel renames channel when name clashes in archive category", async () => {
		const guildId = "guild-clash-test";
		const channelId = "chan-to-archive";
		const clientUserId = "user-123456";

		spyOn(database, "getMercChannelConfig").mockResolvedValue({
			contractCreation: null,
			pastContracts: null,
			upcomingContracts: null,
			targets: null,
			mercLog: null,
			clientCategory: null,
			archiveCategory: "archive-category",
		});

		const mockArchiveCat = {
			id: "cat-archive-999",
			name: "archive-category",
			type: ChannelType.GuildCategory,
		};

		// An existing channel already in the archive category with the same name "torn-syndicate"
		const existingArchivedChannel = {
			id: "chan-already-archived",
			name: "torn-syndicate",
			parentId: "cat-archive-999",
			type: ChannelType.GuildText,
			isTextBased: () => true,
		};

		let newNameSet = "";
		let topicSet = "";
		const channelToArchive = {
			id: channelId,
			name: "torn-syndicate",
			parentId: "cat-active-111",
			type: ChannelType.GuildText,
			isTextBased: () => true,
			permissionOverwrites: {
				edit: mock(async () => {}),
			},
			setName: mock(async (newName: string) => {
				newNameSet = newName;
			}),
			setParent: mock(async () => {}),
			setTopic: mock(async (topic: string) => {
				topicSet = topic;
			}),
			send: mock(async () => ({})),
		};

		const mockGuild = {
			id: guildId,
			name: "Test Guild",
			channels: {
				cache: new Map<string, unknown>([
					[channelId, channelToArchive],
					["chan-already-archived", existingArchivedChannel],
					["cat-archive-999", mockArchiveCat],
				]),
				fetch: mock(async () => channelToArchive),
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
		);

		expect(success).toBe(true);
		// Should have been renamed to avoid clash
		expect(newNameSet).toContain("torn-syndicate-");
		expect(newNameSet.length).toBeGreaterThan("torn-syndicate".length);
		// Topic should record archive ISO timestamp for retention cleanup
		expect(topicSet).toContain("Archived on");
		expect(topicSet).toContain("Mercenary Client Channel");
	});

	it("cleanupOldArchivedMercChannels deletes channels older than 7 days and preserves newer ones", async () => {
		const guildId = "guild-cleanup-test";

		spyOn(database, "getMercChannelConfig").mockResolvedValue({
			contractCreation: null,
			pastContracts: null,
			upcomingContracts: null,
			targets: null,
			mercLog: null,
			clientCategory: null,
			archiveCategory: "archive-category",
		});

		const mockArchiveCat = {
			id: "cat-archive-999",
			name: "archive-category",
			type: ChannelType.GuildCategory,
		};

		let oldChannelDeleted = false;
		let recentChannelDeleted = false;

		const eightDaysAgoIso = new Date(
			Date.now() - 8 * 24 * 60 * 60 * 1000,
		).toISOString();
		const twoDaysAgoIso = new Date(
			Date.now() - 2 * 24 * 60 * 60 * 1000,
		).toISOString();

		const oldArchivedChannel = {
			id: "chan-old",
			name: "torn-syndicate-old",
			parentId: "cat-archive-999",
			type: ChannelType.GuildText,
			topic: `Archived on ${eightDaysAgoIso} | Mercenary Client Channel`,
			delete: mock(async () => {
				oldChannelDeleted = true;
			}),
		};

		const recentArchivedChannel = {
			id: "chan-recent",
			name: "torn-syndicate-recent",
			parentId: "cat-archive-999",
			type: ChannelType.GuildText,
			topic: `Archived on ${twoDaysAgoIso} | Mercenary Client Channel`,
			delete: mock(async () => {
				recentChannelDeleted = true;
			}),
		};

		const mockGuild = {
			id: guildId,
			name: "Test Guild",
			channels: {
				cache: new Map<string, unknown>([
					["chan-old", oldArchivedChannel],
					["chan-recent", recentArchivedChannel],
					["cat-archive-999", mockArchiveCat],
				]),
				fetch: mock(async () => {}),
			},
		};

		const mockClient = {
			guilds: {
				cache: new Map([[guildId, mockGuild]]),
			},
		} as unknown as Client;

		const cleanedCount = await cleanupOldArchivedMercChannels(mockClient, 7);

		expect(cleanedCount).toBe(1);
		expect(oldChannelDeleted).toBe(true);
		expect(recentChannelDeleted).toBe(false);
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
			pastContracts: null,
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

	it("archiveMercClientChannel removes all non-admin users and preserves administrators and bot", async () => {
		const guildId = "guild-users-removal-test";
		const channelId = "chan-removal-test";
		const botId = "bot-app-id";
		const adminUserId = "user-admin";
		const regularUserId1 = "user-regular-1";
		const regularUserId2 = "user-regular-2";
		const managerRoleId = "role-manager";

		spyOn(database, "getMercChannelConfig").mockResolvedValue({
			contractCreation: null,
			pastContracts: null,
			upcomingContracts: null,
			targets: null,
			mercLog: null,
			clientCategory: null,
			archiveCategory: null,
		});

		const deletedOverwrites: string[] = [];
		const editedOverwrites: Record<string, Record<string, boolean>> = {};

		const mockChannel = {
			id: channelId,
			name: "faction-cleanup",
			type: ChannelType.GuildText,
			isTextBased: () => true,
			permissionOverwrites: {
				cache: new Map([
					[
						botId,
						{
							id: botId,
							type: OverwriteType.Member,
						},
					],
					[
						adminUserId,
						{
							id: adminUserId,
							type: OverwriteType.Member,
						},
					],
					[
						regularUserId1,
						{
							id: regularUserId1,
							type: OverwriteType.Member,
						},
					],
					[
						regularUserId2,
						{
							id: regularUserId2,
							type: OverwriteType.Member,
						},
					],
					[
						managerRoleId,
						{
							id: managerRoleId,
							type: OverwriteType.Role,
						},
					],
				]),
				delete: mock(async (id: string) => {
					deletedOverwrites.push(id);
				}),
				edit: mock(async (id: string, opts: Record<string, boolean>) => {
					editedOverwrites[id] = opts;
				}),
			},
			send: mock(async () => ({})),
		};

		const mockGuild = {
			id: guildId,
			name: "Test Guild",
			roles: {
				everyone: { id: "role-everyone" },
			},
			members: {
				cache: new Map([
					[
						adminUserId,
						{
							id: adminUserId,
							permissions: {
								has: (flag: bigint) =>
									flag === PermissionFlagsBits.Administrator,
							},
						},
					],
					[
						regularUserId1,
						{
							id: regularUserId1,
							permissions: {
								has: () => false,
							},
						},
					],
					[
						regularUserId2,
						{
							id: regularUserId2,
							permissions: {
								has: () => false,
							},
						},
					],
				]),
				fetch: mock(async () => null),
			},
			channels: {
				cache: new Map([[channelId, mockChannel]]),
				fetch: mock(async () => mockChannel),
			},
		};

		const mockClient = {
			user: { id: botId },
			guilds: {
				cache: new Map([[guildId, mockGuild]]),
				fetch: mock(async () => mockGuild),
			},
		} as unknown as Client;

		const success = await archiveMercClientChannel(
			mockClient,
			guildId,
			channelId,
			regularUserId1,
			"Channel archived due to expiry",
		);

		expect(success).toBe(true);
		// Both regular users should be deleted from channel overwrites
		expect(deletedOverwrites).toContain(regularUserId1);
		expect(deletedOverwrites).toContain(regularUserId2);
		// Bot and server admin must NOT be deleted
		expect(deletedOverwrites).not.toContain(botId);
		expect(deletedOverwrites).not.toContain(adminUserId);
		// Role overwrites must NOT be deleted
		expect(deletedOverwrites).not.toContain(managerRoleId);
		// @everyone must have ViewChannel set to false
		expect(editedOverwrites["role-everyone"]?.ViewChannel).toBe(false);
	});
});
