import { describe, expect, it } from "bun:test";

import { pickTornAvatarUrl } from "../src/lib/torn-avatar";

describe("Torn avatar URL extraction", () => {
	it("reads the flat v1 profile_image field", () => {
		expect(
			pickTornAvatarUrl({
				player_id: 1934909,
				profile_image: "https://profileimages.torn.com/abc.png",
			}),
		).toBe("https://profileimages.torn.com/abc.png");
	});

	it("reads the nested v2 profile.image field", () => {
		expect(
			pickTornAvatarUrl({
				profile: { image: "https://profileimages.torn.com/nested.png" },
			}),
		).toBe("https://profileimages.torn.com/nested.png");
	});

	it("prefers profile_image over legacy fields", () => {
		expect(
			pickTornAvatarUrl({
				profile_image: "https://profileimages.torn.com/new.png",
				image: "https://profileimages.torn.com/old.png",
			}),
		).toBe("https://profileimages.torn.com/new.png");
	});

	it("rejects missing, relative and insecure URLs", () => {
		expect(pickTornAvatarUrl(null)).toBeNull();
		expect(pickTornAvatarUrl({})).toBeNull();
		expect(
			pickTornAvatarUrl({ profile_image: "/images/avatar.png" }),
		).toBeNull();
		expect(
			pickTornAvatarUrl({
				profile_image: "http://profileimages.torn.com/a.png",
			}),
		).toBeNull();
	});
});
