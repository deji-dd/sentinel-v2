import { describe, expect, test } from "bun:test";

import { nextAlignedPayoutAt } from "../src/capital-time";

describe("capital payout calendar", () => {
	test("daily lots align to the next UTC midnight", () => {
		expect(
			nextAlignedPayoutAt(
				new Date("2026-01-01T12:34:56Z"),
				"daily",
			).toISOString(),
		).toBe("2026-01-02T00:00:00.000Z");
	});

	test("weekly lots align to Monday 00:00 UTC", () => {
		expect(
			nextAlignedPayoutAt(
				new Date("2026-01-01T12:00:00Z"),
				"weekly",
			).toISOString(),
		).toBe("2026-01-05T00:00:00.000Z");
		expect(
			nextAlignedPayoutAt(
				new Date("2026-01-05T00:00:00Z"),
				"weekly",
			).toISOString(),
		).toBe("2026-01-12T00:00:00.000Z");
	});

	test("monthly lots align to the 1st at 00:00 UTC", () => {
		expect(
			nextAlignedPayoutAt(
				new Date("2026-01-31T18:00:00Z"),
				"monthly",
			).toISOString(),
		).toBe("2026-02-01T00:00:00.000Z");
	});
});
