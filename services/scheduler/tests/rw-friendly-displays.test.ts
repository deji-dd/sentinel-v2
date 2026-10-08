import { beforeEach, describe, expect, it } from "bun:test";
import type { RwFriendlyLine } from "@sentinel/schemas";
import {
	buildFriendlySignature,
	clearRwFriendlyBroadcastState,
	hasRwFriendlyBroadcastState,
	resetRwFriendlyBroadcastState,
	shouldBroadcastRwFriendly,
} from "../src/lib/rw-friendly-displays";

/**
 * Broadcast suppression for the friendly revive board.
 *
 * The board has its own state on purpose: the scheduler pushes the three
 * ranked-war displays independently, and a teammate falling into hospital moves
 * nothing on the opponent board. Sharing a signature map would let that change
 * be suppressed as "unchanged".
 */

const FACTION_ID = 2013;
const T0 = 1_800_000_000_000;

function line(
	id: number,
	overrides: Partial<RwFriendlyLine> = {},
): RwFriendlyLine {
	return {
		id,
		name: `M${id}`,
		lastSeenAt: 1_800_000_000,
		hospitalUntil: null,
		...overrides,
	};
}

describe("ranked-war friendly display broadcast suppression", () => {
	beforeEach(() => {
		resetRwFriendlyBroadcastState();
	});

	it("always broadcasts the first update for a faction", () => {
		expect(shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0)).toBe(true);
	});

	it("suppresses an identical roster inside the minimum interval", () => {
		shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0);
		expect(shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0 + 1_000)).toBe(
			false,
		);
	});

	it("pushes a changed roster once the interval has elapsed", () => {
		shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0);
		expect(
			shouldBroadcastRwFriendly(FACTION_ID, [line(1), line(2)], T0 + 6_000),
		).toBe(true);
	});

	it("ignores a change that arrives before the interval elapses", () => {
		shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0);
		expect(
			shouldBroadcastRwFriendly(FACTION_ID, [line(1), line(2)], T0 + 1_000),
		).toBe(false);
	});

	it("re-sends an unchanged roster on the heartbeat", () => {
		shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0);
		expect(shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0 + 31_000)).toBe(
			true,
		);
	});

	it("treats a reordered roster as a change worth repainting", () => {
		shouldBroadcastRwFriendly(FACTION_ID, [line(1), line(2)], T0);
		expect(
			shouldBroadcastRwFriendly(FACTION_ID, [line(2), line(1)], T0 + 6_000),
		).toBe(true);
	});

	it("repaints when a member's hospital timer moves", () => {
		const before = [line(1, { hospitalUntil: 1_800_000_600 })];
		const after = [line(1, { hospitalUntil: 1_800_000_900 })];
		shouldBroadcastRwFriendly(FACTION_ID, before, T0);
		expect(shouldBroadcastRwFriendly(FACTION_ID, after, T0 + 6_000)).toBe(true);
	});

	it("repaints when a member becomes downed", () => {
		shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0);
		expect(
			shouldBroadcastRwFriendly(
				FACTION_ID,
				[line(1, { hospitalUntil: 1_800_000_600 })],
				T0 + 6_000,
			),
		).toBe(true);
	});

	it("repaints when a member's last-seen moves", () => {
		shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0);
		expect(
			shouldBroadcastRwFriendly(
				FACTION_ID,
				[line(1, { lastSeenAt: 1_800_000_500 })],
				T0 + 6_000,
			),
		).toBe(true);
	});

	it("tracks suppression per faction", () => {
		shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0);
		expect(shouldBroadcastRwFriendly(FACTION_ID + 1, [line(1)], T0)).toBe(true);
	});

	it("builds a signature that covers every rendered field", () => {
		expect(buildFriendlySignature([line(1, { hospitalUntil: 42 })])).toBe(
			"1.1800000000.42",
		);
		expect(buildFriendlySignature([])).toBe("");
	});

	describe("teardown gating", () => {
		it("reports no state before the first push", () => {
			expect(hasRwFriendlyBroadcastState(FACTION_ID)).toBe(false);
		});

		it("reports state once something has been pushed", () => {
			shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0);
			expect(hasRwFriendlyBroadcastState(FACTION_ID)).toBe(true);
		});

		it("forgets a faction after its teardown, so the next war pushes immediately", () => {
			shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0);
			clearRwFriendlyBroadcastState(FACTION_ID);

			expect(hasRwFriendlyBroadcastState(FACTION_ID)).toBe(false);
			expect(shouldBroadcastRwFriendly(FACTION_ID, [line(1)], T0 + 1_000)).toBe(
				true,
			);
		});
	});
});
