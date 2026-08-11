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
});
