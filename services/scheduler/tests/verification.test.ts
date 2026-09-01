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

	test("runBulkGuildVerification supports Torn API v2 array format and preserves existing roles", async () => {
		await db.insert(verifiedUsers).values({
			discordId: TEST_DISCORD_ID,
			tornId: 2633269,
			tornName: "Deji",
			factionId: 999,
			factionTag: "ALPHA",
			lastCheckedAt: new Date(),
		});

		// Torn API v2 returns basic and members as an ARRAY
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL | Request,
		) => {
			const urlStr = url.toString();
			if (urlStr.includes("/faction")) {
				return new Response(
					JSON.stringify({
						basic: {
							id: 999,
							name: "Alpha Faction",
							tag: "ALPHA",
							leader_id: 2633269,
						},
						members: [
							{
								id: 2633269,
								name: "Deji",
								position: "Leader",
								days_in_faction: 100,
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch);

		const actionsReceived: BulkVerificationProgressData["actions"] = [];
		const result = await runBulkGuildVerification(
			TEST_GUILD_ID,
			"admin",
			(p) => {
				if (p.actions) {
					actionsReceived.push(...p.actions);
				}
			},
			[
				{
					discordId: TEST_DISCORD_ID,
					// Member already has verified role, alpha member, alpha leader
					currentRoleIds: [
						"role_verified",
						"role_alpha_member",
						"role_alpha_leader",
					],
					currentNickname: "[ALPHA] Deji [2633269]",
				},
			],
		);

		expect(result.processed).toBe(1);
		expect(result.errors).toBe(0);
		// Since member already has all required roles, no roles should be removed!
		const userAction = actionsReceived.find(
			(a) => a.discordId === TEST_DISCORD_ID,
		);
		if (userAction?.rolesToRemove) {
			expect(userAction.rolesToRemove).toEqual([]);
		}
	});

	test("runBulkGuildVerification aborts safely without stripping roles when faction roster fetch fails", async () => {
		await db.insert(verifiedUsers).values({
			discordId: TEST_DISCORD_ID,
			tornId: 2633269,
			tornName: "Deji",
			factionId: 999,
			factionTag: "ALPHA",
			lastCheckedAt: new Date(),
		});

		// Simulate non-retryable Torn API error (code 2 = Incorrect key)
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			return new Response(
				JSON.stringify({
					error: { code: 2, error: "Incorrect key" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch);

		const actionsReceived: BulkVerificationProgressData["actions"] = [];
		let failedProgressReceived = false;

		const result = await runBulkGuildVerification(
			TEST_GUILD_ID,
			"admin",
			(p) => {
				if (p.actions) {
					actionsReceived.push(...p.actions);
				}
				if (p.status === "failed") {
					failedProgressReceived = true;
				}
			},
			[
				{
					discordId: TEST_DISCORD_ID,
					currentRoleIds: [
						"role_verified",
						"role_alpha_member",
						"role_alpha_leader",
					],
					currentNickname: "[ALPHA] Deji [2633269]",
				},
			],
		);

		expect(failedProgressReceived).toBe(true);
		expect(result.errors).toBe(1);
		// Critical: No actions should be emitted that remove roles!
		expect(actionsReceived.length).toBe(0);
	});

	test("runBulkGuildVerification recovers protected roles recently stripped by a faulty sweep", async () => {
		// Update guild config to include a protected role
		await db
			.update(guildConfigs)
			.set({ protectedRoleIds: ["role_protected_officer"] })
			.where(eq(guildConfigs.guildId, TEST_GUILD_ID));

		await db.insert(verifiedUsers).values({
			discordId: TEST_DISCORD_ID,
			tornId: 2633269,
			tornName: "Deji",
			factionId: 999,
			factionTag: "ALPHA",
			lastCheckedAt: new Date(),
		});

		// Insert a recent log simulating the bad sweep that stripped "role_protected_officer" 15 minutes ago
		await db.insert(verificationLogs).values({
			guildId: TEST_GUILD_ID,
			discordId: TEST_DISCORD_ID,
			status: "success",
			triggeredBy: "admin",
			rolesAdded: [],
			rolesRemoved: ["role_protected_officer", "role_alpha_member"],
			createdAt: new Date(Date.now() - 15 * 60 * 1000),
		});

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL | Request,
		) => {
			const urlStr = url.toString();
			if (urlStr.includes("/faction")) {
				return new Response(
					JSON.stringify({
						basic: {
							id: 999,
							name: "Alpha Faction",
							tag: "ALPHA",
							leader_id: 2633269,
						},
						members: [
							{
								id: 2633269,
								name: "Deji",
								position: "Leader",
								days_in_faction: 100,
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({}), { status: 200 });
		}) as unknown as typeof fetch);

		const actionsReceived: BulkVerificationProgressData["actions"] = [];
		const result = await runBulkGuildVerification(
			TEST_GUILD_ID,
			"admin",
			(p) => {
				if (p.actions) {
					actionsReceived.push(...p.actions);
				}
			},
			[
				{
					discordId: TEST_DISCORD_ID,
					// Member currently only has role_verified because protected & faction roles were stripped
					currentRoleIds: ["role_verified"],
					currentNickname: "[ALPHA] Deji [2633269]",
				},
			],
		);

		expect(result.processed).toBe(1);
		expect(result.updated).toBe(1);

		const userAction = actionsReceived.find(
			(a) => a.discordId === TEST_DISCORD_ID,
		);
		expect(userAction).toBeDefined();
		// Both the faction member role, leader role, AND recovered protected role should be added back!
		expect(userAction?.rolesToAdd).toContain("role_alpha_member");
		expect(userAction?.rolesToAdd).toContain("role_alpha_leader");
		expect(userAction?.rolesToAdd).toContain("role_protected_officer");
	});
});
