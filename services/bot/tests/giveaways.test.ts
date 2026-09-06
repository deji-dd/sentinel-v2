import { describe, expect, it } from "bun:test";
import {
	formatDuration,
	paginateItems,
	parseDuration,
	pickRandomWinners,
} from "../src/lib/giveaway-helpers";

describe("Giveaway Helpers", () => {
	describe("parseDuration", () => {
		it("parses single unit strings correctly", () => {
			expect(parseDuration("45s")).toBe(45_000);
			expect(parseDuration("30m")).toBe(30 * 60_000);
			expect(parseDuration("12h")).toBe(12 * 3_600_000);
			expect(parseDuration("2d")).toBe(2 * 86_400_000);
		});

		it("parses multi-unit strings correctly", () => {
			expect(parseDuration("1d 12h")).toBe(86_400_000 + 12 * 3_600_000);
			expect(parseDuration("2h 30m 10s")).toBe(
				2 * 3_600_000 + 30 * 60_000 + 10_000,
			);
			expect(parseDuration("1d6h")).toBe(86_400_000 + 6 * 3_600_000);
		});

		it("returns null for invalid strings", () => {
			expect(parseDuration("")).toBeNull();
			expect(parseDuration("invalid")).toBeNull();
			expect(parseDuration("10x")).toBeNull();
			expect(parseDuration("1d invalid")).toBeNull();
			expect(parseDuration("-5m")).toBeNull();
		});
	});

	describe("formatDuration", () => {
		it("formats ms into readable parts", () => {
			expect(formatDuration(45_000)).toBe("45s");
			expect(formatDuration(30 * 60_000)).toBe("30m");
			expect(formatDuration(86_400_000 + 3_600_000)).toBe("1d 1h");
		});
	});

	describe("paginateItems", () => {
		it("correctly splits items across pages", () => {
			const items = Array.from({ length: 39 }, (_, i) => `item_${i + 1}`);

			const page1 = paginateItems(items, 1, 25);
			expect(page1.items.length).toBe(25);
			expect(page1.currentPage).toBe(1);
			expect(page1.totalPages).toBe(2);
			expect(page1.hasNext).toBe(true);
			expect(page1.hasPrev).toBe(false);

			const page2 = paginateItems(items, 2, 25);
			expect(page2.items.length).toBe(14);
			expect(page2.currentPage).toBe(2);
			expect(page2.hasNext).toBe(false);
			expect(page2.hasPrev).toBe(true);
		});
	});

	describe("pickRandomWinners", () => {
		it("picks all entries if count >= entries", () => {
			const entries = ["user1", "user2"];
			const winners = pickRandomWinners(entries, 5);
			expect(winners).toHaveLength(2);
			expect(winners).toContain("user1");
			expect(winners).toContain("user2");
		});

		it("picks exact unique winners without duplication", () => {
			const entries = ["u1", "u2", "u3", "u4", "u5"];
			const winners = pickRandomWinners(entries, 3);
			expect(winners).toHaveLength(3);
			const uniqueWinners = new Set(winners);
			expect(uniqueWinners.size).toBe(3);
			for (const w of winners) {
				expect(entries).toContain(w);
			}
		});

		it("handles empty entries cleanly", () => {
			expect(pickRandomWinners([], 3)).toEqual([]);
		});
	});

	describe("purge command scope", () => {
		it("ensures purge command is scoped to both and included in elimsCommandsList", async () => {
			const { elimsCommandsList, normalCommandsList } = await import(
				"../src/commands/index"
			);

			const purgeInElims = elimsCommandsList.find(
				(c) => c.data.name === "purge",
			);
			expect(purgeInElims).toBeDefined();
			expect(purgeInElims?.scope).toBe("both");

			const purgeInNormal = normalCommandsList.find(
				(c) => c.data.name === "purge",
			);
			expect(purgeInNormal).toBeDefined();
			expect(purgeInNormal?.scope).toBe("both");
		});
	});

	describe("giveaway embed separation", () => {
		it("builds persistent creator embed with giveaway_create_init customId", async () => {
			const { buildGiveawayCreatorComponents } = await import(
				"../src/lib/giveaways"
			);
			const { embed, components } = buildGiveawayCreatorComponents();

			expect(embed.data.title).toBe("Giveaways");
			expect(components).toHaveLength(1);
			const row = components[0]?.toJSON();
			const button = row?.components?.[0] as {
				custom_id?: string;
				label?: string;
			};
			expect(button?.custom_id).toBe("giveaway_create_init");
			expect(button?.label).toBe("Create Giveaway");
		});

		it("builds distinct active giveaway embed with giveaway_entry customId", async () => {
			const { buildActiveGiveawayComponents } = await import(
				"../src/lib/giveaways"
			);
			const mockGiveaway = {
				id: "gw_test_123",
				guildId: "guild_123",
				channelId: "channel_123",
				messageId: "msg_123",
				createdByDiscordId: "user_123",
				createdByUsername: "testuser",
				itemId: "1",
				itemName: "Xanax",
				itemCategory: "Drug",
				itemCount: 5,
				winnerCount: 1,
				durationStr: "1h",
				durationMs: 3600000,
				status: "active" as const,
				winners: [],
				endsAt: new Date(Date.now() + 3600000),
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			const { embed, components } = buildActiveGiveawayComponents(
				mockGiveaway,
				3,
			);
			expect(embed.data.title).toBe("Active Giveaway");
			expect(embed.data.description).toContain("Item: **5x Xanax**");
			expect(embed.data.description).toContain("Entries: **3**");
			expect(embed.data.description).toContain("<@user_123>");

			const row = components[0]?.toJSON();
			const button = row?.components?.[0] as {
				custom_id?: string;
				label?: string;
			};
			expect(button?.custom_id).toBe("giveaway_entry:gw_test_123");
			expect(button?.label).toBe("Enter / Leave Giveaway");
		});
	});
});
