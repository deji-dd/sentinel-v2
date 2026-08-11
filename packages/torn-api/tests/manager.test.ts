import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { apiKeys, db } from "../../database";
import {
	getPersonalKey,
	getSystemKeyPool,
	hashApiKey,
} from "../index";

describe("Torn API Manager - Key Pool Manager", () => {
	const keyHash1 = hashApiKey("sys_key_1", "pepper");
	const keyHash2 = hashApiKey("sys_key_2", "pepper");
	const keyHashPersonal = hashApiKey("personal_key_1", "pepper");

	beforeEach(async () => {
		await db.delete(apiKeys);
	});

	afterEach(async () => {
		await db.delete(apiKeys);
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
});
