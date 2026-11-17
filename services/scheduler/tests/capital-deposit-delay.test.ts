import { describe, expect, test } from "bun:test";

import {
	CAPITAL_DEPOSIT_ENTRY_DELAY_MS,
	capitalDepositEntryPause,
} from "../src/workers/capital/engine";

const now = new Date("2026-01-01T12:00:00.000Z");

function ago(ms: number): Date {
	return new Date(now.getTime() - ms);
}

describe("capital deposit entry delay", () => {
	test("never pauses when the book has no deposit", () => {
		expect(capitalDepositEntryPause(null, now)).toBeNull();
	});

	test("pauses immediately after a deposit", () => {
		const pause = capitalDepositEntryPause(ago(0), now);
		expect(pause).not.toBeNull();
		expect(pause?.remainingMs).toBe(CAPITAL_DEPOSIT_ENTRY_DELAY_MS);
		expect(pause?.reason).toBe("recent deposit 0s ago (1m delay)");
	});

	test("reports elapsed time, not remaining time, in the reason", () => {
		const pause = capitalDepositEntryPause(ago(45_000), now);
		expect(pause?.elapsedMs).toBe(45_000);
		expect(pause?.remainingMs).toBe(15_000);
		// The bug this guards: the reason used to say "15s ago".
		expect(pause?.reason).toBe("recent deposit 45s ago (1m delay)");
	});

	test("stops pausing once the delay has elapsed", () => {
		expect(capitalDepositEntryPause(ago(59_999), now)).not.toBeNull();
		expect(capitalDepositEntryPause(ago(60_000), now)).toBeNull();
		expect(capitalDepositEntryPause(ago(120_000), now)).toBeNull();
	});

	test("a future-dated deposit is treated as just now", () => {
		const pause = capitalDepositEntryPause(ago(-30_000), now);
		expect(pause?.elapsedMs).toBe(0);
		expect(pause?.remainingMs).toBe(CAPITAL_DEPOSIT_ENTRY_DELAY_MS);
		expect(pause?.reason).toBe("recent deposit 0s ago (1m delay)");
	});
});
