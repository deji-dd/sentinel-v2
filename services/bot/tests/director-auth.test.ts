import { afterEach, describe, expect, it } from "bun:test";

import { isDirectorUser } from "../src/lib/director-auth";

const originalUserId = process.env.DISCORD_USER_ID;

afterEach(() => {
	if (originalUserId === undefined) {
		delete process.env.DISCORD_USER_ID;
	} else {
		process.env.DISCORD_USER_ID = originalUserId;
	}
});

describe("isDirectorUser", () => {
	it("accepts only the configured director", () => {
		process.env.DISCORD_USER_ID = "123456789";

		expect(isDirectorUser("123456789")).toBe(true);
		expect(isDirectorUser("987654321")).toBe(false);
	});

	it("fails closed when DISCORD_USER_ID is missing or blank", () => {
		delete process.env.DISCORD_USER_ID;
		expect(isDirectorUser("123456789")).toBe(false);

		process.env.DISCORD_USER_ID = "   ";
		expect(isDirectorUser("123456789")).toBe(false);
		expect(isDirectorUser("")).toBe(false);
		expect(isDirectorUser(undefined)).toBe(false);
	});
});
