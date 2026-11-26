import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { allianceApiKeys, db, eq } from "../../database";
import {
	clearAllianceKeyPoolCache,
	getActiveAllianceKeyPool,
	getAllianceKeyPool,
	hashApiKey,
} from "../index";

describe("Alliance key pool", () => {
	const HASHES = [
		hashApiKey("alliance_global_key", "pepper"),
		hashApiKey("alliance_guild_key", "pepper"),
		hashApiKey("alliance_other_key", "pepper"),
	];

	beforeEach(async () => {
		clearAllianceKeyPoolCache();
		await db.insert(allianceApiKeys).values([
			{
				id: "test-global-alliance-key",
				guildId: null,
				tornId: 9001,
				tornName: "Imported",
				apiKeyEncrypted: "alliance_global_key",
				apiKeyHash: HASHES[0] ?? "",
			},
			{
				id: "test-guild-alliance-key",
				guildId: "alliance-guild",
				tornId: 9002,
				tornName: "Donor",
				apiKeyEncrypted: "alliance_guild_key",
				apiKeyHash: HASHES[1] ?? "",
			},
			{
				id: "test-other-alliance-key",
				guildId: "another-guild",
				tornId: 9003,
				tornName: "Other",
				apiKeyEncrypted: "alliance_other_key",
				apiKeyHash: HASHES[2] ?? "",
			},
		]);
	});

	afterEach(async () => {
		for (const hash of HASHES) {
			await db
				.delete(allianceApiKeys)
				.where(eq(allianceApiKeys.apiKeyHash, hash));
		}
		clearAllianceKeyPoolCache();
	});

	test("returns all valid keys with no guild filter", async () => {
		const userIds = (await getAllianceKeyPool()).map((k) => k.userId);
		expect(userIds).toContain(9001);
		expect(userIds).toContain(9002);
		expect(userIds).toContain(9003);
	});

	test("includes imported global keys plus keys for the requested guild", async () => {
		const userIds = (await getAllianceKeyPool("alliance-guild")).map(
			(k) => k.userId,
		);
		expect(userIds).toContain(9001);
		expect(userIds).toContain(9002);
		expect(userIds).not.toContain(9003);
	});

	test("active pool includes the donated and imported keys", async () => {
		const pool = await getActiveAllianceKeyPool("alliance-guild");
		expect(pool.some((k) => k.userId === 9001)).toBe(true);
		expect(pool.some((k) => k.userId === 9002)).toBe(true);
	});
});
