import { describe, expect, it, mock } from "bun:test";
import type { IpcSubversiveRecruitmentAlertPayload } from "@sentinel/schemas";
import type { Client, EmbedBuilder } from "discord.js";
import { handleSubversiveRecruitmentAlert } from "../src/lib/recruitment-alert-distributor";

describe("Subversive Recruitment Alert Distributor", () => {
	it("dispatches embed with correct 'Days in Faction' stat when daysInFaction is provided", async () => {
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
			notificationChannelId: "channel-111",
		};

		await handleSubversiveRecruitmentAlert(mockClient, alertPayload);

		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(sentEmbed).toBeDefined();

		const fields = (
			sentEmbed as unknown as {
				data: {
					fields: Array<{ name: string; value: string; inline?: boolean }>;
				};
			}
		).data.fields;
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
			notificationChannelId: "channel-222",
		};

		await handleSubversiveRecruitmentAlert(mockClient, alertPayload);

		expect(mockSend).toHaveBeenCalledTimes(1);
		const fields = (
			sentEmbed as unknown as {
				data: { fields: Array<{ name: string; value: string }> };
			}
		).data.fields;
		const daysField = fields.find((f) => f.name === "Days in Faction");
		expect(daysField?.value).toBe("1 day");
	});

	it("displays 'Unknown' when daysInFaction is null or undefined", async () => {
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
			notificationChannelId: "channel-333",
		};

		await handleSubversiveRecruitmentAlert(mockClient, alertPayload);

		expect(mockSend).toHaveBeenCalledTimes(1);
		const fields = (
			sentEmbed as unknown as {
				data: { fields: Array<{ name: string; value: string }> };
			}
		).data.fields;
		const daysField = fields.find((f) => f.name === "Days in Faction");
		expect(daysField?.value).toBe("Unknown");
	});
});
