import { describe, expect, test } from "bun:test";

import { nextAlignedPayoutAt, nextEligiblePayoutAt } from "../src/capital-time";

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

describe("capital payout minimum accrual", () => {
	test("daily lot skips a boundary less than half a day away", () => {
		// 19:27 -> 4h33m to midnight, so the first payout rolls to the next day.
		expect(
			nextEligiblePayoutAt(
				new Date("2026-11-14T19:27:21Z"),
				"daily",
			).toISOString(),
		).toBe("2026-11-16T00:00:00.000Z");
		// 10:00 -> 14h to midnight, enough to settle at the next boundary.
		expect(
			nextEligiblePayoutAt(
				new Date("2026-11-14T10:00:00Z"),
				"daily",
			).toISOString(),
		).toBe("2026-11-15T00:00:00.000Z");
	});

	test("weekly lot skips a boundary less than half a week away", () => {
		// Sunday 23:00 -> 1h to Monday, so the first payout rolls a full week.
		expect(
			nextEligiblePayoutAt(
				new Date("2026-01-04T23:00:00Z"),
				"weekly",
			).toISOString(),
		).toBe("2026-01-12T00:00:00.000Z");
		// Thursday 12:00 -> exactly 3.5 days to Monday, so it settles then.
		expect(
			nextEligiblePayoutAt(
				new Date("2026-01-01T12:00:00Z"),
				"weekly",
			).toISOString(),
		).toBe("2026-01-05T00:00:00.000Z");
	});

	test("monthly lot skips a boundary less than half a month away", () => {
		// Nov 30 -> 1 day to Dec 1, so the first payout rolls to Jan 1.
		expect(
			nextEligiblePayoutAt(
				new Date("2026-11-30T12:00:00Z"),
				"monthly",
			).toISOString(),
		).toBe("2027-01-01T00:00:00.000Z");
		// Nov 2 -> 29 days to Dec 1, enough to settle on Dec 1.
		expect(
			nextEligiblePayoutAt(
				new Date("2026-11-02T12:00:00Z"),
				"monthly",
			).toISOString(),
		).toBe("2026-12-01T00:00:00.000Z");
		// Jan 31 -> 1 day to Feb 1, so the first payout rolls to Mar 1.
		expect(
			nextEligiblePayoutAt(
				new Date("2026-01-31T12:00:00Z"),
				"monthly",
			).toISOString(),
		).toBe("2026-03-01T00:00:00.000Z");
	});

	test("a backdated lot keeps its next boundary in the future", () => {
		// The deposit is backdated to January, but scheduling happens in November:
		// the minimum is already satisfied, so the next boundary after now wins.
		expect(
			nextEligiblePayoutAt(
				new Date("2026-01-01T00:00:00Z"),
				"monthly",
				new Date("2026-11-20T12:00:00Z"),
			).toISOString(),
		).toBe("2026-12-01T00:00:00.000Z");
	});
});
