import { describe, expect, it, mock, spyOn } from "bun:test";
import * as database from "@sentinel/database";
import type {
	AttachmentBuilder,
	ChatInputCommandInteraction,
	EmbedBuilder,
	StringSelectMenuInteraction,
} from "discord.js";
import {
	createMercReceiptSelectActionRow,
	handleMercReceiptSelect,
	MERC_RECEIPT_SELECT_ID,
	receiptCommand,
} from "../src/commands/receipt";
import { buildMercContractReceiptPayload } from "../src/lib/merc-alert-distributor";

const mockContract: database.MercContract = {
	id: "test-contract-uuid-1234",
	guildId: "guild-100",
	factionId: 999,
	factionName: "Subversive",
	warStatusAtCreation: "active",
	warId: 54321,
	warStart: 1727889600,
	warEnd: 1727976000,
	warTarget: 500,
	warOpponent: { id: 888, name: "Opponent Faction" },
	startTime: "2026-10-02T10:00:00.000Z",
	startImmediately: true,
	startMinutesBeforeWar: null,
	endTime: "2026-10-03T10:00:00.000Z",
	endOnWarEnd: false,
	terms: {
		statuses: { online: true, idle: true, offline: false },
		idleDurationMinutes: 15,
		offlineDurationMinutes: null,
		strickenHits: false,
		levelRange: [1, 100],
	},
	hitPrice: 2000000,
	strickenHitPrice: null,
	autoStopPrice: null,
	changeTermsOnWarStart: false,
	warStartTerms: null,
	warStartHitPrice: null,
	warStartStrickenHitPrice: null,
	excludedMembers: [],
	pausedWindows: [],
	status: "completed",
	clientChannelId: null,
	clientDiscordId: null,
	upcomingMessageId: null,
	upcomingChannelId: null,
	createdAt: "2026-10-02T10:00:00.000Z",
	updatedAt: "2026-10-03T10:00:00.000Z",
	createdBy: null,
};

const mockSummary: database.MercContractSummaryReport = {
	contractId: mockContract.id,
	totalHits: 3,
	totalPayout: 6000000,
	mercPayouts: [
		{
			attackerId: 101,
			attackerName: "Mercenary One",
			attackerFactionId: 50,
			attackerFactionName: "Merc Faction",
			totalHits: 2,
			standardHits: 2,
			strickenHits: 0,
			totalPayout: 4000000,
		},
		{
			attackerId: 102,
			attackerName: "Mercenary Two",
			attackerFactionId: 60,
			attackerFactionName: "Second Faction",
			totalHits: 1,
			standardHits: 1,
			strickenHits: 0,
			totalPayout: 2000000,
		},
	],
	targetBreakdown: [
		{
			defenderId: 201,
			defenderName: "Target One",
			totalHits: 3,
			standardHitsReceived: 3,
			strickenHitsReceived: 0,
		},
	],
	factionPayouts: [
		{
			factionId: 50,
			factionName: "Merc Faction",
			totalHits: 2,
			totalPayout: 4000000,
			mercs: [
				{
					attackerId: 101,
					attackerName: "Mercenary One",
					attackerFactionId: 50,
					attackerFactionName: "Merc Faction",
					totalHits: 2,
					standardHits: 2,
					strickenHits: 0,
					totalPayout: 4000000,
				},
			],
		},
	],
};

describe("Mercenary Receipt Command & Payload Builder", () => {
	describe("buildMercContractReceiptPayload", () => {
		it("generates correct conclusion embed and attachments", () => {
			const payload = buildMercContractReceiptPayload(
				mockContract,
				mockSummary,
			);

			expect(payload.embed).toBeDefined();
			expect(payload.embed.data.title).toBe(
				"[CONTRACT CONCLUDED] Subversive [999]",
			);
			expect(payload.embed.data.description).toContain(
				"Total Validated Hits: 3",
			);
			expect(payload.embed.data.description).toContain(
				"Total Payout: $6,000,000",
			);

			// Files: combined merc payouts, faction payouts, target breakdown
			expect(payload.files.length).toBe(3);
			const fileNames = payload.files.map((f) => f.name);
			expect(fileNames).toContain(
				`merc_payouts_combined_${mockContract.id}.csv`,
			);
			expect(fileNames).toContain(
				`target_hit_breakdown_${mockContract.id}.csv`,
			);

			// Components: Live Web Receipt button
			expect(payload.components.length).toBe(1);
		});

		it("formats title appropriately for active/unconcluded contract", () => {
			const activeContract: database.MercContract = {
				...mockContract,
				status: "active",
			};
			const payload = buildMercContractReceiptPayload(
				activeContract,
				mockSummary,
			);

			expect(payload.embed.data.title).toBe(
				"[CONTRACT RECEIPT] Subversive [999]",
			);
			expect(payload.embed.data.description).toContain("Status: ACTIVE");
		});
	});

	describe("createMercReceiptSelectActionRow", () => {
		it("creates a select menu capped at 25 options with descriptive labels", () => {
			const contractsList: database.MercContract[] = Array.from(
				{ length: 30 },
				(_, i) => ({
					...mockContract,
					id: `contract-${i}`,
					warId: 1000 + i,
					factionName: `Faction ${i}`,
				}),
			);

			const actionRow = createMercReceiptSelectActionRow(contractsList);
			expect(actionRow).toBeDefined();

			const menu = actionRow
				.components[0] as import("discord.js").StringSelectMenuBuilder;
			const json = menu.toJSON() as {
				custom_id: string;
				options: Array<{ label: string; value: string; description: string }>;
			};

			expect(json.custom_id).toBe(MERC_RECEIPT_SELECT_ID);
			expect(json.options.length).toBe(25);
			expect(json.options[0]?.value).toBe("contract-0");
			expect(json.options[0]?.label).toContain("Faction 0 vs Opponent Faction");
			expect(json.options[0]?.description).toContain("War #1000");
		});
	});

	describe("receiptCommand.execute", () => {
		it("rejects execution outside of a guild", async () => {
			let replyPayload: { embeds?: EmbedBuilder[]; flags?: number } = {};
			const mockInteraction = {
				guildId: null,
				reply: mock(async (payload) => {
					replyPayload = payload;
				}),
			} as unknown as ChatInputCommandInteraction;

			await receiptCommand.execute(mockInteraction);
			expect(replyPayload.embeds?.[0]?.data.title).toBe("Guild Only");
		});

		it("informs user when no contracts exist for the guild", async () => {
			spyOn(database, "getMercContracts").mockResolvedValueOnce([]);

			let replyPayload: { embeds?: EmbedBuilder[]; flags?: number } = {};
			const mockInteraction = {
				guildId: "guild-empty",
				options: {
					getBoolean: mock(() => false),
					getString: mock(() => null),
				},
				reply: mock(async (payload) => {
					replyPayload = payload;
				}),
			} as unknown as ChatInputCommandInteraction;

			await receiptCommand.execute(mockInteraction);
			expect(replyPayload.embeds?.[0]?.data.title).toBe("No Contracts Found");
		});

		it("returns select menu embed when contracts exist and no direct contract ID passed", async () => {
			spyOn(database, "getMercContracts").mockResolvedValueOnce([mockContract]);

			let replyPayload: {
				embeds?: EmbedBuilder[];
				components?: unknown[];
				flags?: number;
			} = {};

			const mockInteraction = {
				guildId: "guild-100",
				options: {
					getBoolean: mock(() => false),
					getString: mock(() => null),
				},
				reply: mock(async (payload) => {
					replyPayload = payload;
				}),
			} as unknown as ChatInputCommandInteraction;

			await receiptCommand.execute(mockInteraction);
			expect(replyPayload.embeds?.[0]?.data.title).toBe(
				"Mercenary Contract Receipts",
			);
			expect(replyPayload.components?.length).toBe(1);
		});

		it("directly returns receipt embed & CSV files when contract option is provided", async () => {
			spyOn(database, "getMercContractById").mockResolvedValueOnce(
				mockContract,
			);
			spyOn(database, "getMercContractSummary").mockResolvedValueOnce(
				mockSummary,
			);

			let editReplyPayload: {
				embeds?: EmbedBuilder[];
				files?: AttachmentBuilder[];
				components?: unknown[];
			} = {};

			const mockInteraction = {
				guildId: "guild-100",
				options: {
					getBoolean: mock(() => false),
					getString: mock((name: string) =>
						name === "contract" ? mockContract.id : null,
					),
				},
				deferReply: mock(async () => {}),
				editReply: mock(async (payload) => {
					editReplyPayload = payload;
				}),
			} as unknown as ChatInputCommandInteraction;

			await receiptCommand.execute(mockInteraction);
			expect(mockInteraction.deferReply).toHaveBeenCalled();
			expect(editReplyPayload.embeds?.[0]?.data.title).toBe(
				"[CONTRACT CONCLUDED] Subversive [999]",
			);
			expect(editReplyPayload.files?.length).toBe(3);
			expect(editReplyPayload.components?.length).toBe(1);
		});
	});

	describe("handleMercReceiptSelect", () => {
		it("processes dropdown selection and edits message with receipt summary and CSVs", async () => {
			spyOn(database, "getMercContractById").mockResolvedValueOnce(
				mockContract,
			);
			spyOn(database, "getMercContractSummary").mockResolvedValueOnce(
				mockSummary,
			);

			let editReplyPayload: {
				embeds?: EmbedBuilder[];
				files?: AttachmentBuilder[];
				components?: unknown[];
			} = {};

			const mockInteraction = {
				customId: MERC_RECEIPT_SELECT_ID,
				values: [mockContract.id],
				guildId: "guild-100",
				deferUpdate: mock(async () => {}),
				editReply: mock(async (payload) => {
					editReplyPayload = payload;
				}),
			} as unknown as StringSelectMenuInteraction;

			await handleMercReceiptSelect(mockInteraction);

			expect(mockInteraction.deferUpdate).toHaveBeenCalled();
			expect(editReplyPayload.embeds?.[0]?.data.title).toBe(
				"[CONTRACT CONCLUDED] Subversive [999]",
			);
			expect(editReplyPayload.files?.length).toBe(3);
		});
	});
});
