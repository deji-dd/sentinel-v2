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
		expect(html).toContain("<title>Sentinel - Dashboard</title>");
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

	it("GET /v2/auth/me returns 200 OK with unauthenticated state", async () => {
		const response = await app.handle(
			new Request("http://localhost/v2/auth/me"),
		);

		expect(response.status).toBe(200);

		const data = (await response.json()) as Record<string, unknown>;
		expect(data.authenticated).toBe(false);
		expect(data.user).toBeNull();
	});

	it("GET /api/v1/auth/me returns 404 (retired v1 endpoint)", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/auth/me"),
		);

		expect(response.status).toBe(404);
	});

	it("performs full in-house database session lifecycle (login -> me -> logout)", async () => {
		// 1. Login via /v2/auth/demo-login
		const loginResponse = await app.handle(
			new Request("http://localhost/v2/auth/demo-login", {
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
			new Request("http://localhost/v2/auth/me", {
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

		// 3. Logout via /v2/auth/logout with session cookie
		const logoutResponse = await app.handle(
			new Request("http://localhost/v2/auth/logout", {
				method: "POST",
				headers: {
					cookie: cookieHeader,
				},
			}),
		);

		expect(logoutResponse.status).toBe(200);

		// 4. Verify /me is now unauthenticated
		const postLogoutResponse = await app.handle(
			new Request("http://localhost/v2/auth/me", {
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

	it("identifies dashboard client context from origin", async () => {
		const response = await app.handle(
			new Request("https://dashboard.blasted-labs.tech/health", {
				headers: {
					origin: "https://dashboard.blasted-labs.tech",
					host: "dashboard.blasted-labs.tech",
				},
			}),
		);

		expect(response.status).toBe(200);
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

	it("blocks requests to retired domain sentinel.ayodejib.dev with 404", async () => {
		const response = await app.handle(
			new Request("https://sentinel.ayodejib.dev/api/health", {
				headers: {
					host: "sentinel.ayodejib.dev",
					origin: "https://sentinel.ayodejib.dev",
				},
			}),
		);

		expect(response.status).toBe(404);
	});

	it("rejects CORS for retired domain sentinel.ayodejib.dev", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/health", {
				method: "OPTIONS",
				headers: {
					origin: "https://sentinel.ayodejib.dev",
					"access-control-request-method": "GET",
				},
			}),
		);

		const allowOrigin = response.headers.get("access-control-allow-origin");
		expect(allowOrigin).not.toBe("https://sentinel.ayodejib.dev");
	});

	it("identifies elims-dashboard client context from origin and host", async () => {
		const response = await app.handle(
			new Request("https://elims.blasted-labs.tech/api/health", {
				headers: {
					origin: "https://elims.blasted-labs.tech",
				},
			}),
		);

		expect(response.status).toBe(200);
	});

	it("GET / serves dashboard static SPA when Host contains elims", async () => {
		const response = await app.handle(
			new Request("http://localhost/", {
				headers: {
					host: "elims.blasted-labs.tech",
				},
			}),
		);

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('id="root"');
	});

	it("identifies subversive-dashboard client context from origin and host", async () => {
		const response = await app.handle(
			new Request("https://subversive.blasted-labs.tech/api/health", {
				headers: {
					origin: "https://subversive.blasted-labs.tech",
				},
			}),
		);

		expect(response.status).toBe(200);
	});

	it("GET / serves dashboard static SPA when Host contains subversive", async () => {
		const response = await app.handle(
			new Request("http://localhost/", {
				headers: {
					host: "subversive.blasted-labs.tech",
				},
			}),
		);

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('id="root"');
	});
});
