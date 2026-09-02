import { describe, expect, it } from "bun:test";
import { isTargetGuild } from "@sentinel/database";
import { app } from "../src/app";

describe("Elysia API Server - Guild Authorization Endpoints", () => {
	it("blocks non-admin users from authorizing servers", async () => {
		const res = await app.handle(
			new Request("http://localhost/api/v1/guilds/authorize", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ guildId: "123456789012345678" }),
			}),
		);

		expect(res.status).toBe(403);
	});

	it("allows admin to authorize a guild and returns valid invite URL", async () => {
		// 1. Log in as admin
		const loginRes = await app.handle(
			new Request("http://localhost/api/v1/auth/demo-login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					username: "admin_test",
					role: "admin",
				}),
			}),
		);
		expect(loginRes.status).toBe(200);
		const cookie = loginRes.headers.get("set-cookie") ?? "";

		const testGuildId = "112233445566778899";

		// 2. Authorize guild
		const authRes = await app.handle(
			new Request("http://localhost/api/v1/guilds/authorize", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
				},
				body: JSON.stringify({ guildId: testGuildId }),
			}),
		);

		expect(authRes.status).toBe(200);
		const authData = (await authRes.json()) as {
			success: boolean;
			guildId: string;
			inviteUrl: string;
		};

		expect(authData.success).toBe(true);
		expect(authData.guildId).toBe(testGuildId);
		expect(authData.inviteUrl).toContain(testGuildId);
		expect(authData.inviteUrl).toContain("oauth2/authorize");
		expect(isTargetGuild(testGuildId)).toBe(true);

		// 3. Deauthorize guild
		const deauthRes = await app.handle(
			new Request("http://localhost/api/v1/guilds/deauthorize", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
				},
				body: JSON.stringify({ guildId: testGuildId }),
			}),
		);

		expect(deauthRes.status).toBe(200);
		const deauthData = (await deauthRes.json()) as {
			success: boolean;
			guildId: string;
		};
		expect(deauthData.success).toBe(true);
		expect(isTargetGuild(testGuildId)).toBe(false);
	});

	it("restricts module toggling strictly to bot owner", async () => {
		const testGuildId = "1096243613681332328";

		// 1. Log in as regular admin (not bot owner)
		const adminLogin = await app.handle(
			new Request("http://localhost/api/v1/auth/demo-login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					username: "guild_admin",
					role: "admin",
				}),
			}),
		);
		const adminCookie = adminLogin.headers.get("set-cookie") ?? "";

		// Admin should be blocked from toggling modules via PATCH /modules
		const patchResAdmin = await app.handle(
			new Request(`http://localhost/api/v1/guilds/${testGuildId}/modules`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					Cookie: adminCookie,
				},
				body: JSON.stringify({ moduleVerification: false }),
			}),
		);
		expect(patchResAdmin.status).toBe(403);

		// Admin should also be blocked from updating modules via PUT /config
		const putResAdmin = await app.handle(
			new Request(`http://localhost/api/v1/guilds/${testGuildId}/config`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Cookie: adminCookie,
				},
				body: JSON.stringify({ moduleVerification: false }),
			}),
		);
		expect(putResAdmin.status).toBe(403);

		// 2. Log in as bot owner
		const ownerLogin = await app.handle(
			new Request("http://localhost/api/v1/auth/demo-login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					username: "bot_owner",
					role: "owner",
				}),
			}),
		);
		const ownerCookie = ownerLogin.headers.get("set-cookie") ?? "";

		// Bot owner can toggle modules
		const patchResOwner = await app.handle(
			new Request(`http://localhost/api/v1/guilds/${testGuildId}/modules`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					Cookie: ownerCookie,
				},
				body: JSON.stringify({
					moduleVerification: false,
					moduleTerritory: true,
				}),
			}),
		);
		expect(patchResOwner.status).toBe(200);
		const patchData = (await patchResOwner.json()) as {
			success: boolean;
			modules: { verification: boolean; territory: boolean };
		};
		expect(patchData.success).toBe(true);
		expect(patchData.modules.verification).toBe(false);

		// Re-enable verification as owner
		const restoreRes = await app.handle(
			new Request(`http://localhost/api/v1/guilds/${testGuildId}/modules`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					Cookie: ownerCookie,
				},
				body: JSON.stringify({
					moduleVerification: true,
				}),
			}),
		);
		expect(restoreRes.status).toBe(200);
		const restoreData = (await restoreRes.json()) as {
			success: boolean;
			modules: { verification: boolean };
		};
		expect(restoreData.modules.verification).toBe(true);
	});
});
