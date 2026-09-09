import { describe, expect, it } from "bun:test";
import { app } from "../src/app";

describe("Elims Server Users Public Endpoint", () => {
	it("GET /api/v1/elims/users returns 200 with JSON array and CORS headers", async () => {
		const res = await app.handle(
			new Request("http://localhost/api/v1/elims/users"),
		);

		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");

		const users = (await res.json()) as Array<Record<string, unknown>>;
		expect(Array.isArray(users)).toBe(true);

		if (users.length > 0) {
			const first = users[0];
			expect(first).toBeDefined();
			expect(first?.id).toBeDefined();
			expect(typeof first?.name).toBe("string");
		}
	});

	it("GET /api/elims/users alias returns 200 with JSON array", async () => {
		const res = await app.handle(
			new Request("http://localhost/api/elims/users"),
		);

		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");

		const users = (await res.json()) as Array<Record<string, unknown>>;
		expect(Array.isArray(users)).toBe(true);
	});

	it("GET /api/users alias returns 200 with JSON array", async () => {
		const res = await app.handle(new Request("http://localhost/api/users"));

		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");

		const users = (await res.json()) as Array<Record<string, unknown>>;
		expect(Array.isArray(users)).toBe(true);
	});

	it("GET /api/v1/elims/users?strict=true returns objects strictly with id and name", async () => {
		const res = await app.handle(
			new Request("http://localhost/api/v1/elims/users?strict=true"),
		);

		expect(res.status).toBe(200);
		const users = (await res.json()) as Array<Record<string, unknown>>;
		expect(Array.isArray(users)).toBe(true);

		if (users.length > 0) {
			const first = users[0];
			expect(first).toBeDefined();
			expect(first?.id).toBeDefined();
			expect(typeof first?.name).toBe("string");
			expect(Object.keys(first ?? {})).toEqual(["id", "name"]);
		}
	});

	it("GET /api/v1/elims/users?type=discord returns Discord IDs and names", async () => {
		const res = await app.handle(
			new Request("http://localhost/api/v1/elims/users?type=discord"),
		);

		expect(res.status).toBe(200);
		const users = (await res.json()) as Array<Record<string, unknown>>;
		expect(Array.isArray(users)).toBe(true);

		if (users.length > 0) {
			const first = users[0];
			expect(first).toBeDefined();
			expect(typeof first?.id).toBe("string");
			expect(typeof first?.name).toBe("string");
		}
	});

	it("GET /api/v1/elims/users?type=torn returns Torn IDs and names", async () => {
		const res = await app.handle(
			new Request("http://localhost/api/v1/elims/users?type=torn"),
		);

		expect(res.status).toBe(200);
		const users = (await res.json()) as Array<Record<string, unknown>>;
		expect(Array.isArray(users)).toBe(true);

		if (users.length > 0) {
			const first = users[0];
			expect(first).toBeDefined();
			expect(typeof first?.id).toBe("number");
			expect(typeof first?.name).toBe("string");
		}
	});

	it("GET /users on api.elims.blasted-labs.tech host returns 200 with JSON array", async () => {
		const res = await app.handle(
			new Request("https://api.elims.blasted-labs.tech/users", {
				headers: {
					host: "api.elims.blasted-labs.tech",
				},
			}),
		);

		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");

		const users = (await res.json()) as Array<Record<string, unknown>>;
		expect(Array.isArray(users)).toBe(true);
	});

	it("GET / on api.elims.blasted-labs.tech returns status with endpoint info", async () => {
		const res = await app.handle(
			new Request("https://api.elims.blasted-labs.tech/", {
				headers: {
					host: "api.elims.blasted-labs.tech",
				},
			}),
		);

		expect(res.status).toBe(200);
		const data = (await res.json()) as Record<string, unknown>;
		expect(data.service).toBe("api.elims.blasted-labs.tech");
		expect(data.status).toBe("online");
	});
});
