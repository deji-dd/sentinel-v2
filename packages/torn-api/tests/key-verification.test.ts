import { afterEach, describe, expect, it, spyOn } from "bun:test";

import {
	PublicKeyRequiredError,
	verifyPublicApiKey,
} from "../src/key-verification";

const PUBLIC_KEY = "abcdefghijklmnop";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("verifyPublicApiKey", () => {
	afterEach(() => {
		spyOn(globalThis, "fetch").mockRestore();
	});

	it("accepts a Public Only key and resolves its Torn player", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: Parameters<typeof fetch>[0],
		) => {
			const url = String(input);
			if (url.includes("/v2/key")) {
				return jsonResponse({
					info: { access: { level: 1, type: "Public Only" } },
				});
			}
			return jsonResponse({ player_id: 1234, name: "Donor" });
		}) as unknown as typeof fetch);

		const result = await verifyPublicApiKey(PUBLIC_KEY);
		expect(result).toEqual({
			tornId: 1234,
			tornName: "Donor",
			accessLevel: 1,
			accessType: "Public Only",
		});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("rejects a Full Access key without attempting a profile lookup", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
			jsonResponse({
				info: { access: { level: 4, type: "Full Access" } },
			})) as unknown as typeof fetch);

		await expect(verifyPublicApiKey(PUBLIC_KEY)).rejects.toBeInstanceOf(
			PublicKeyRequiredError,
		);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects a custom key even when its numeric level is public", async () => {
		spyOn(globalThis, "fetch").mockImplementation((async () =>
			jsonResponse({
				info: { access: { level: 1, type: "Custom" } },
			})) as unknown as typeof fetch);

		await expect(verifyPublicApiKey(PUBLIC_KEY)).rejects.toThrow(/Public Only/);
	});

	it("rejects malformed keys before making any API call", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
			jsonResponse({})) as unknown as typeof fetch);

		await expect(verifyPublicApiKey("short")).rejects.toThrow(
			/16 alphanumeric/,
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
