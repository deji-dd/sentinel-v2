import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { tornApi } from "@sentinel/torn-api";
import {
	resolveDiscordTornUser,
	resolveTornUser,
} from "../src/lib/resolve-discord-torn-user";

describe("resolveDiscordTornUser", () => {
	let tornApiSpy: ReturnType<typeof spyOn> | null = null;

	afterEach(() => {
		if (tornApiSpy) {
			tornApiSpy.mockRestore();
			tornApiSpy = null;
		}
	});

	it("resolves tornName and tornId when Torn API returns valid profile", async () => {
		tornApiSpy = spyOn(tornApi, "get").mockImplementation((async () => {
			return {
				profile: {
					id: 1234567,
					name: "TestTornUser",
				},
				discord: {
					discord_id: "998877665544332211",
				},
			};
		}) as unknown as typeof tornApi.get);

		const result = await resolveDiscordTornUser(
			"998877665544332211",
			true, // forceRefresh
		);

		expect(result).not.toBeNull();
		expect(result?.tornId).toBe(1234567);
		expect(result?.tornName).toBe("TestTornUser");
	});

	it("returns null when Torn API returns no profile and user is not verified", async () => {
		tornApiSpy = spyOn(tornApi, "get").mockImplementation((async () => {
			throw new Error("User not found or not linked.");
		}) as unknown as typeof tornApi.get);

		const result = await resolveDiscordTornUser(
			"000000000000000000_unlinked",
			true,
		);

		expect(result).toBeNull();
	});

	it("resolves user by tornId using resolveTornUser", async () => {
		tornApiSpy = spyOn(tornApi, "get").mockImplementation((async () => {
			return {
				profile: {
					id: 7654321,
					name: "TargetPlayer",
				},
				discord: {
					discord_id: "112233445566778899",
				},
			};
		}) as unknown as typeof tornApi.get);

		const result = await resolveTornUser({ tornId: 7654321 }, true);

		expect(result).not.toBeNull();
		expect(result?.tornId).toBe(7654321);
		expect(result?.tornName).toBe("TargetPlayer");
	});
});
