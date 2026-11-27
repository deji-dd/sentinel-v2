import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { allianceApiKeys, db, eq } from "../../database";
import {
	clearAllianceKeyPoolCache,
	getActiveAllianceKeyPool,
	getAllianceKeyPool,
	hashApiKey,
	healAllianceKeyNames,
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

describe("Alliance key name self-healing", () => {
	const HASH = hashApiKey("alliance_heal_key", "pepper");
	const ID = "test-heal-alliance-key";
	const TORN_ID = 777777;

	beforeEach(async () => {
		await db.insert(allianceApiKeys).values({
			id: ID,
			guildId: null,
			tornId: TORN_ID,
			tornName: `Player ${TORN_ID}`,
			apiKeyEncrypted: "alliance_heal_key",
			apiKeyHash: HASH,
		});
	});

	afterEach(async () => {
		spyOn(globalThis, "fetch").mockRestore();
		await db
			.delete(allianceApiKeys)
			.where(eq(allianceApiKeys.apiKeyHash, HASH));
		clearAllianceKeyPoolCache();
	});

	test("resolves a placeholder name from the Torn API and persists it", async () => {
		spyOn(globalThis, "fetch").mockImplementation((async (
			input: Parameters<typeof fetch>[0],
		) => {
			// Only heal the fixture; leave any baseline imported rows untouched.
			if (!String(input).includes("alliance_heal_key")) {
				throw new Error("Unexpected key lookup in name-healing test");
			}
			return new Response(JSON.stringify({ name: "Real Player" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch);

		const healed = await healAllianceKeyNames({ force: true });
		expect(healed).toBeGreaterThanOrEqual(1);

		const [row] = await db
			.select({ tornName: allianceApiKeys.tornName })
			.from(allianceApiKeys)
			.where(eq(allianceApiKeys.id, ID));
		expect(row?.tornName).toBe("Real Player");
	});
});
