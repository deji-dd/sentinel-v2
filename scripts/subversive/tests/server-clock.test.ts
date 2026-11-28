import { describe, expect, it, spyOn } from "bun:test";

import {
	observeServerTime,
	serverNowMs,
	serverNowSec,
} from "../src/lib/server-clock";

describe("server clock offset", () => {
	it("corrects a skewed local clock from serverTime", () => {
		const nowSpy = spyOn(Date, "now").mockReturnValue(1_000_000);
		try {
			// Client is 30s behind the API clock.
			observeServerTime(1_030_000);
			expect(serverNowMs()).toBe(1_030_000);
			expect(serverNowSec()).toBe(1030);
			// Leave the module clock aligned for other tests in this process.
			observeServerTime(1_000_000);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("ignores non-finite serverTime", () => {
		const nowSpy = spyOn(Date, "now").mockReturnValue(1_000_000);
		try {
			observeServerTime(Number.NaN);
			expect(serverNowMs()).toBe(1_000_000);
		} finally {
			nowSpy.mockRestore();
		}
	});
});
