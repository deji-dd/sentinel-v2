import { describe, expect, it } from "bun:test";
import { app } from "../src/app";

describe("Swagger Domain-Scoped Documentation", () => {
	it("scopes elims.blasted-labs.tech to elims endpoints only", async () => {
		const res = await app.handle(
			new Request("https://elims.blasted-labs.tech/swagger/json", {
				headers: { host: "elims.blasted-labs.tech" },
			}),
		);

		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			info: { title: string; description: string };
			paths: Record<string, unknown>;
		};

		expect(json.info.title).toBe("Sentinel V2 — Elims API");
		expect(json.info.description).toContain("Elims Dashboard");

		const paths = Object.keys(json.paths);
		expect(paths.length).toBeGreaterThan(0);

		// Must include elims, users, health
		expect(paths.some((p) => p.startsWith("/api/v1/elims"))).toBe(true);
		expect(paths.some((p) => p.startsWith("/users"))).toBe(true);
		expect(paths.some((p) => p.startsWith("/api/health"))).toBe(true);

		// Must NOT include guilds, tt, pond, or system ledger
		expect(paths.some((p) => p.startsWith("/api/v1/guilds"))).toBe(false);
		expect(paths.some((p) => p.startsWith("/api/v1/tt"))).toBe(false);
		expect(paths.some((p) => p.startsWith("/pond"))).toBe(false);
		expect(paths.some((p) => p.startsWith("/api/v1/system"))).toBe(false);
	});

	it("scopes tt-selector.blasted-labs.tech to tt endpoints only", async () => {
		const res = await app.handle(
			new Request("https://tt-selector.blasted-labs.tech/swagger/json", {
				headers: { host: "tt-selector.blasted-labs.tech" },
			}),
		);

		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			info: { title: string; description: string };
			paths: Record<string, unknown>;
		};

		expect(json.info.title).toBe("Sentinel V2 — TT Selector API");

		const paths = Object.keys(json.paths);
		expect(paths.length).toBeGreaterThan(0);

		// Must include tt, health
		expect(paths.some((p) => p.startsWith("/api/v1/tt"))).toBe(true);
		expect(paths.some((p) => p.startsWith("/api/health"))).toBe(true);

		// Must NOT include elims, guilds, pond, system
		expect(paths.some((p) => p.startsWith("/api/v1/elims"))).toBe(false);
		expect(paths.some((p) => p.startsWith("/api/v1/guilds"))).toBe(false);
		expect(paths.some((p) => p.startsWith("/pond"))).toBe(false);
	});

	it("scopes sentinel.blasted-labs.tech to bot configuration endpoints only", async () => {
		const res = await app.handle(
			new Request("https://sentinel.blasted-labs.tech/swagger/json", {
				headers: { host: "sentinel.blasted-labs.tech" },
			}),
		);

		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			info: { title: string; description: string };
			paths: Record<string, unknown>;
		};

		expect(json.info.title).toBe("Sentinel V2 — Bot Configuration API");

		const paths = Object.keys(json.paths);
		expect(paths.length).toBeGreaterThan(0);

		// Must include guilds, auth, health
		expect(paths.some((p) => p.startsWith("/api/v1/guilds"))).toBe(true);
		expect(paths.some((p) => p.startsWith("/api/v1/auth"))).toBe(true);
		expect(paths.some((p) => p.startsWith("/api/health"))).toBe(true);

		// Must NOT include elims, tt, pond, system
		expect(paths.some((p) => p.startsWith("/api/v1/elims"))).toBe(false);
		expect(paths.some((p) => p.startsWith("/api/v1/tt"))).toBe(false);
		expect(paths.some((p) => p.startsWith("/pond"))).toBe(false);
	});

	it("scopes sentinel.ayodejib.dev to user dashboard endpoints", async () => {
		const res = await app.handle(
			new Request("https://sentinel.ayodejib.dev/swagger/json", {
				headers: { host: "sentinel.ayodejib.dev" },
			}),
		);

		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			info: { title: string; description: string };
			paths: Record<string, unknown>;
		};

		expect(json.info.title).toBe("Sentinel V2 — User Dashboard API");

		const paths = Object.keys(json.paths);
		expect(paths.length).toBeGreaterThan(0);

		// Must include system, auth, health
		expect(paths.some((p) => p.startsWith("/api/v1/system"))).toBe(true);
		expect(paths.some((p) => p.startsWith("/api/v1/auth"))).toBe(true);
		expect(paths.some((p) => p.startsWith("/api/health"))).toBe(true);

		// Must NOT include elims, tt, pond
		expect(paths.some((p) => p.startsWith("/api/v1/elims"))).toBe(false);
		expect(paths.some((p) => p.startsWith("/api/v1/tt"))).toBe(false);
		expect(paths.some((p) => p.startsWith("/pond"))).toBe(false);
	});

	it("serves all endpoints on swagger.ayodejib.dev and localhost", async () => {
		const swaggerDomainRes = await app.handle(
			new Request("https://swagger.ayodejib.dev/swagger/json", {
				headers: { host: "swagger.ayodejib.dev" },
			}),
		);

		expect(swaggerDomainRes.status).toBe(200);
		const swaggerJson = (await swaggerDomainRes.json()) as {
			info: { title: string };
			paths: Record<string, unknown>;
		};
		expect(swaggerJson.info.title).toBe("Sentinel V2 API Documentation");

		const localhostRes = await app.handle(
			new Request("http://localhost:3000/swagger/json", {
				headers: { host: "localhost:3000" },
			}),
		);
		expect(localhostRes.status).toBe(200);
		const localhostJson = (await localhostRes.json()) as {
			paths: Record<string, unknown>;
		};

		// Should include all domains' endpoints
		const allPaths = Object.keys(localhostJson.paths);
		expect(allPaths.some((p) => p.startsWith("/api/v1/elims"))).toBe(true);
		expect(allPaths.some((p) => p.startsWith("/api/v1/tt"))).toBe(true);
		expect(allPaths.some((p) => p.startsWith("/api/v1/guilds"))).toBe(true);
		expect(allPaths.some((p) => p.startsWith("/api/v1/system"))).toBe(true);
		expect(allPaths.some((p) => p.startsWith("/pond"))).toBe(true);
		expect(allPaths.length).toBeGreaterThan(50);
	});

	it("serves scoped HTML <title> on GET /swagger", async () => {
		const resElims = await app.handle(
			new Request("https://elims.blasted-labs.tech/swagger", {
				headers: { host: "elims.blasted-labs.tech" },
			}),
		);
		expect(resElims.status).toBe(200);
		const htmlElims = await resElims.text();
		expect(htmlElims).toContain("<title>Sentinel V2 — Elims API</title>");

		const resBot = await app.handle(
			new Request("https://sentinel.blasted-labs.tech/swagger", {
				headers: { host: "sentinel.blasted-labs.tech" },
			}),
		);
		expect(resBot.status).toBe(200);
		const htmlBot = await resBot.text();
		expect(htmlBot).toContain(
			"<title>Sentinel V2 — Bot Configuration API</title>",
		);
	});
});
