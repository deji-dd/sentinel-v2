import { describe, expect, it } from "bun:test";
import { app } from "../src/app";

describe("Elysia API Server - Personal Script Routes", () => {
	it("GET /v2/personal/script serves production userscript by default", async () => {
		const response = await app.handle(
			new Request("http://localhost/v2/personal/script"),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain(
			"application/javascript",
		);
		const text = await response.text();
		expect(text).toContain("Blasted's Script");
		expect(text).toContain(
			"https://api.blasted-labs.tech/v2/personal/script.user.js",
		);
	});

	it("GET /v2/personal/script.user.js serves production userscript directly for Tampermonkey", async () => {
		const response = await app.handle(
			new Request("http://localhost/v2/personal/script.user.js"),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain(
			"application/javascript",
		);
		const text = await response.text();
		expect(text).toContain("Blasted's Script");
		expect(text).toContain(
			"// @downloadURL  https://api.blasted-labs.tech/v2/personal/script.user.js",
		);
		expect(text).toContain(
			"// @updateURL    https://api.blasted-labs.tech/v2/personal/script.user.js",
		);
	});

	it("GET /v2/personal/script?env=dev serves dev userscript configured for localhost", async () => {
		const response = await app.handle(
			new Request("http://localhost/v2/personal/script?env=dev"),
		);

		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).toContain('apiUrl: "http://localhost:3000"');
		expect(text).toContain(
			"@downloadURL  http://localhost:3000/v2/personal/script.user.js?env=dev",
		);
		expect(text).toContain(
			"@updateURL    http://localhost:3000/v2/personal/script.user.js?env=dev",
		);
	});

	it("GET /v2/system/crime-ledger/script.user.js maintains backward compatibility", async () => {
		const response = await app.handle(
			new Request("http://localhost/v2/system/crime-ledger/script.user.js"),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain(
			"application/javascript",
		);
		const text = await response.text();
		expect(text).toContain("Blasted's Script");
		expect(text).toContain(
			"// @downloadURL  https://api.blasted-labs.tech/v2/personal/script.user.js",
		);
	});

	it("GET /api/v1/system/crime-ledger/script.user.js maintains backward compatibility for legacy script installations", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/system/crime-ledger/script.user.js"),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain(
			"application/javascript",
		);
		const text = await response.text();
		expect(text).toContain("Blasted's Script");
		expect(text).toContain(
			"// @downloadURL  https://api.blasted-labs.tech/v2/personal/script.user.js",
		);
		expect(text).toContain(
			"// @updateURL    https://api.blasted-labs.tech/v2/personal/script.user.js",
		);
	});
});
