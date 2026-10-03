import { describe, expect, it, mock, spyOn } from "bun:test";
import * as database from "@sentinel/database";
import type { Client } from "discord.js";
import {
	parseToEpochSeconds,
	postMercContractAnnouncement,
	postMercHitLog,
} from "../src/lib/merc-alert-distributor";

describe("Merc Alert Distributor Timestamps & Formatting", () => {
	describe("parseToEpochSeconds", () => {
		it("correctly parses numeric epoch seconds", () => {
			const epochSec = 1727889600;
			expect(parseToEpochSeconds(epochSec)).toBe(1727889600);
		});

		it("correctly parses numeric epoch milliseconds", () => {
			const epochMs = 1727889600000;
			expect(parseToEpochSeconds(epochMs)).toBe(1727889600);
		});

		it("correctly parses string epoch seconds", () => {
			expect(parseToEpochSeconds("1727889600")).toBe(1727889600);
		});

		it("correctly parses string epoch milliseconds", () => {
			expect(parseToEpochSeconds("1727889600000")).toBe(1727889600);
		});

		it("correctly parses Date objects", () => {
			const date = new Date("2026-10-02T17:20:00.000Z");
			expect(parseToEpochSeconds(date)).toBe(Math.floor(date.getTime() / 1000));
		});

		it("correctly parses ISO strings", () => {
			const iso = "2026-10-02T17:20:00.000Z";
			const expected = Math.floor(new Date(iso).getTime() / 1000);
			expect(parseToEpochSeconds(iso)).toBe(expected);
		});
	});

	describe("postMercHitLog", () => {
		it("formats hit time in TCT and sends embed with zero emojis", async () => {
			let sentPayload: { embeds?: unknown[] } = {};
			const mockChannel = {
				name: "merc-logs",
				isTextBased: () => true,
				send: mock(async (payload: { embeds?: unknown[] }) => {
					sentPayload = payload;
					return {};
				}),
			};

			const mockGuild = {
				id: "guild-test",
				name: "Test Guild",
				channels: {
					cache: new Map([["merc-logs", mockChannel]]),
					fetch: mock(async () => new Map([["merc-logs", mockChannel]])),
				},
			};

			const mockClient = {
				guilds: {
					cache: new Map([[mockGuild.id, mockGuild]]),
					fetch: mock(async () => mockGuild),
				},
			} as unknown as Client;

			await postMercHitLog(mockClient, mockGuild.id, "merc-logs", {
				attackerName: "MercenaryOne",
				attackerId: 101,
				defenderName: "TargetEnemy",
				defenderId: 202,
				result: "Hospitalized",
				isStricken: false,
				payoutValue: 3000000,
				attackId: 999001,
				attackCode: "code123",
				timestamp: 1727889600, // 2024-10-02 17:20:00 UTC
			});

			expect(mockChannel.send).toHaveBeenCalled();
			expect(sentPayload.embeds).toBeDefined();
			const embed = (
				sentPayload.embeds as Array<{
					data: {
						fields: Array<{ name: string; value: string; inline?: boolean }>;
					};
				}>
			)[0];
			expect(embed).toBeDefined();
			const timeField = embed?.data.fields.find((f) => f.name === "Time");
			expect(timeField).toBeDefined();
			expect(timeField?.value).toContain("TCT");
			expect(timeField?.value).toContain("<t:1727889600:R>");
		});
	});

	describe("postMercContractAnnouncement", () => {
		it("formats start and end times in TCT", async () => {
			let sentPayload: { embeds?: unknown[] } = {};
			const mockChannel = {
				id: "chan-upcoming",
				name: "upcoming-contracts",
				isTextBased: () => true,
				send: mock(async (payload: { embeds?: unknown[] }) => {
					sentPayload = payload;
					return { id: "msg-123" };
				}),
			};

			const mockGuild = {
				id: "guild-test",
				name: "Test Guild",
				channels: {
					cache: new Map([["upcoming-contracts", mockChannel]]),
					fetch: mock(
						async () => new Map([["upcoming-contracts", mockChannel]]),
					),
				},
			};

			const mockClient = {
				guilds: {
					cache: new Map([[mockGuild.id, mockGuild]]),
					fetch: mock(async () => mockGuild),
				},
			} as unknown as Client;

			spyOn(database, "getMercChannelConfig").mockResolvedValue({
				contractCreation: null,
				pastContracts: null,
				upcomingContracts: "upcoming-contracts",
				targets: null,
				mercLog: null,
				clientCategory: null,
				archiveCategory: null,
			});

			const contract: database.MercContract = {
				id: "contract-announcement-test",
				guildId: mockGuild.id,
				factionId: 5555,
				factionName: "TargetFaction",
				warStatusAtCreation: "upcoming",
				startTime: "2026-10-05T18:00:00.000Z",
				endTime: "2026-10-07T18:00:00.000Z",
				endOnWarEnd: false,
				terms: {
					statuses: { online: true, idle: true, offline: false },
					idleDurationMinutes: 15,
					strickenHits: false,
					levelRange: [1, 100],
				},
				hitPrice: 3000000,
				status: "upcoming",
				createdAt: new Date().toISOString(),
			};

			await postMercContractAnnouncement(
				mockClient,
				mockGuild.id,
				"upcoming-contracts",
				contract,
			);

			expect(mockChannel.send).toHaveBeenCalled();
			const embed = (
				sentPayload.embeds as Array<{
					data: {
						fields: Array<{ name: string; value: string; inline?: boolean }>;
					};
				}>
			)[0];
			expect(embed).toBeDefined();
			const startField = embed?.data.fields.find(
				(f) => f.name === "Start Time",
			);
			const endField = embed?.data.fields.find((f) => f.name === "End Time");

			expect(startField?.value).toContain("TCT");
			expect(endField?.value).toContain("TCT");
		});
	});
});
