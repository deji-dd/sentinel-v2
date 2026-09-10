import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db, elimsApiKeys, eq } from "@sentinel/database";
import {
	encryptApiKey,
	getGuildKeyPool,
	getNextGuildKey,
	hashApiKey,
	tornApi,
} from "@sentinel/torn-api";
import { resolveElimsUser, verifyElimsKey } from "../src/workers/elimination";

describe("Elimination Workers & Guild Key Management via @sentinel/torn-api", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	const TEST_GUILD_ID = `test-elims-guild-${crypto.randomUUID()}`;
	const TEST_DISCORD_ID = "123456789012345678";
	const TEST_RAW_KEY_1 = "1111222233334444";
	const TEST_RAW_KEY_2 = "aaaabbbbccccdddd";
	const TEST_PEPPER = "test-pepper";
	const MASTER_KEY =
		process.env.ENCRYPTION_KEY ||
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

	let keyId1: string;

	beforeEach(async () => {
		process.env.ENCRYPTION_KEY = MASTER_KEY;
		process.env.API_KEY_HASH_PEPPER = TEST_PEPPER;

		// Clean up any test records
		await db
			.delete(elimsApiKeys)
			.where(eq(elimsApiKeys.guildId, TEST_GUILD_ID));

		// Insert test guild keys
		const [inserted1] = await db
			.insert(elimsApiKeys)
			.values({
				guildId: TEST_GUILD_ID,
				tornId: 99001,
				tornName: "KeyDonor1",
				apiKeyEncrypted: encryptApiKey(TEST_RAW_KEY_1, MASTER_KEY),
				apiKeyHash: hashApiKey(TEST_RAW_KEY_1, TEST_PEPPER),
				isValid: true,
				invalidCount: 0,
			})
			.returning({ id: elimsApiKeys.id });

		await db.insert(elimsApiKeys).values({
			guildId: TEST_GUILD_ID,
			tornId: 99002,
			tornName: "KeyDonor2",
			apiKeyEncrypted: encryptApiKey(TEST_RAW_KEY_2, MASTER_KEY),
			apiKeyHash: hashApiKey(TEST_RAW_KEY_2, TEST_PEPPER),
			isValid: true,
			invalidCount: 0,
		});

		keyId1 = inserted1?.id ?? "k1";
	});

	afterEach(async () => {
		fetchSpy?.mockRestore();
		await db
			.delete(elimsApiKeys)
			.where(eq(elimsApiKeys.guildId, TEST_GUILD_ID));
	});

	describe("Guild Keys in @sentinel/torn-api", () => {
		test("getGuildKeyPool decrypts and loads valid keys for guild", async () => {
			const pool = await getGuildKeyPool(TEST_GUILD_ID);
			expect(pool.length).toBe(2);
			expect(pool[0]?.apiKey).toBe(TEST_RAW_KEY_1);
			expect(pool[0]?.userId).toBe(99001);
			expect(pool[0]?.keyType).toBe("guild");
			expect(pool[1]?.apiKey).toBe(TEST_RAW_KEY_2);
		});

		test("getNextGuildKey rotates between valid guild keys via round-robin", async () => {
			const key1 = await getNextGuildKey(TEST_GUILD_ID);
			expect(key1).not.toBeNull();
			expect(key1?.apiKey).toBe(TEST_RAW_KEY_1);

			const key2 = await getNextGuildKey(TEST_GUILD_ID);
			expect(key2).not.toBeNull();
			expect(key2?.apiKey).toBe(TEST_RAW_KEY_2);

			const key3 = await getNextGuildKey(TEST_GUILD_ID);
			expect(key3).not.toBeNull();
			expect(key3?.apiKey).toBe(TEST_RAW_KEY_1);
		});

		test("KeyHealthManager suppresses temporarily disabled keys in-memory", async () => {
			expect(
				tornApi.keyHealthManager.isKeyTemporarilyDisabled(TEST_RAW_KEY_1),
			).toBe(false);

			tornApi.keyHealthManager.markTemporarilyDisabled(TEST_RAW_KEY_1, 60000);
			expect(
				tornApi.keyHealthManager.isKeyTemporarilyDisabled(TEST_RAW_KEY_1),
			).toBe(true);

			// Should now return key 2 instead
			const nextKey = await getNextGuildKey(TEST_GUILD_ID);
			expect(nextKey?.apiKey).toBe(TEST_RAW_KEY_2);

			// Clean up cooldown
			await tornApi.keyHealthManager.recordSuccessfulUse(TEST_RAW_KEY_1);
			expect(
				tornApi.keyHealthManager.isKeyTemporarilyDisabled(TEST_RAW_KEY_1),
			).toBe(false);
		});

		test("KeyHealthManager disables invalid guild key in database after 3 code-2 failures", async () => {
			await tornApi.keyHealthManager.handleInvalidKey(TEST_RAW_KEY_1, 2);
			await tornApi.keyHealthManager.handleInvalidKey(TEST_RAW_KEY_1, 2);

			const [check1] = await db
				.select()
				.from(elimsApiKeys)
				.where(eq(elimsApiKeys.id, keyId1));
			expect(check1?.isValid).toBe(true);

			// 3rd failure reaches threshold
			await tornApi.keyHealthManager.handleInvalidKey(TEST_RAW_KEY_1, 2);

			const [check2] = await db
				.select()
				.from(elimsApiKeys)
				.where(eq(elimsApiKeys.id, keyId1));
			expect(check2?.isValid).toBe(false);
		});
	});

	describe("verifyElimsKey", () => {
		test("rejects invalid key formats", async () => {
			await expect(verifyElimsKey("short")).rejects.toThrow(
				"Torn API keys must be exactly 16 alphanumeric characters.",
			);
		});

		test("resolves Torn Player ID and Name for a valid key", async () => {
			fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
				(async () =>
					new Response(
						JSON.stringify({
							player_id: 123456,
							name: "TestElimsPlayer",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					)) as unknown as typeof fetch,
			);

			const result = await verifyElimsKey("abcdef0123456789");
			expect(result.tornId).toBe(123456);
			expect(result.tornName).toBe("TestElimsPlayer");
		});
	});

	describe("resolveElimsUser", () => {
		test("returns null if guild has no registered API keys", async () => {
			const result = await resolveElimsUser(
				TEST_DISCORD_ID,
				"non_existent_guild_123",
			);
			expect(result).toBeNull();
		});

		test("resolves live user competition and networth via Torn API v2 through tornApi", async () => {
			fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
				(async () =>
					new Response(
						JSON.stringify({
							profile: {
								id: 778899,
								name: "ElimsChampion",
							},
							name: "Elimination",
							score: 142,
							team: "Team Fire",
							attacks: 88,
							personalstats: {
								networth: 500000000,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					)) as unknown as typeof fetch,
			);

			const result = await resolveElimsUser(TEST_DISCORD_ID, TEST_GUILD_ID);

			expect(result).not.toBeNull();
			expect(result?.tornId).toBe(778899);
			expect(result?.tornName).toBe("ElimsChampion");
			expect(result?.competition?.score).toBe(142);
			expect(result?.competition?.team).toBe("Team Fire");
			expect(result?.competition?.attacks).toBe(88);
			expect(result?.attacks).toBe(88);
			expect(result?.networth).toBe(500000000);
		});

		test("resolves competition via /user/{id}/competition fallback and personalstats attacks won", async () => {
			fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
				input: string | URL | Request,
			) => {
				const url = String(input);
				if (url.includes("/user/") && url.includes("/competition")) {
					return new Response(
						JSON.stringify({
							competition: {
								name: "Elimination",
								score: 95,
								team: "Brain Surgeons",
								attacks: 42,
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response(
					JSON.stringify({
						profile: {
							id: 778899,
							name: "ElimsChampion",
						},
						personalstats: {
							networth: 250000000,
							attacking: {
								attacks: {
									won: 3450,
									lost: 120,
								},
							},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}) as unknown as typeof fetch);

			const result = await resolveElimsUser(TEST_DISCORD_ID, TEST_GUILD_ID);

			expect(result).not.toBeNull();
			expect(result?.tornId).toBe(778899);
			expect(result?.competition?.attacks).toBe(42);
			expect(result?.competition?.score).toBe(95);
			expect(result?.attacks).toBe(42);
			expect(result?.attacksWon).toBe(3450);
			expect(result?.networth).toBe(250000000);
		});

		test("fails over to next guild key if first key encounters a key error", async () => {
			let callCount = 0;
			fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
				callCount++;
				if (callCount === 1) {
					// First key returns error code 2
					return new Response(
						JSON.stringify({
							error: { code: 2, error: "Incorrect key" },
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				// Second key succeeds
				return new Response(
					JSON.stringify({
						profile: {
							id: 778899,
							name: "ElimsChampion",
						},
						score: 50,
						team: "Team Ice",
						attacks: 20,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}) as unknown as typeof fetch);

			const result = await resolveElimsUser(TEST_DISCORD_ID, TEST_GUILD_ID);

			expect(callCount).toBeGreaterThanOrEqual(2);
			expect(result).not.toBeNull();
			expect(result?.tornId).toBe(778899);
			expect(result?.tornName).toBe("ElimsChampion");
			expect(result?.competition?.team).toBe("Team Ice");
		});
	});
});
