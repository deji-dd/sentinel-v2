import { describe, expect, it, mock } from "bun:test";
import type {
	MercContract,
	MercContractSummaryReport,
} from "@sentinel/database";
import type { Client } from "discord.js";
import { Collection } from "discord.js";
import {
	buildTargetHitBreakdownCsv,
	postMercContractPaid,
} from "../src/lib/merc-alert-distributor";

const emptySummary = (
	overrides: Partial<MercContractSummaryReport> = {},
): MercContractSummaryReport => ({
	contractId: "contract-paid-test",
	totalHits: 0,
	totalPayout: 0,
	mercPayouts: [],
	factionPayouts: [],
	targetBreakdown: [],
	...overrides,
});

const completedContract = (
	overrides: Partial<MercContract> = {},
): MercContract => ({
	id: "contract-paid-test",
	guildId: "guild-test",
	factionId: 4242,
	factionName: "Aspirants",
	warStatusAtCreation: "no_war",
	startTime: "2026-10-01T18:00:00.000Z",
	endTime: "2026-10-02T18:00:00.000Z",
	endOnWarEnd: false,
	terms: {
		statuses: { online: true, idle: true, offline: false },
		idleDurationMinutes: 15,
		strickenHits: false,
		levelRange: [1, 100],
	},
	hitPrice: 3000000,
	status: "completed",
	paidAt: "2026-10-03T12:00:00.000Z",
	createdAt: "2026-10-01T12:00:00.000Z",
	...overrides,
});

type SentPayload = { embeds?: unknown[]; files?: unknown[] };

/**
 * Builds a minimal client whose guild exposes a single text channel under
 * `channelName`, mirroring how `resolveChannelByName` looks channels up.
 */
function makeClient(channelName: string) {
	const sentPayloads: SentPayload[] = [];

	const mockChannel = {
		id: "chan-past",
		name: channelName,
		isTextBased: () => true,
		send: mock(async (payload: SentPayload) => {
			sentPayloads.push(payload);
			return { id: "msg-paid-1" };
		}),
	};

	// `resolveChannelByName` relies on Collection helpers (`.find`, `.size`), so the
	// mock must use a real Collection rather than a bare Map.
	const mockGuild = {
		id: "guild-test",
		name: "Test Guild",
		channels: {
			cache: new Collection([[mockChannel.id, mockChannel]]),
			fetch: mock(async () => new Collection([[mockChannel.id, mockChannel]])),
		},
	};

	const client = {
		guilds: {
			cache: new Collection([[mockGuild.id, mockGuild]]),
			fetch: mock(async () => mockGuild),
		},
	} as unknown as Client;

	return { client, mockChannel, sentPayloads };
}

/**
 * Embeds are sent as `EmbedBuilder` instances, so the rendered payload lives
 * on `.data` (or via `toJSON()`) rather than directly on the builder.
 */
const firstEmbed = (payload: SentPayload | undefined) => {
	const embed = (
		payload?.embeds as Array<{ data: { title?: string; description?: string } }>
	)?.[0];
	return embed?.data;
};

describe("buildTargetHitBreakdownCsv", () => {
	it("emits the header row even when there are no targets", () => {
		const csv = buildTargetHitBreakdownCsv(emptySummary());
		expect(csv).toBe(
			"Target Name,Torn ID,Total Times Hit,Standard Hits Received,Stricken Hits Received\n",
		);
	});

	it("renders one row per target with the agreed column order", () => {
		const csv = buildTargetHitBreakdownCsv(
			emptySummary({
				targetBreakdown: [
					{
						defenderId: 111,
						defenderName: "Alpha",
						totalHits: 4,
						standardHitsReceived: 3,
						strickenHitsReceived: 1,
					},
					{
						defenderId: 222,
						defenderName: "Bravo",
						totalHits: 2,
						standardHitsReceived: 2,
						strickenHitsReceived: 0,
					},
				],
			}),
		);

		const lines = csv.trim().split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[1]).toBe('"Alpha",111,4,3,1');
		expect(lines[2]).toBe('"Bravo",222,2,2,0');
	});

	it("escapes embedded quotes per RFC 4180 so the row stays parseable", () => {
		const csv = buildTargetHitBreakdownCsv(
			emptySummary({
				targetBreakdown: [
					{
						defenderId: 333,
						defenderName: 'The "Bold" One',
						totalHits: 1,
						standardHitsReceived: 1,
						strickenHitsReceived: 0,
					},
				],
			}),
		);

		expect(csv).toContain('"The ""Bold"" One",333,1,1,0');
	});
});

describe("postMercContractPaid", () => {
	it("announces the payment with hits, payout, and the merc CSVs attached", async () => {
		const { client, mockChannel, sentPayloads } = makeClient("past-contracts");

		const summary = emptySummary({
			totalHits: 12,
			totalPayout: 45000000,
			mercPayouts: [
				{
					attackerId: 1,
					attackerName: "MercOne",
					attackerFactionId: 1111,
					attackerFactionName: "Uphills",
					totalHits: 7,
					standardHits: 7,
					strickenHits: 0,
					totalPayout: 21000000,
				},
				{
					attackerId: 2,
					attackerName: "MercTwo",
					attackerFactionId: 2222,
					attackerFactionName: "Wanderers",
					totalHits: 5,
					standardHits: 4,
					strickenHits: 1,
					totalPayout: 24000000,
				},
			],
			factionPayouts: [
				{
					factionId: 1111,
					factionName: "Uphills",
					totalHits: 7,
					totalPayout: 21000000,
					mercs: [
						{
							attackerId: 1,
							attackerName: "MercOne",
							attackerFactionId: 1111,
							attackerFactionName: "Uphills",
							totalHits: 7,
							standardHits: 7,
							strickenHits: 0,
							totalPayout: 21000000,
						},
					],
				},
				{
					factionId: 2222,
					factionName: "Wanderers",
					totalHits: 5,
					totalPayout: 24000000,
					mercs: [
						{
							attackerId: 2,
							attackerName: "MercTwo",
							attackerFactionId: 2222,
							attackerFactionName: "Wanderers",
							totalHits: 5,
							standardHits: 4,
							strickenHits: 1,
							totalPayout: 24000000,
						},
					],
				},
			],
			targetBreakdown: [
				{
					defenderId: 111,
					defenderName: "Alpha",
					totalHits: 12,
					standardHitsReceived: 12,
					strickenHitsReceived: 0,
				},
			],
		});

		await postMercContractPaid(
			client,
			"guild-test",
			"past-contracts",
			completedContract(),
			summary,
			"2026-10-03T12:00:00.000Z",
		);

		expect(mockChannel.send).toHaveBeenCalledTimes(1);

		const embed = firstEmbed(sentPayloads[0]);
		expect(embed?.title).toBe("[CONTRACT PAID] Aspirants [4242]");
		expect(embed?.description).toContain("**12**");
		expect(embed?.description).toContain("**$45,000,000**");

		// One combined merc CSV plus one per merc faction — no client target CSV.
		const files = sentPayloads[0]?.files as Array<{ name: string }>;
		expect(files).toHaveLength(3);
		expect(files.map((f) => f.name)).toEqual([
			"merc_payouts_combined_contract-paid-test.csv",
			"merc_payouts_uphills_contract-paid-test.csv",
			"merc_payouts_wanderers_contract-paid-test.csv",
		]);
	});

	it("falls back to 'Unknown' rather than throwing on an unparseable paidAt", async () => {
		const { client, sentPayloads } = makeClient("past-contracts");

		await postMercContractPaid(
			client,
			"guild-test",
			"past-contracts",
			completedContract(),
			emptySummary(),
			"not-a-real-date",
		);

		expect(firstEmbed(sentPayloads[0])?.description).toContain("Unknown");
	});

	it("sends nothing when the configured channel does not exist", async () => {
		const { client, mockChannel, sentPayloads } =
			makeClient("some-other-channel");

		await postMercContractPaid(
			client,
			"guild-test",
			"past-contracts",
			completedContract(),
			emptySummary(),
			"2026-10-03T12:00:00.000Z",
		);

		expect(mockChannel.send).not.toHaveBeenCalled();
		expect(sentPayloads).toHaveLength(0);
	});
});
