import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	apiKeys,
	db,
	eq,
	factionRoleMappings,
	guildConfigs,
	inArray,
	verificationLogs,
	verifiedUsers,
} from "@sentinel/database";
import type { BulkVerificationProgressData } from "@sentinel/schemas";
import {
	runBulkGuildVerification,
	runVerificationJob,
} from "../src/lib/verification";

describe("Verification Engine", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	const TEST_GUILD_ID = "TEST_GUILD_V2_VERIFY";
	const TEST_DISCORD_ID = "TEST_USER_DISCORD_123";
	const MOCK_KEY_ID = "MOCK_KEY_V2_123";

	let prevEnvKey: string | undefined;

	const TEST_DISCORD_IDS = [TEST_DISCORD_ID, "TEST_USER_UNVERIFIED_456"];

	beforeEach(async () => {
		prevEnvKey = process.env.TORN_API_KEY;
		process.env.TORN_API_KEY = "mock_system_api_key";
		await db
			.delete(guildConfigs)
			.where(eq(guildConfigs.guildId, TEST_GUILD_ID));
		await db.delete(apiKeys).where(eq(apiKeys.id, MOCK_KEY_ID));
		await db
			.delete(factionRoleMappings)
			.where(eq(factionRoleMappings.guildId, TEST_GUILD_ID));
		await db
			.delete(verifiedUsers)
			.where(inArray(verifiedUsers.discordId, TEST_DISCORD_IDS));

		// Set up test guild config
		await db.insert(guildConfigs).values({
			guildId: TEST_GUILD_ID,
			verifiedRoleIds: ["role_verified"],
			nicknameTemplate: "[{tag}] {name} [{id}]",
		});

		await db.insert(apiKeys).values({
			id: MOCK_KEY_ID,
			userId: 12345,
			apiKeyEncrypted: "mock_enc_key",
			apiKeyHash: "mock_hash_123",
			keyType: "system",
			isValid: true,
		});

		await db.insert(factionRoleMappings).values({
			guildId: TEST_GUILD_ID,
			factionId: 999,
			factionName: "Alpha Faction",
			memberRoleIds: ["role_alpha_member"],
			leaderRoleIds: ["role_alpha_leader"],
			enabled: true,
		});
	});

	afterEach(async () => {
		if (prevEnvKey !== undefined) {
			process.env.TORN_API_KEY = prevEnvKey;
		} else {
			delete process.env.TORN_API_KEY;
		}
		if (fetchSpy) {
			fetchSpy.mockRestore();
		}
		await db
			.delete(guildConfigs)
			.where(eq(guildConfigs.guildId, TEST_GUILD_ID));
		await db.delete(apiKeys).where(eq(apiKeys.id, MOCK_KEY_ID));
		await db
			.delete(factionRoleMappings)
			.where(eq(factionRoleMappings.guildId, TEST_GUILD_ID));
		await db
			.delete(verifiedUsers)
			.where(inArray(verifiedUsers.discordId, TEST_DISCORD_IDS));
		await db
			.delete(verificationLogs)
			.where(eq(verificationLogs.guildId, TEST_GUILD_ID));
	});

	test("calculates role diffs and formatted nickname for verified user", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL | Request,
		) => {
			const urlStr = url.toString();
			if (urlStr.includes("/user")) {
				return new Response(
					JSON.stringify({
						profile: {
							id: 2633269,
							name: "Deji",
						},
						faction: {
							id: 999,
							name: "Alpha Faction",
							tag: "ALPHA",
							position: "Leader",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch);

		const res = await runVerificationJob(
			{
				guildId: TEST_GUILD_ID,
				channelId: "c1",
				discordId: TEST_DISCORD_ID,
				currentRoleIds: [],
				currentNickname: null,
				triggeredBy: "user",
			},
			"mock_override_key",
		);

		expect("error" in res).toBe(false);

		if (!("error" in res)) {
			expect(res.guildId).toBe(TEST_GUILD_ID);
			expect(res.discordId).toBe(TEST_DISCORD_ID);
			expect(res.newNickname).toBe("[ALPHA] Deji [2633269]");
			expect(res.rolesToAdd).toContain("role_verified");
			expect(res.rolesToAdd).toContain("role_alpha_member");
			expect(res.rolesToAdd).toContain("role_alpha_leader");
		}

		// Verify record was inserted in DB
		const dbUser = await db.query.verifiedUsers.findFirst({
			where: eq(verifiedUsers.discordId, TEST_DISCORD_ID),
		});

		expect(dbUser).toBeDefined();
		if (dbUser) {
			expect(dbUser.tornId).toBe(2633269);
			expect(dbUser.tornName).toBe("Deji");
			expect(dbUser.factionId).toBe(999);
		}
	});

	test("runBulkGuildVerification streams progress events in real time", async () => {
		// Insert mock verified user
		await db.insert(verifiedUsers).values({
			discordId: TEST_DISCORD_ID,
			tornId: 2633269,
			tornName: "Deji",
			factionId: 999,
			factionTag: "ALPHA",
			lastCheckedAt: new Date(),
		});

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL | Request,
		) => {
			const urlStr = url.toString();
			if (urlStr.includes("/faction")) {
				return new Response(
					JSON.stringify({
						members: {
							"2633269": {
								name: "Deji",
								position: "Leader",
								days_in_faction: 100,
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (urlStr.includes("/user")) {
				return new Response(
					JSON.stringify({
						profile: {
							id: 2633269,
							name: "Deji",
						},
						faction: {
							id: 999,
							name: "Alpha Faction",
							tag: "ALPHA",
							position: "Leader",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch);

		const progressEvents: BulkVerificationProgressData[] = [];
		const onProgress = (progress: BulkVerificationProgressData) => {
			progressEvents.push({ ...progress });
		};

		const result = await runBulkGuildVerification(
			TEST_GUILD_ID,
			"admin",
			onProgress,
			[
				{
					discordId: TEST_DISCORD_ID,
					currentRoleIds: [],
					currentNickname: null,
				},
			],
		);

		expect(result.processed).toBeGreaterThanOrEqual(1);
		expect(result.total).toBeGreaterThanOrEqual(1);
		expect(result.errors).toBe(0);

		// Verify stream progress events were triggered
		expect(progressEvents.length).toBeGreaterThanOrEqual(2);
		expect(progressEvents[0]?.status).toBe("running");
		expect(progressEvents[progressEvents.length - 1]?.status).toBe("completed");
		expect(progressEvents[progressEvents.length - 1]?.processed).toBe(
			result.processed,
		);
	});

	test("runBulkGuildVerification processes all members passed in, including unverified members not in db", async () => {
		const UNVERIFIED_DISCORD_ID = "TEST_USER_UNVERIFIED_456";

		// Only insert 1 member into DB initially
		await db.insert(verifiedUsers).values({
			discordId: TEST_DISCORD_ID,
			tornId: 2633269,
			tornName: "Deji",
			factionId: 999,
			factionTag: "ALPHA",
			lastCheckedAt: new Date(),
		});

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL | Request,
		) => {
			const urlStr = url.toString();
			if (urlStr.includes("/faction")) {
				return new Response(
					JSON.stringify({
						members: {
							"2633269": {
								name: "Deji",
								position: "Leader",
								days_in_faction: 100,
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (urlStr.includes("/user") && urlStr.includes(UNVERIFIED_DISCORD_ID)) {
				return new Response(
					JSON.stringify({
						profile: {
							id: 7777777,
							name: "NewPlayer",
						},
						faction: {
							id: 999,
							name: "Alpha Faction",
							tag: "ALPHA",
							position: "Member",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch);

		const membersInput = [
			{
				discordId: TEST_DISCORD_ID,
				currentRoleIds: [],
				currentNickname: null,
			},
			{
				discordId: UNVERIFIED_DISCORD_ID,
				currentRoleIds: [],
				currentNickname: null,
			},
		];

		const progressEvents: BulkVerificationProgressData[] = [];
		const result = await runBulkGuildVerification(
			TEST_GUILD_ID,
			"admin",
			(p) => {
				progressEvents.push({ ...p });
			},
			membersInput,
		);

		expect(result.processed).toBe(2);
		expect(result.total).toBe(2);
		expect(result.errors).toBe(0);
		expect(result.updated).toBe(2);

		// Verify unverified member was inserted into DB during bulk run
		const newDbUser = await db.query.verifiedUsers.findFirst({
			where: eq(verifiedUsers.discordId, UNVERIFIED_DISCORD_ID),
		});
		expect(newDbUser).toBeDefined();
		expect(newDbUser?.tornId).toBe(7777777);

		// Clean up
		await db
			.delete(verifiedUsers)
			.where(eq(verifiedUsers.discordId, UNVERIFIED_DISCORD_ID));
	});
});
