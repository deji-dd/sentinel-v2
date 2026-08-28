import { describe, expect, it, mock, spyOn } from "bun:test";
import { TornApiClient } from "../src/client";
import { TornError } from "../src/types";

describe("TornApiClient", () => {
	it("triggers onInvalidKey callback when error code 2 is returned", async () => {
		// Fix 1: Use mock() for standalone callbacks (1 argument)
		const onInvalidKeyMock = mock(async () => {});
		const client = new TornApiClient({ onInvalidKey: onInvalidKeyMock });

		// Fix 2: Cast mock implementation through unknown to satisfy Bun's fetch type
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () =>
				new Response(
					JSON.stringify({ error: { code: 2, error: "Incorrect key" } }),
				)) as unknown as typeof fetch,
		);

		try {
			await client.get("/user", { apiKey: "invalidkey123456" });
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(TornError);
			if (err instanceof TornError) {
				expect(err.code).toBe(2);
			}
		}

		expect(onInvalidKeyMock).toHaveBeenCalledWith("invalidkey123456", 2);

		// Restore original fetch implementation
		fetchSpy.mockRestore();
	});

	it("triggers onInvalidKey callback when error code 13 (Key temporarily disabled) is returned", async () => {
		const onInvalidKeyMock = mock(async () => {});
		const client = new TornApiClient({ onInvalidKey: onInvalidKeyMock });

		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () =>
				new Response(
					JSON.stringify({
						error: { code: 13, error: "Key temporarily disabled" },
					}),
				)) as unknown as typeof fetch,
		);

		try {
			await client.get("/user", { apiKey: "tempdisabledkey" });
		} catch (err: unknown) {
			expect(err).toBeInstanceOf(TornError);
			if (err instanceof TornError) {
				expect(err.code).toBe(13);
			}
		}

		expect(onInvalidKeyMock).toHaveBeenCalledWith("tempdisabledkey", 13);
		fetchSpy.mockRestore();
	});

	it("includes comment=Sentinel flag in API v2 request URL", async () => {
		let requestedUrl = "";
		const client = new TornApiClient();

		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			requestedUrl = url.toString();
			return new Response(JSON.stringify({ success: true }));
		}) as unknown as typeof fetch);

		await client.get("/user", { apiKey: "test_key" });

		const parsedUrl = new URL(requestedUrl);
		expect(parsedUrl.searchParams.get("comment")).toBe("Sentinel");

		fetchSpy.mockRestore();
	});

	it("includes comment=Sentinel flag in API v1 raw request URL", async () => {
		let requestedUrl = "";
		const client = new TornApiClient();

		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			url: string | URL,
		) => {
			requestedUrl = url.toString();
			return new Response(JSON.stringify({ success: true }));
		}) as unknown as typeof fetch);

		await client.getRaw("user/", { apiKey: "test_key" });

		const parsedUrl = new URL(requestedUrl);
		expect(parsedUrl.searchParams.get("comment")).toBe("Sentinel");

		fetchSpy.mockRestore();
	});
});
