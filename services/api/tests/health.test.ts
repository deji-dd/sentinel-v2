import { describe, expect, it } from "bun:test";
import { app } from "../src/app";

describe("Elysia API Server - Health & In-House Session Auth", () => {
	it("GET /api/health returns 200 OK with system status", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/health"),
		);

		expect(response.status).toBe(200);

		const data = (await response.json()) as Record<string, unknown>;
		expect(data.status).toBe("ok");
		expect(typeof data.timestamp).toBe("string");
		expect(typeof data.uptime).toBe("number");
		expect(typeof data.environment).toBe("string");
		expect(typeof data.host).toBe("string");
		expect(typeof data.platform).toBe("string");
		expect(typeof data.arch).toBe("string");
		expect(typeof data.bunVersion).toBe("string");
	});

	it("GET / serves index.html static SPA asset", async () => {
		const response = await app.handle(new Request("http://localhost/"));

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("<title>Sentinel - Bot Dashboard</title>");
	});

	it("GET bundled JS asset returns 200 OK with javascript content-type", async () => {
		const htmlResponse = await app.handle(new Request("http://localhost/"));
		const html = await htmlResponse.text();
		const jsMatch = html.match(/src="(?:\.\/|\/)?([^"]+\.js)"/);
		const jsFile = jsMatch ? jsMatch[1] : "";
		expect(jsFile).not.toBe("");

		const jsResponse = await app.handle(
			new Request(`http://localhost/${jsFile}`),
		);
		expect(jsResponse.status).toBe(200);
		const contentType = jsResponse.headers.get("content-type") ?? "";
		expect(contentType).toContain("javascript");
	});

	it("GET /api/v1/auth/me returns 200 OK with unauthenticated state", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/auth/me"),
		);

		expect(response.status).toBe(200);

		const data = (await response.json()) as Record<string, unknown>;
		expect(data.authenticated).toBe(false);
		expect(data.user).toBeNull();
	});

	it("performs full in-house database session lifecycle (login -> me -> logout)", async () => {
		// 1. Login via /demo-login
		const loginResponse = await app.handle(
			new Request("http://localhost/api/v1/auth/demo-login", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					username: "test_sentinel_admin",
					role: "admin",
				}),
			}),
		);

		expect(loginResponse.status).toBe(200);

		const setCookie = loginResponse.headers.get("set-cookie");
		expect(setCookie).not.toBeNull();
		expect(setCookie).toContain("session=");

		const cookieHeader = setCookie?.split(";")[0] ?? "";

		// 2. Fetch /me with session cookie
		const meResponse = await app.handle(
			new Request("http://localhost/api/v1/auth/me", {
				headers: {
					Cookie: cookieHeader,
				},
			}),
		);

		expect(meResponse.status).toBe(200);
		const meData = (await meResponse.json()) as {
			authenticated: boolean;
			user: { username: string; role: string } | null;
		};

		expect(meData.authenticated).toBe(true);
		expect(meData.user?.username).toBe("test_sentinel_admin");
		expect(meData.user?.role).toBe("admin");

		// 3. Logout via /logout with session cookie
		const logoutResponse = await app.handle(
			new Request("http://localhost/api/v1/auth/logout", {
				method: "POST",
				headers: {
					cookie: cookieHeader,
				},
			}),
		);

		expect(logoutResponse.status).toBe(200);

		// 4. Verify /me is now unauthenticated
		const postLogoutResponse = await app.handle(
			new Request("http://localhost/api/v1/auth/me", {
				headers: {
					cookie: cookieHeader,
				},
			}),
		);

		expect(postLogoutResponse.status).toBe(200);
		const postLogoutData = (await postLogoutResponse.json()) as {
			authenticated: boolean;
		};

		expect(postLogoutData.authenticated).toBe(false);
	});

	it("identifies bot-dashboard client context from origin", async () => {
		const response = await app.handle(
			new Request("https://sentinel.blasted-labs.tech/api/health", {
				headers: {
					origin: "https://sentinel.blasted-labs.tech",
				},
			}),
		);

		expect(response.status).toBe(200);
	});

	it("identifies user-dashboard client context from origin", async () => {
		const response = await app.handle(
			new Request("https://sentinel.ayodejib.dev/api/health", {
				headers: {
					origin: "https://sentinel.ayodejib.dev",
				},
			}),
		);

		expect(response.status).toBe(200);
	});
});
