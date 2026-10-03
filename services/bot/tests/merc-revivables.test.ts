import { describe, expect, it } from "bun:test";
import { mapRowToMercContract, type mercContracts } from "@sentinel/database";
import {
	buildMercRevivablesEmbed,
	type RevivableMemberPayload,
} from "../src/lib/merc-revivables";

describe("Mercenary Contract Status Mapping & Revivables Embed", () => {
	it("preserves 'paused' contract status without reverting to 'active'", () => {
		const now = new Date();
		const dummyRow = {
			id: "contract-paused-123",
			guildId: "guild-1",
			factionId: 100,
			factionName: "Target Faction",
			warStatusAtCreation: "active",
			warId: null,
			warStart: null,
			warEnd: null,
			warTarget: null,
			warOpponentId: null,
			warOpponentName: null,
			startTime: new Date(now.getTime() - 60_000), // started 1 min ago
			startImmediately: true,
			startMinutesBeforeWar: null,
			endTime: new Date(now.getTime() + 3_600_000), // ends in 1 hour
			endOnWarEnd: false,
			allowOnline: true,
			allowIdle: true,
			allowOffline: false,
			maxIdleMinutes: 15,
			allowStrickenHits: false,
			minLevel: 1,
			maxLevel: 100,
			hitPrice: 250_000,
			strickenHitPrice: null,
			autoStopPrice: null,
			excludedMembers: [],
			pausedWindows: [{ pausedAt: new Date().toISOString(), resumedAt: null }],
			status: "paused",
			clientChannelId: null,
			clientDiscordId: null,
			upcomingMessageId: null,
			upcomingChannelId: null,
			createdAt: now,
			updatedAt: now,
			createdBy: null,
		};

		const mapped = mapRowToMercContract(
			dummyRow as unknown as typeof mercContracts.$inferSelect,
		);
		expect(mapped.status).toBe("paused");
	});

	it("preserves 'completed' contract status when endTime has not passed", () => {
		const now = new Date();
		const dummyRow = {
			id: "contract-completed-123",
			guildId: "guild-1",
			factionId: 100,
			factionName: "Target Faction",
			warStatusAtCreation: "active",
			warId: null,
			warStart: null,
			warEnd: null,
			warTarget: null,
			warOpponentId: null,
			warOpponentName: null,
			startTime: new Date(now.getTime() - 120_000),
			startImmediately: true,
			startMinutesBeforeWar: null,
			endTime: new Date(now.getTime() + 3_600_000), // future end time, but manually completed
			endOnWarEnd: false,
			allowOnline: true,
			allowIdle: true,
			allowOffline: false,
			maxIdleMinutes: 15,
			allowStrickenHits: false,
			minLevel: 1,
			maxLevel: 100,
			hitPrice: 250_000,
			strickenHitPrice: null,
			autoStopPrice: null,
			excludedMembers: [],
			pausedWindows: [],
			status: "completed",
			clientChannelId: null,
			clientDiscordId: null,
			upcomingMessageId: null,
			upcomingChannelId: null,
			createdAt: now,
			updatedAt: now,
			createdBy: null,
		};

		const mapped = mapRowToMercContract(
			dummyRow as unknown as typeof mercContracts.$inferSelect,
		);
		expect(mapped.status).toBe("completed");
	});

	it("builds empty state embed when no members are revivable", () => {
		const embed = buildMercRevivablesEmbed("Test Faction", 9999, []);
		const json = embed.toJSON();

		expect(json.title).toBe("REVIVABLE MEMBERS - TEST FACTION [9999]");
		expect(json.description).toContain(
			"No revivable members currently identified",
		);
		// Zero emojis rule
		expect(json.title).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
	});

	it("builds formatted list embed for revivable members with torn profile links", () => {
		const members: RevivableMemberPayload[] = [
			{
				id: 111,
				name: "DocHolliday",
				level: 75,
				statusState: "Hospital",
				statusDescription: "In hospital for 25 mins",
				statusUntil: Math.floor(Date.now() / 1000) + 1500,
				lastActionRelative: "1 min ago",
			},
			{
				id: 222,
				name: "WyattEarp",
				level: 80,
				statusState: "Hospital",
				statusDescription: "In hospital for 40 mins",
				statusUntil: Math.floor(Date.now() / 1000) + 2400,
				lastActionRelative: "30s ago",
			},
		];

		const embed = buildMercRevivablesEmbed("Wild West", 1234, members);
		const json = embed.toJSON();

		expect(json.title).toBe("REVIVABLE MEMBERS - WILD WEST [1234]");
		// Sorted by level DESC (WyattEarp level 80 before DocHolliday level 75)
		expect(json.description).toContain(
			"[WyattEarp [222]](https://www.torn.com/profiles.php?XID=222)",
		);
		expect(json.description).toContain(
			"[DocHolliday [111]](https://www.torn.com/profiles.php?XID=111)",
		);
		expect(json.footer?.text).toContain("Total: 2");
		// Zero emojis rule
		expect(json.title).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
		expect(json.description).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
	});
});
