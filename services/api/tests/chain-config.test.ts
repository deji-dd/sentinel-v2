import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { db, eq, subversiveChainConfigs } from "@sentinel/database";
import { DEFAULT_SUBVERSIVE_CHAIN_CONFIG } from "@sentinel/schemas";
import { app } from "../src/app";

/**
 * Route-level coverage for the per-faction chain monitor settings.
 *
 * All writes are scoped to faction 27312 and removed before/after each test so
 * the suite never depends on (or leaks) a previous run's row.
 */

const FACTION_ID = 27312;
const ENDPOINT = "/v2/subversive/chain-config";

async function adminCookie(): Promise<string> {
	const res = await app.handle(
		new Request("http://localhost/v2/auth/demo-login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "chain_admin", role: "admin" }),
		}),
	);
	expect(res.status).toBe(200);
	return res.headers.get("set-cookie") ?? "";
}

async function cleanup(): Promise<void> {
	await db
		.delete(subversiveChainConfigs)
		.where(eq(subversiveChainConfigs.factionId, FACTION_ID));
	// 2013 is read by the isolation test; clear any row a prior run left behind.
	await db
		.delete(subversiveChainConfigs)
		.where(eq(subversiveChainConfigs.factionId, 2013));
}

function put(cookie: string, body: Record<string, unknown>): Promise<Response> {
	return app.handle(
		new Request(`http://localhost${ENDPOINT}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", cookie },
			body: JSON.stringify(body),
		}),
	);
}

describe("chain monitor configuration routes", () => {
	beforeEach(async () => {
		await cleanup();
	});

	afterEach(async () => {
		await cleanup();
	});

	it("rejects an unauthenticated read", async () => {
		const res = await app.handle(
			new Request(`http://localhost${ENDPOINT}?factionId=${FACTION_ID}`),
		);
		expect(res.status).toBe(403);
	});

	it("rejects an unauthenticated write", async () => {
		const res = await app.handle(
			new Request(`http://localhost${ENDPOINT}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ factionId: FACTION_ID, enabled: true }),
			}),
		);
		expect(res.status).toBe(403);
	});

	it("returns factory defaults for a faction that was never configured", async () => {
		const cookie = await adminCookie();
		const res = await app.handle(
			new Request(`http://localhost${ENDPOINT}?factionId=${FACTION_ID}`, {
				headers: { cookie },
			}),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			factionId: number;
			config: typeof DEFAULT_SUBVERSIVE_CHAIN_CONFIG;
		};
		expect(body.factionId).toBe(FACTION_ID);
		expect(body.config).toMatchObject(DEFAULT_SUBVERSIVE_CHAIN_CONFIG);
	});

	it("round-trips every setting", async () => {
		const cookie = await adminCookie();

		const res = await put(cookie, {
			factionId: FACTION_ID,
			enabled: false,
			channelId: "123456789012345678",
			warningRoleId: "987654321098765432",
			minimumChainStart: 250,
			chainTimeWarningSeconds: 45,
			subsequentWarningIntervalSeconds: 15,
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			success: boolean;
			factionId: number;
			config: {
				enabled: boolean;
				channelId: string | null;
				warningRoleId: string | null;
				minimumChainStart: number;
				chainTimeWarningSeconds: number;
				subsequentWarningIntervalSeconds: number;
				updatedBy?: string;
			};
		};

		expect(body.success).toBe(true);
		expect(body.factionId).toBe(FACTION_ID);
		expect(body.config.enabled).toBe(false);
		expect(body.config.channelId).toBe("123456789012345678");
		expect(body.config.warningRoleId).toBe("987654321098765432");
		expect(body.config.minimumChainStart).toBe(250);
		expect(body.config.chainTimeWarningSeconds).toBe(45);
		expect(body.config.subsequentWarningIntervalSeconds).toBe(15);
		expect(body.config.updatedBy).toBe("chain_admin");
	});

	it("keeps the two family factions independent", async () => {
		const cookie = await adminCookie();

		await put(cookie, {
			factionId: FACTION_ID,
			minimumChainStart: 500,
		});

		const other = await app.handle(
			new Request(`http://localhost${ENDPOINT}?factionId=2013`, {
				headers: { cookie },
			}),
		);
		expect(other.status).toBe(200);
		const body = (await other.json()) as {
			config: { minimumChainStart: number };
		};
		expect(body.config.minimumChainStart).toBe(
			DEFAULT_SUBVERSIVE_CHAIN_CONFIG.minimumChainStart,
		);
	});

	it("rejects an unknown faction", async () => {
		const cookie = await adminCookie();
		const res = await put(cookie, {
			factionId: 999,
			enabled: true,
		});
		expect(res.status).toBe(400);
	});

	it("rejects out-of-range numeric settings", async () => {
		const cookie = await adminCookie();

		// Elysia's schema validation answers 422; a value that slips through to the
		// manager answers 400. Both are client errors and both must be refused.
		expect(
			[400, 422].includes(
				(
					await put(cookie, {
						factionId: FACTION_ID,
						minimumChainStart: 0,
					})
				).status,
			),
		).toBe(true);

		expect(
			[400, 422].includes(
				(
					await put(cookie, {
						factionId: FACTION_ID,
						chainTimeWarningSeconds: 1,
					})
				).status,
			),
		).toBe(true);

		expect(
			[400, 422].includes(
				(
					await put(cookie, {
						factionId: FACTION_ID,
						subsequentWarningIntervalSeconds: -1,
					})
				).status,
			),
		).toBe(true);
	});

	it("rejects a malformed channel or role snowflake", async () => {
		const cookie = await adminCookie();

		expect(
			(
				await put(cookie, {
					factionId: FACTION_ID,
					channelId: "general",
				})
			).status,
		).toBe(400);

		expect(
			(
				await put(cookie, {
					factionId: FACTION_ID,
					warningRoleId: "everyone",
				})
			).status,
		).toBe(400);
	});

	it("accepts clearing the channel and role", async () => {
		const cookie = await adminCookie();

		await put(cookie, {
			factionId: FACTION_ID,
			channelId: "123456789012345678",
			warningRoleId: "987654321098765432",
		});

		const res = await put(cookie, {
			factionId: FACTION_ID,
			channelId: null,
			warningRoleId: null,
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			config: {
				channelId: string | null;
				warningRoleId: string | null;
			};
		};
		expect(body.config.channelId).toBeNull();
		expect(body.config.warningRoleId).toBeNull();
	});
});
