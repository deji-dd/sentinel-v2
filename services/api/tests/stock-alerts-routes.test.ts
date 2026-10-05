import { afterEach, describe, expect, it } from "bun:test";
import { db, eq, subversiveStockAlertConfigs } from "@sentinel/database";
import { app } from "../src/app";
import { subversiveStockAlertManager } from "../src/lib/stock-alert-config-manager";

/**
 * Route-level coverage for the stock alert configuration surface.
 *
 * The happy paths need an admin session, which the dev-only demo login issues;
 * the authorisation cases need no session at all. Every write is scoped to the
 * primary family faction and removed afterwards.
 */

const FACTION_ID = 2013;
const ENDPOINT = `/v2/subversive/stock-alert-config?factionId=${FACTION_ID}`;

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
		.delete(subversiveStockAlertConfigs)
		.where(eq(subversiveStockAlertConfigs.factionId, FACTION_ID));
	subversiveStockAlertManager.clearCacheForTesting();
}

describe("Stock alert configuration routes", () => {
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
			new Request("http://localhost/v2/subversive/stock-alert-config", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ factionId: FACTION_ID, enabled: true }),
			}),
		);

		expect(res.status).toBe(403);
	});

	it("returns the factory defaults for a faction that was never configured", async () => {
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
			factionId: number;
			factionName: string;
			config: {
				enabled: boolean;
				channelId: string | null;
				cooldownMinutes: number;
			};
		};
		expect(body.factionId).toBe(FACTION_ID);
		expect(body.factionName).toBe("Subversive Alliance");
		expect(body.config.enabled).toBe(false);
		expect(body.config.channelId).toBeNull();
		expect(body.config.cooldownMinutes).toBe(30);
	});

	it("round-trips a saved configuration", async () => {
		await cleanup();
		const cookie = await adminCookie();

		const putRes = await app.handle(
			new Request("http://localhost/v2/subversive/stock-alert-config", {
				method: "PUT",
				headers: { "Content-Type": "application/json", cookie },
				body: JSON.stringify({
					factionId: FACTION_ID,
					enabled: true,
					channelId: "123456789012345678",
					changeRules: [
						{ windowMinutes: 30, thresholdPct: 0.5 },
						{ windowMinutes: 60, thresholdPct: 1 },
					],
					highLowWindows: ["24h", "all_time"],
					cooldownMinutes: 45,
				}),
			}),
		);

		expect(putRes.status).toBe(200);
		const putBody = (await putRes.json()) as {
			success: boolean;
			config: { enabled: boolean; channelId: string | null };
		};
		expect(putBody.success).toBe(true);
		expect(putBody.config.enabled).toBe(true);
		expect(putBody.config.channelId).toBe("123456789012345678");

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
				highLowWindows: string[];
				cooldownMinutes: number;
			};
		};
		expect(getBody.config.enabled).toBe(true);
		expect(getBody.config.cooldownMinutes).toBe(45);
		expect(getBody.config.highLowWindows).toEqual(["24h", "all_time"]);
		expect(getBody.config.changeRules).toHaveLength(2);
	});

	it("rejects an invalid configuration with a 400 and a reason", async () => {
		await cleanup();
		const cookie = await adminCookie();

		const res = await app.handle(
			new Request("http://localhost/v2/subversive/stock-alert-config", {
				method: "PUT",
				headers: { "Content-Type": "application/json", cookie },
				body: JSON.stringify({
					factionId: FACTION_ID,
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
			.from(subversiveStockAlertConfigs)
			.where(eq(subversiveStockAlertConfigs.factionId, FACTION_ID));
		expect(rows).toHaveLength(0);
	});

	it("rejects a faction outside the Subversive family", async () => {
		const cookie = await adminCookie();

		const res = await app.handle(
			new Request(
				"http://localhost/v2/subversive/stock-alert-config?factionId=12345",
				{ method: "GET", headers: { cookie } },
			),
		);

		expect(res.status).toBe(400);
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
			new Request("http://localhost/v2/subversive/stock-alerts/run-now", {
				method: "POST",
				headers: { cookie },
			}),
		);

		expect(res.status).toBe(403);
	});
});
