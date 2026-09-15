import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { apiKeys, db, eq, inArray } from "../../database";
import {
	getPersonalKey,
	getSystemKeyPool,
	hashApiKey,
	KeyHealthManager,
	ManagedTornApiClient,
} from "../index";

describe("Torn API Manager - Key Pool Manager", () => {
	const TEST_USER_IDS = [2001, 2002, 3001];
	const keyHash1 = hashApiKey("sys_key_1", "pepper");
	const keyHash2 = hashApiKey("sys_key_2", "pepper");
	const keyHashPersonal = hashApiKey("personal_key_1", "pepper");

	let savedPersonalKeys: (typeof apiKeys.$inferSelect)[] = [];

	beforeEach(async () => {
		savedPersonalKeys = await db.query.apiKeys.findMany({
			where: eq(apiKeys.keyType, "personal"),
		});
		await db.delete(apiKeys).where(eq(apiKeys.keyType, "personal"));
		await db.delete(apiKeys).where(inArray(apiKeys.userId, TEST_USER_IDS));
	});

	afterEach(async () => {
		await db.delete(apiKeys).where(inArray(apiKeys.userId, TEST_USER_IDS));
		if (savedPersonalKeys.length > 0) {
			await db.insert(apiKeys).values(savedPersonalKeys);
		}
	});

	test("fetches active system key pool from database", async () => {
		await db.insert(apiKeys).values([
			{
				userId: 2001,
				apiKeyEncrypted: "sys_key_1",
				apiKeyHash: keyHash1,
				keyType: "system",
				isValid: true,
			},
			{
				userId: 2002,
				apiKeyEncrypted: "sys_key_2",
				apiKeyHash: keyHash2,
				keyType: "system",
				isValid: true,
			},
		]);

		const pool = await getSystemKeyPool();
		expect(pool.length).toBeGreaterThanOrEqual(2);

		const key1 = pool.find((k) => k.userId === 2001);
		const key2 = pool.find((k) => k.userId === 2002);
		expect(key1?.apiKey).toBe("sys_key_1");
		expect(key2?.apiKey).toBe("sys_key_2");
	});

	test("fetches active personal key from database", async () => {
		await db.insert(apiKeys).values({
			userId: 3001,
			apiKeyEncrypted: "personal_key_1",
			apiKeyHash: keyHashPersonal,
			keyType: "personal",
			isValid: true,
		});

		const personalKey = await getPersonalKey();
		expect(personalKey).not.toBeNull();
		expect(personalKey?.userId).toBe(3001);
		expect(personalKey?.apiKey).toBe("personal_key_1");
		expect(personalKey?.keyType).toBe("personal");
	});

	test("excludes personal keys from getSystemKeyPool", async () => {
		await db.insert(apiKeys).values([
			{
				userId: 2001,
				apiKeyEncrypted: "sys_key_1",
				apiKeyHash: keyHash1,
				keyType: "system",
				isValid: true,
			},
			{
				userId: 3001,
				apiKeyEncrypted: "personal_key_1",
				apiKeyHash: keyHashPersonal,
				keyType: "personal",
				isValid: true,
			},
		]);

		const pool = await getSystemKeyPool();
		expect(pool.some((k) => k.userId === 2001)).toBe(true);
		expect(pool.some((k) => k.userId === 3001)).toBe(false);
	});
});

describe("KeyHealthManager - Temporary Invalidation", () => {
	const TEST_USER_IDS = [4001];
	const keyHash = hashApiKey("temp_key_1", "pepper");

	beforeEach(async () => {
		await db.delete(apiKeys).where(inArray(apiKeys.userId, TEST_USER_IDS));
		await db.insert(apiKeys).values({
			userId: 4001,
			apiKeyEncrypted: "temp_key_1",
			apiKeyHash: keyHash,
			keyType: "system",
			isValid: true,
		});
	});

	afterEach(async () => {
		await db.delete(apiKeys).where(inArray(apiKeys.userId, TEST_USER_IDS));
	});

	test("marks key as temporarily disabled in memory on Error Code 13 without touching SQLite", async () => {
		const manager = new KeyHealthManager("pepper", 100); // 100ms cooldown for test

		expect(manager.isKeyTemporarilyDisabled("temp_key_1")).toBe(false);

		await manager.handleInvalidKey("temp_key_1", 13);

		// Key should be in cooldown in memory
		expect(manager.isKeyTemporarilyDisabled("temp_key_1")).toBe(true);

		// SQLite database record MUST remain valid
		const dbKey = await db.query.apiKeys.findFirst({
			where: eq(apiKeys.apiKeyHash, keyHash),
		});
		expect(dbKey?.isValid).toBe(true);

		// Wait for cooldown to expire
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(manager.isKeyTemporarilyDisabled("temp_key_1")).toBe(false);
	});

	test("clears temporary disable on successful request", async () => {
		const manager = new KeyHealthManager("pepper", 10000);

		await manager.handleInvalidKey("temp_key_1", 13);
		expect(manager.isKeyTemporarilyDisabled("temp_key_1")).toBe(true);

		await manager.recordSuccessfulUse("temp_key_1");
		expect(manager.isKeyTemporarilyDisabled("temp_key_1")).toBe(false);
	});

	test("multiplies cooldown progressively on repeated temporary disable errors and resets on success", async () => {
		const baseMs = 1000;
		const manager = new KeyHealthManager("pepper", baseMs);

		// Multipliers: [1, 2, 5, 15, 30, 60]
		const cd1 = manager.markTemporarilyDisabled("temp_key_prog");
		expect(cd1).toBe(1000);
		expect(manager.getTemporaryDisableCount("temp_key_prog")).toBe(1);

		const cd2 = manager.markTemporarilyDisabled("temp_key_prog");
		expect(cd2).toBe(2000);
		expect(manager.getTemporaryDisableCount("temp_key_prog")).toBe(2);

		const cd3 = manager.markTemporarilyDisabled("temp_key_prog");
		expect(cd3).toBe(5000);
		expect(manager.getTemporaryDisableCount("temp_key_prog")).toBe(3);

		const cd4 = manager.markTemporarilyDisabled("temp_key_prog");
		expect(cd4).toBe(15000);

		const cd5 = manager.markTemporarilyDisabled("temp_key_prog");
		expect(cd5).toBe(30000);

		const cd6 = manager.markTemporarilyDisabled("temp_key_prog");
		expect(cd6).toBe(60000);

		const cd7 = manager.markTemporarilyDisabled("temp_key_prog");
		expect(cd7).toBe(60000); // capped at max multiplier

		// Successful use clears the progression
		await manager.recordSuccessfulUse("temp_key_prog");
		expect(manager.getTemporaryDisableCount("temp_key_prog")).toBe(0);
		expect(manager.isKeyTemporarilyDisabled("temp_key_prog")).toBe(false);

		// Next failure starts at 1x again
		const cdAfterReset = manager.markTemporarilyDisabled("temp_key_prog");
		expect(cdAfterReset).toBe(1000);
	});
});

describe("ManagedTornApiClient - System Key Failover", () => {
	const TEST_USER_IDS = [5001, 5002];
	const keyHash1 = hashApiKey("failover_key_1", "pepper");
	const keyHash2 = hashApiKey("failover_key_2", "pepper");
	let savedSystemKeys: (typeof apiKeys.$inferSelect)[] = [];

	beforeEach(async () => {
		savedSystemKeys = await db.query.apiKeys.findMany({
			where: eq(apiKeys.keyType, "system"),
		});
		await db.delete(apiKeys).where(eq(apiKeys.keyType, "system"));
		await db.insert(apiKeys).values([
			{
				userId: 5001,
				apiKeyEncrypted: "failover_key_1",
				apiKeyHash: keyHash1,
				keyType: "system",
				isValid: true,
			},
			{
				userId: 5002,
				apiKeyEncrypted: "failover_key_2",
				apiKeyHash: keyHash2,
				keyType: "system",
				isValid: true,
			},
		]);
	});

	afterEach(async () => {
		await db.delete(apiKeys).where(inArray(apiKeys.userId, TEST_USER_IDS));
		if (savedSystemKeys.length > 0) {
			await db.insert(apiKeys).values(savedSystemKeys);
		}
	});

	test("automatically fails over to next system key when encountering error code 13", async () => {
		const client = new ManagedTornApiClient({
			pepper: "pepper",
			tempCooldownMs: 5000,
		});

		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			const parsed = new URL(url.toString());
			const key = parsed.searchParams.get("key");
			if (key === "failover_key_1") {
				return new Response(
					JSON.stringify({
						error: { code: 13, error: "Key temporarily disabled" },
					}),
				);
			}
			return new Response(JSON.stringify({ success: true, keyUsed: key }));
		}) as unknown as typeof fetch);

		const result = (await client.get("/user")) as {
			success: boolean;
			keyUsed: string;
		};
		expect(result.success).toBe(true);
		expect(result.keyUsed).toBe("failover_key_2");

		// failover_key_1 should now be temporarily disabled in client's health manager
		expect(
			client.keyHealthManager.isKeyTemporarilyDisabled("failover_key_1"),
		).toBe(true);

		fetchSpy.mockRestore();
	});
});
