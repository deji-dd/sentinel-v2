import { describe, expect, it, mock, spyOn } from "bun:test";
import type { IpcSubversiveRecruitmentAlertPayload } from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
import type { Client, EmbedBuilder } from "discord.js";
import {
	handleSubversiveRecruitmentAlert,
	isLeaderRole,
} from "../src/lib/recruitment-alert-distributor";

describe("Subversive Recruitment Alert Distributor", () => {
	describe("isLeaderRole helper", () => {
		it("correctly identifies leader and co-leader variations", () => {
			expect(isLeaderRole("Leader")).toBe(true);
			expect(isLeaderRole("leader")).toBe(true);
			expect(isLeaderRole("  Leader  ")).toBe(true);
			expect(isLeaderRole("Co-leader")).toBe(true);
			expect(isLeaderRole("co-leader")).toBe(true);
			expect(isLeaderRole("Co-Leader")).toBe(true);
			expect(isLeaderRole("coleader")).toBe(true);
		});

		it("returns false for regular roles, null, or undefined", () => {
			expect(isLeaderRole("Member")).toBe(false);
			expect(isLeaderRole("Grill Master")).toBe(false);
			expect(isLeaderRole("Squad Leader")).toBe(false);
			expect(isLeaderRole("Vegan")).toBe(false);
			expect(isLeaderRole("")).toBe(false);
			expect(isLeaderRole(null)).toBe(false);
			expect(isLeaderRole(undefined)).toBe(false);
		});
	});

	it("dispatches embed with correct 'Days in Faction' and 'Faction Role' when provided", async () => {
		let sentEmbed: EmbedBuilder | undefined;
		const mockSend = mock(async (payload: { embeds: EmbedBuilder[] }) => {
			sentEmbed = payload.embeds[0];
			return {};
		});

		const mockClient = {
			channels: {
				fetch: mock(async () => ({
					isTextBased: () => true,
					send: mockSend,
				})),
			},
		} as unknown as Client;

		const alertPayload: IpcSubversiveRecruitmentAlertPayload = {
			candidateId: "uuid-1",
			playerId: 123456,
			playerName: "JohnDoe",
			playerLevel: 75,
			factionId: 999,
			factionName: "Alpha Faction",
			warId: 8888,
			attacks: 42,
			factionTotalAttacks: 350,
			attackPercentage: 12.0,
			score: 5200,
			bsEstimate: 250_000_000,
			fairFight: 2.1,
			daysInFaction: 142,
			factionRole: "Grill Master",
			notificationChannelId: "channel-111",
		};

		const result = await handleSubversiveRecruitmentAlert(
			mockClient,
			alertPayload,
		);

		expect(result).toBe(true);
		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(sentEmbed).toBeDefined();

		const fields = (
			sentEmbed as unknown as {
				data: {
					fields: Array<{ name: string; value: string; inline?: boolean }>;
				};
			}
		).data.fields;

		const roleField = fields.find((f) => f.name === "Faction Role");
		expect(roleField).toBeDefined();
		expect(roleField?.value).toBe("Grill Master");
		expect(roleField?.inline).toBe(true);

		const daysField = fields.find((f) => f.name === "Days in Faction");
		expect(daysField).toBeDefined();
		expect(daysField?.value).toBe("142 days");
		expect(daysField?.inline).toBe(true);

		const factionField = fields.find((f) => f.name === "Faction");
		expect(factionField?.value).toContain("Alpha Faction");
		expect(factionField?.value).toContain("999");

		const statsField = fields.find((f) => f.name === "Estimated Stats");
		expect(statsField?.value).toBe("250.00M (FF: 2.10)");
	});

	it("formats singular '1 day' when daysInFaction is 1", async () => {
		let sentEmbed: EmbedBuilder | undefined;
		const mockSend = mock(async (payload: { embeds: EmbedBuilder[] }) => {
			sentEmbed = payload.embeds[0];
			return {};
		});

		const mockClient = {
			channels: {
				fetch: mock(async () => ({
					isTextBased: () => true,
					send: mockSend,
				})),
			},
		} as unknown as Client;

		const alertPayload: IpcSubversiveRecruitmentAlertPayload = {
			candidateId: "uuid-2",
			playerId: 654321,
			playerName: "JaneDoe",
			playerLevel: 50,
			factionId: 1000,
			factionName: "Beta Faction",
			warId: 8888,
			attacks: 20,
			factionTotalAttacks: 200,
			attackPercentage: 10.0,
			score: 2000,
			bsEstimate: null,
			fairFight: null,
			daysInFaction: 1,
			factionRole: "Member",
			notificationChannelId: "channel-222",
		};

		const result = await handleSubversiveRecruitmentAlert(
			mockClient,
			alertPayload,
		);

		expect(result).toBe(true);
		expect(mockSend).toHaveBeenCalledTimes(1);
		const fields = (
			sentEmbed as unknown as {
				data: { fields: Array<{ name: string; value: string }> };
			}
		).data.fields;

		const daysField = fields.find((f) => f.name === "Days in Faction");
		expect(daysField?.value).toBe("1 day");

		const roleField = fields.find((f) => f.name === "Faction Role");
		expect(roleField?.value).toBe("Member");
	});

	it("displays 'Unknown' when daysInFaction and factionRole are null or undefined", async () => {
		let sentEmbed: EmbedBuilder | undefined;
		const mockSend = mock(async (payload: { embeds: EmbedBuilder[] }) => {
			sentEmbed = payload.embeds[0];
			return {};
		});

		const mockClient = {
			channels: {
				fetch: mock(async () => ({
					isTextBased: () => true,
					send: mockSend,
				})),
			},
		} as unknown as Client;

		const alertPayload: IpcSubversiveRecruitmentAlertPayload = {
			candidateId: "uuid-3",
			playerId: 789012,
			playerName: "MysteryPlayer",
			playerLevel: 60,
			factionId: 1001,
			factionName: "Gamma Faction",
			warId: 8888,
			attacks: 30,
			factionTotalAttacks: 300,
			attackPercentage: 10.0,
			score: 3000,
			bsEstimate: 1_500_000_000,
			fairFight: 3.0,
			daysInFaction: null,
			factionRole: null,
			notificationChannelId: "channel-333",
		};

		const result = await handleSubversiveRecruitmentAlert(
			mockClient,
			alertPayload,
		);

		expect(result).toBe(true);
		expect(mockSend).toHaveBeenCalledTimes(1);
		const fields = (
			sentEmbed as unknown as {
				data: { fields: Array<{ name: string; value: string }> };
			}
		).data.fields;

		const daysField = fields.find((f) => f.name === "Days in Faction");
		expect(daysField?.value).toBe("Unknown");

		const roleField = fields.find((f) => f.name === "Faction Role");
		expect(roleField?.value).toBe("Unknown");
	});

	it("auto-excludes candidate with role 'Leader'", async () => {
		const mockSend = mock(async () => ({}));
		const mockClient = {
			channels: {
				fetch: mock(async () => ({
					isTextBased: () => true,
					send: mockSend,
				})),
			},
		} as unknown as Client;

		const alertPayload: IpcSubversiveRecruitmentAlertPayload = {
			candidateId: "uuid-leader",
			playerId: 999001,
			playerName: "BossMan",
			playerLevel: 100,
			factionId: 2013,
			factionName: "Omega Faction",
			warId: 9999,
			attacks: 80,
			factionTotalAttacks: 400,
			attackPercentage: 20.0,
			score: 10000,
			bsEstimate: 5_000_000_000,
			fairFight: 3.5,
			daysInFaction: 1000,
			factionRole: "Leader",
			notificationChannelId: "channel-alerts",
		};

		const result = await handleSubversiveRecruitmentAlert(
			mockClient,
			alertPayload,
		);

		expect(result).toBe(false);
		expect(mockSend).toHaveBeenCalledTimes(0);
	});

	it("auto-excludes candidate with role 'Co-leader' (case-insensitive)", async () => {
		const mockSend = mock(async () => ({}));
		const mockClient = {
			channels: {
				fetch: mock(async () => ({
					isTextBased: () => true,
					send: mockSend,
				})),
			},
		} as unknown as Client;

		const alertPayload: IpcSubversiveRecruitmentAlertPayload = {
			candidateId: "uuid-co-leader",
			playerId: 999002,
			playerName: "RightHandMan",
			playerLevel: 95,
			factionId: 2013,
			factionName: "Omega Faction",
			warId: 9999,
			attacks: 65,
			factionTotalAttacks: 400,
			attackPercentage: 16.25,
			score: 8000,
			bsEstimate: 4_000_000_000,
			fairFight: 3.2,
			daysInFaction: 900,
			factionRole: "co-leader",
			notificationChannelId: "channel-alerts",
		};

		const result = await handleSubversiveRecruitmentAlert(
			mockClient,
			alertPayload,
		);

		expect(result).toBe(false);
		expect(mockSend).toHaveBeenCalledTimes(0);
	});

	it("fetches faction role from Torn API if factionRole is undefined and excludes leader", async () => {
		const mockSend = mock(async () => ({}));
		const mockClient = {
			channels: {
				fetch: mock(async () => ({
					isTextBased: () => true,
					send: mockSend,
				})),
			},
		} as unknown as Client;

		const prevEnv = process.env.TORN_API_KEY;
		process.env.TORN_API_KEY = "mock-api-key";

		const apiSpy = spyOn(tornApi, "get").mockImplementation((async () => ({
			members: [
				{
					id: 112233,
					name: "FactionLeader",
					position: "Leader",
					level: 90,
					days_in_faction: 500,
				},
			],
		})) as unknown as typeof tornApi.get);

		try {
			const alertPayload: IpcSubversiveRecruitmentAlertPayload = {
				candidateId: "uuid-fetch-leader",
				playerId: 112233,
				playerName: "FactionLeader",
				playerLevel: 90,
				factionId: 5555,
				factionName: "Theta Faction",
				warId: 1234,
				attacks: 50,
				factionTotalAttacks: 200,
				attackPercentage: 25.0,
				score: 5000,
				bsEstimate: 1_000_000_000,
				fairFight: 2.5,
				daysInFaction: 500,
				notificationChannelId: "channel-alerts",
			};

			const result = await handleSubversiveRecruitmentAlert(
				mockClient,
				alertPayload,
			);

			expect(result).toBe(false);
			expect(apiSpy).toHaveBeenCalledTimes(1);
			expect(mockSend).toHaveBeenCalledTimes(0);
		} finally {
			apiSpy.mockRestore();
			process.env.TORN_API_KEY = prevEnv;
		}
	});

	it("fetches faction role from Torn API if factionRole is undefined and dispatches for regular member", async () => {
		let sentEmbed: EmbedBuilder | undefined;
		const mockSend = mock(async (payload: { embeds: EmbedBuilder[] }) => {
			sentEmbed = payload.embeds[0];
			return {};
		});

		const mockClient = {
			channels: {
				fetch: mock(async () => ({
					isTextBased: () => true,
					send: mockSend,
				})),
			},
		} as unknown as Client;

		const prevEnv = process.env.TORN_API_KEY;
		process.env.TORN_API_KEY = "mock-api-key";

		const apiSpy = spyOn(tornApi, "get").mockImplementation((async () => ({
			members: [
				{
					id: 445566,
					name: "RegularGuy",
					position: "Elite Fighter",
					level: 85,
					days_in_faction: 300,
				},
			],
		})) as unknown as typeof tornApi.get);

		try {
			const alertPayload: IpcSubversiveRecruitmentAlertPayload = {
				candidateId: "uuid-fetch-member",
				playerId: 445566,
				playerName: "RegularGuy",
				playerLevel: 85,
				factionId: 5555,
				factionName: "Theta Faction",
				warId: 1234,
				attacks: 35,
				factionTotalAttacks: 200,
				attackPercentage: 17.5,
				score: 3500,
				bsEstimate: 800_000_000,
				fairFight: 2.0,
				daysInFaction: 300,
				notificationChannelId: "channel-alerts",
			};

			const result = await handleSubversiveRecruitmentAlert(
				mockClient,
				alertPayload,
			);

			expect(result).toBe(true);
			expect(apiSpy).toHaveBeenCalledTimes(1);
			expect(mockSend).toHaveBeenCalledTimes(1);

			const fields = (
				sentEmbed as unknown as {
					data: { fields: Array<{ name: string; value: string }> };
				}
			).data.fields;
			const roleField = fields.find((f) => f.name === "Faction Role");
			expect(roleField?.value).toBe("Elite Fighter");
		} finally {
			apiSpy.mockRestore();
			process.env.TORN_API_KEY = prevEnv;
		}
	});
});
