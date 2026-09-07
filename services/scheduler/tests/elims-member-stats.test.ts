import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { apiKeys, db, elimsMemberStats, eq } from "@sentinel/database";
import { fetchFFScouterStats } from "@sentinel/torn-api";
import * as botIpc from "../src/lib/ipc/listener";
import { syncTeamMemberStats } from "../src/workers/elimination/member-stats-sync";

describe("Elims Member Stats & FFScouter Integration", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let botSpy: ReturnType<typeof spyOn>;
	const TEST_GUILD_ID = `test-guild-${crypto.randomUUID()}`;
	const TEST_KEY_USER_ID = 8888888;
	const ORIGINAL_FF_KEY = process.env.FF_SCOUTER_KEY;

	beforeEach(async () => {
		await db
			.insert(apiKeys)
			.values({
				userId: TEST_KEY_USER_ID,
				apiKeyEncrypted: "test_member_key_16ch",
				apiKeyHash: "test_member_hash",
				keyType: "system",
				isValid: true,
			})
			.onConflictDoNothing();

		await db
			.delete(elimsMemberStats)
			.where(eq(elimsMemberStats.guildId, TEST_GUILD_ID));
	});

	afterEach(async () => {
		fetchSpy?.mockRestore();
		botSpy?.mockRestore();
		process.env.FF_SCOUTER_KEY = ORIGINAL_FF_KEY;
		await db.delete(apiKeys).where(eq(apiKeys.userId, TEST_KEY_USER_ID));
		await db
			.delete(elimsMemberStats)
			.where(eq(elimsMemberStats.guildId, TEST_GUILD_ID));
	});

	test("fetchFFScouterStats throws error when FF_SCOUTER_KEY is missing", async () => {
		process.env.FF_SCOUTER_KEY = "";
		expect(fetchFFScouterStats([267456763])).rejects.toThrow(
			"FF_SCOUTER_KEY is not configured",
		);
	});

	test("fetchFFScouterStats parses multi-target response with estimates, distribution, and spies", async () => {
		process.env.FF_SCOUTER_KEY = "test-ff-key";

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () =>
				new Response(
					JSON.stringify([
						{
							player_id: 267456763,
							fair_fight: 5.39,
							bs_estimate: 2989885521,
							bs_estimate_human: "2.99b",
							bss_public: 123456,
							last_updated: 1747333361,
							source: "premium",
							premium_insights_available: true,
							distribution: {
								last_updated: 1747333361,
								distribution_human: "STR (60%) SPD (30%)",
								stats_percentage: {
									strength: 60,
									speed: 30,
								},
							},
							spies: [
								{
									strength: 1000000,
									speed: 2000000,
									defense: 3000000,
									dexterity: 4000000,
									total: 10000000000,
									last_updated: 1747330000,
									source: "tornstats",
									source_faction_id: 12345,
								},
							],
							available_estimates: {
								bss: {
									bss_public: 123456,
									bs_estimate: 2989885521,
									bs_estimate_human: "2.99b",
									last_updated: 1747333361,
									fair_fight: 5.39,
								},
								premium: {
									bs_estimate: 3100000000,
									bs_estimate_human: "3.1b",
									last_updated: 1747330000,
									fair_fight: 6.12,
								},
								spies: {
									bs_estimate: 10000000000,
									bs_estimate_human: "10b",
									last_updated: 1747330000,
									source: "tornstats",
									fair_fight: 8.45,
								},
							},
						},
					]),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				)) as unknown as typeof fetch,
		);

		const stats = await fetchFFScouterStats([267456763], "test-ff-key");
		expect(stats.length).toBe(1);
		expect(stats[0]?.player_id).toBe(267456763);
		expect(stats[0]?.bs_estimate_human).toBe("2.99b");
		expect(stats[0]?.source).toBe("premium");
		expect(stats[0]?.distribution?.distribution_human).toBe(
			"STR (60%) SPD (30%)",
		);
		expect(stats[0]?.spies.length).toBe(1);
	});

	test("syncTeamMemberStats filters by role, resolves Torn profiles, and iterates only for new members", async () => {
		process.env.FF_SCOUTER_KEY = "test-ff-key";

		// Mock Bot returning 3 human guild members (2 with role-elims, 1 without)
		botSpy = spyOn(botIpc, "requestGuildMembersFromBot").mockImplementation(
			async () => [
				{
					discordId: "user-1",
					currentRoleIds: ["role-elims"],
					currentNickname: "UserOne",
				},
				{
					discordId: "user-2",
					currentRoleIds: ["role-elims"],
					currentNickname: "UserTwo",
				},
				{
					discordId: "user-3",
					currentRoleIds: ["other-role"],
					currentNickname: "UserThree",
				},
			],
		);

		// Mock fetch: return Torn profile when requested, and FFScouter response
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: unknown,
		) => {
			const url = String(input);
			if (url.includes("ffscouter.com")) {
				return new Response(
					JSON.stringify([
						{
							player_id: 1001,
							fair_fight: 4.5,
							bs_estimate: 500000000,
							bs_estimate_human: "500m",
							source: "bss",
							distribution: null,
							spies: [],
							available_estimates: { bss: null, premium: null, spies: null },
						},
						{
							player_id: 1002,
							fair_fight: 6.2,
							bs_estimate: 2000000000,
							bs_estimate_human: "2b",
							source: "premium",
							distribution: null,
							spies: [],
							available_estimates: { bss: null, premium: null, spies: null },
						},
					]),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			// Torn API v2 /user/{id}/profile mock
			if (url.includes("user-1") || url.includes("/user/")) {
				const isUser1 = url.includes("user-1");
				return new Response(
					JSON.stringify({
						profile: {
							id: isUser1 ? 1001 : 1002,
							name: isUser1 ? "TornUserOne" : "TornUserTwo",
							level: isUser1 ? 40 : 65,
						},
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			return new Response("Not found", { status: 404 });
		}) as unknown as typeof fetch);

		// First execution: should process 2 new members with 'role-elims'
		const result1 = await syncTeamMemberStats({
			guildId: TEST_GUILD_ID,
			roleId: "role-elims",
		});

		expect(result1.total).toBe(2);
		expect(result1.newProcessed).toBe(2);
		expect(result1.resolved).toBe(2);

		// Verify DB contains 2 records
		const inDb = await db
			.select()
			.from(elimsMemberStats)
			.where(eq(elimsMemberStats.guildId, TEST_GUILD_ID));
		expect(inDb.length).toBe(2);

		// Second execution: clicking the button again should find 0 new members!
		const result2 = await syncTeamMemberStats({
			guildId: TEST_GUILD_ID,
			roleId: "role-elims",
		});

		expect(result2.total).toBe(2);
		expect(result2.newProcessed).toBe(0); // 0 new members!
		expect(result2.message).toContain("already synchronized");

		// Third execution: if an existing member is missing stats, sync detects and fetches stats for them
		await db
			.update(elimsMemberStats)
			.set({ bsEstimate: null, ffScouterStats: null })
			.where(eq(elimsMemberStats.discordId, "user-1"));

		const result3 = await syncTeamMemberStats({
			guildId: TEST_GUILD_ID,
			roleId: "role-elims",
		});

		expect(result3.total).toBe(2);
		expect(result3.newProcessed).toBe(1); // 1 member re-synced!
		expect(result3.ffScouterHits).toBe(1);

		const [updatedUser1] = await db
			.select()
			.from(elimsMemberStats)
			.where(eq(elimsMemberStats.discordId, "user-1"));
		expect(updatedUser1?.bsEstimate).toBe(500000000);
	});
});
