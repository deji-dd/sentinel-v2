import { afterEach, describe, expect, it } from "bun:test";
import { db, eq, guildStockAlertConfigs } from "@sentinel/database";
import { app } from "../src/app";

/**
 * Route-level coverage for the guild-wide stock alert configuration surface.
 *
 * The happy paths need an admin session, which the dev-only demo login issues; the
 * authorisation cases need no session at all. Every write is scoped to one test
 * guild and removed afterwards.
 */

const GUILD_ID = "999888777666555444";
const OTHER_GUILD_ID = "999888777666555445";
const ENDPOINT = `/v2/guilds/${GUILD_ID}/stock-alert-config`;

async function adminCookie(): Promise<string> {
	const res = await app.handle(
		new Request("http://localhost/v2/auth/demo-login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "stock_alert_admin", role: "admin" }),
		}),
	);
	expect(res.status).toBe(200);
	return res.headers.get("set-cookie") ?? "";
}

async function cleanup(): Promise<void> {
	await db
		.delete(guildStockAlertConfigs)
		.where(eq(guildStockAlertConfigs.guildId, GUILD_ID));
	await db
		.delete(guildStockAlertConfigs)
		.where(eq(guildStockAlertConfigs.guildId, OTHER_GUILD_ID));
}

describe("Guild stock alert configuration routes", () => {
	afterEach(async () => {
		await cleanup();
	});

	it("rejects an unauthenticated read", async () => {
		const res = await app.handle(
			new Request(`http://localhost${ENDPOINT}`, { method: "GET" }),
		);

		expect(res.status).toBe(403);
	});

	it("rejects an unauthenticated write", async () => {
		const res = await app.handle(
			new Request(`http://localhost${ENDPOINT}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: true }),
			}),
		);

		expect(res.status).toBe(403);
	});

	it("returns the factory defaults for a guild that was never configured", async () => {
		await cleanup();
		const cookie = await adminCookie();

		const res = await app.handle(
			new Request(`http://localhost${ENDPOINT}`, {
				method: "GET",
				headers: { cookie },
			}),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			guildId: string;
			config: {
				enabled: boolean;
				channelId: string | null;
				highLowRanges: string[];
				cooldownMinutes: number;
			};
		};
		expect(body.guildId).toBe(GUILD_ID);
		expect(body.config.enabled).toBe(false);
		expect(body.config.channelId).toBeNull();
		expect(body.config.highLowRanges).toEqual(["24h", "all_time"]);
		expect(body.config.cooldownMinutes).toBe(30);
	});

	it("round-trips a saved configuration, including a range beyond the original two", async () => {
		await cleanup();
		const cookie = await adminCookie();

		const putRes = await app.handle(
			new Request(`http://localhost${ENDPOINT}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json", cookie },
				body: JSON.stringify({
					enabled: true,
					channelId: "123456789012345678",
					changeRules: [
						{ windowMinutes: 30, thresholdPct: 0.5 },
						{ windowMinutes: 10_080, thresholdPct: 8 },
					],
					highLowRanges: ["30d", "7d", "all_time"],
					cooldownMinutes: 45,
				}),
			}),
		);

		expect(putRes.status).toBe(200);
		const putBody = (await putRes.json()) as {
			success: boolean;
			config: {
				enabled: boolean;
				channelId: string | null;
				highLowRanges: string[];
			};
		};
		expect(putBody.success).toBe(true);
		expect(putBody.config.enabled).toBe(true);
		expect(putBody.config.channelId).toBe("123456789012345678");
		// Stored in the canonical range order rather than the request's order, so the
		// embed field list is stable.
		expect(putBody.config.highLowRanges).toEqual(["7d", "30d", "all_time"]);

		const getRes = await app.handle(
			new Request(`http://localhost${ENDPOINT}`, {
				method: "GET",
				headers: { cookie },
			}),
		);
		expect(getRes.status).toBe(200);
		const getBody = (await getRes.json()) as {
			config: {
				enabled: boolean;
				changeRules: { windowMinutes: number; thresholdPct: number }[];
				highLowRanges: string[];
				cooldownMinutes: number;
			};
		};
		expect(getBody.config.enabled).toBe(true);
		expect(getBody.config.cooldownMinutes).toBe(45);
		expect(getBody.config.highLowRanges).toEqual(["7d", "30d", "all_time"]);
		expect(getBody.config.changeRules).toHaveLength(2);
		expect(
			getBody.config.changeRules
				.map((rule) => rule.windowMinutes)
				.sort((a, b) => a - b),
		).toEqual([30, 10_080]);
	});

	it("keeps each guild's settings separate", async () => {
		await cleanup();
		const cookie = await adminCookie();

		const save = async (guildId: string, cooldownMinutes: number) =>
			app.handle(
				new Request(
					`http://localhost/v2/guilds/${guildId}/stock-alert-config`,
					{
						method: "PUT",
						headers: { "Content-Type": "application/json", cookie },
						body: JSON.stringify({ enabled: true, cooldownMinutes }),
					},
				),
			);

		expect((await save(GUILD_ID, 15)).status).toBe(200);
		expect((await save(OTHER_GUILD_ID, 90)).status).toBe(200);

		const read = async (guildId: string) => {
			const res = await app.handle(
				new Request(
					`http://localhost/v2/guilds/${guildId}/stock-alert-config`,
					{
						headers: { cookie },
					},
				),
			);
			return (await res.json()) as { config: { cooldownMinutes: number } };
		};

		expect((await read(GUILD_ID)).config.cooldownMinutes).toBe(15);
		expect((await read(OTHER_GUILD_ID)).config.cooldownMinutes).toBe(90);
	});

	it("rejects an invalid configuration with a 400 and a reason", async () => {
		await cleanup();
		const cookie = await adminCookie();

		const res = await app.handle(
			new Request(`http://localhost${ENDPOINT}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json", cookie },
				body: JSON.stringify({
					changeRules: [{ windowMinutes: 7, thresholdPct: 0.5 }],
				}),
			}),
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Invalid change window");

		// Nothing was written by the rejected patch.
		const rows = await db
			.select()
			.from(guildStockAlertConfigs)
			.where(eq(guildStockAlertConfigs.guildId, GUILD_ID));
		expect(rows).toHaveLength(0);
	});

	it("rejects an unknown range with a 400", async () => {
		await cleanup();
		const cookie = await adminCookie();

		const res = await app.handle(
			new Request(`http://localhost${ENDPOINT}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json", cookie },
				body: JSON.stringify({ highLowRanges: ["24h", "last_week"] }),
			}),
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Invalid high/low range");
	});

	it("accepts a long move window", async () => {
		await cleanup();
		const cookie = await adminCookie();

		const res = await app.handle(
			new Request(`http://localhost${ENDPOINT}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json", cookie },
				body: JSON.stringify({
					changeRules: [{ windowMinutes: 525_600, thresholdPct: 40 }],
				}),
			}),
		);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			config: {
				changeRules: { windowMinutes: number; thresholdPct: number }[];
			};
		};
		expect(body.config.changeRules).toEqual([
			{ windowMinutes: 525_600, thresholdPct: 40 },
		]);
	});

	it("blocks a non-admin from triggering a check", async () => {
		const loginRes = await app.handle(
			new Request("http://localhost/v2/auth/demo-login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "stock_alert_user", role: "user" }),
			}),
		);
		const cookie = loginRes.headers.get("set-cookie") ?? "";

		const res = await app.handle(
			new Request(
				`http://localhost/v2/guilds/${GUILD_ID}/stock-alerts/run-now`,
				{
					method: "POST",
					headers: { cookie },
				},
			),
		);

		expect(res.status).toBe(403);
	});
});
