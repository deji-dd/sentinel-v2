import { beforeEach, describe, expect, it } from "bun:test";
import type { RwTravelingBuckets } from "@sentinel/schemas";
import {
	clearRwTravelingBroadcastState,
	hasRwTravelingBroadcastState,
	resetRwTravelingBroadcastState,
	shouldBroadcastRwTraveling,
	TRAVEL_BROADCAST_HEARTBEAT_MS,
	TRAVEL_BROADCAST_MIN_INTERVAL_MS,
} from "../src/lib/rw-traveling-displays";

const FACTION_ID = 2013;
const OTHER_FACTION_ID = 27312;
const T0 = 1_800_000_000_000;

/** Compact fixture form: destination plus the ids flying to it. */
type BucketSpec = [destination: string, ids: number[]];

function buckets(...entries: BucketSpec[]): RwTravelingBuckets {
	return entries.map(([destination, ids]) => ({
		destination: destination as RwTravelingBuckets[number]["destination"],
		players: ids.map((id) => ({
			id,
			name: `P${id}`,
			estimatedBs: 1_000,
			lastSeenAt: 1_800_000_000,
			hospitalUntil: null,
			kind: "traveling" as const,
		})),
	}));
}

describe("ranked-war travel display broadcast suppression", () => {
	beforeEach(() => {
		resetRwTravelingBroadcastState();
	});

	it("always broadcasts the first update for a faction", () => {
		expect(shouldBroadcastRwTraveling(FACTION_ID, buckets(), T0)).toBe(true);
	});

	it("suppresses an identical roster inside the minimum interval", () => {
		const roster = buckets(["Japan", [1]]);
		shouldBroadcastRwTraveling(FACTION_ID, roster, T0);
		expect(shouldBroadcastRwTraveling(FACTION_ID, roster, T0 + 1_000)).toBe(
			false,
		);
	});

	it("suppresses a changed roster until the minimum interval elapses", () => {
		shouldBroadcastRwTraveling(FACTION_ID, buckets(["Japan", [1]]), T0);
		expect(
			shouldBroadcastRwTraveling(
				FACTION_ID,
				buckets(["Japan", [1]], ["Torn", [2]]),
				T0 + 1_000,
			),
		).toBe(false);
	});

	it("broadcasts a changed roster once the minimum interval elapses", () => {
		shouldBroadcastRwTraveling(FACTION_ID, buckets(["Japan", [1]]), T0);
		expect(
			shouldBroadcastRwTraveling(
				FACTION_ID,
				buckets(["Japan", [1]], ["Torn", [2]]),
				T0 + TRAVEL_BROADCAST_MIN_INTERVAL_MS,
			),
		).toBe(true);
	});

	it("re-broadcasts an unchanged roster at the heartbeat interval", () => {
		const roster = buckets(["Japan", [1]]);
		shouldBroadcastRwTraveling(FACTION_ID, roster, T0);
		expect(
			shouldBroadcastRwTraveling(
				FACTION_ID,
				roster,
				T0 + TRAVEL_BROADCAST_MIN_INTERVAL_MS,
			),
		).toBe(false);
		expect(
			shouldBroadcastRwTraveling(
				FACTION_ID,
				roster,
				T0 + TRAVEL_BROADCAST_HEARTBEAT_MS,
			),
		).toBe(true);
	});

	it("broadcasts a departure that leaves the roster otherwise identical", () => {
		shouldBroadcastRwTraveling(
			FACTION_ID,
			buckets(["Japan", [1]], ["Torn", [2]]),
			T0,
		);
		// The player arriving home lands, so Torn empties out.
		expect(
			shouldBroadcastRwTraveling(
				FACTION_ID,
				buckets(["Japan", [1]]),
				T0 + TRAVEL_BROADCAST_MIN_INTERVAL_MS,
			),
		).toBe(true);
	});

	/**
	 * The whole reason travel suppression is kept separate from the primary
	 * display suppression. Travelers populate none of the four primary buckets,
	 * so folding both payloads into one signature would make a flight departure
	 * look identical to the previous cycle and go unsent.
	 */
	it("is independent of the primary display suppression state", () => {
		expect(
			shouldBroadcastRwTraveling(FACTION_ID, buckets(["Japan", [1]]), T0),
		).toBe(true);
		// Primary state is untouched and unaware; travel throttles on its own.
		expect(hasRwTravelingBroadcastState(FACTION_ID)).toBe(true);
		expect(hasRwTravelingBroadcastState(OTHER_FACTION_ID)).toBe(false);
	});

	it("tracks factions independently", () => {
		expect(
			shouldBroadcastRwTraveling(FACTION_ID, buckets(["Japan", [1]]), T0),
		).toBe(true);
		expect(
			shouldBroadcastRwTraveling(OTHER_FACTION_ID, buckets(["Japan", [1]]), T0),
		).toBe(true);
	});

	it("forces a broadcast after the faction's state is cleared", () => {
		const roster = buckets(["Japan", [1]]);
		shouldBroadcastRwTraveling(FACTION_ID, roster, T0);
		expect(shouldBroadcastRwTraveling(FACTION_ID, roster, T0 + 100)).toBe(
			false,
		);

		clearRwTravelingBroadcastState(FACTION_ID);

		// The next war's first push must paint even if the roster is identical.
		expect(shouldBroadcastRwTraveling(FACTION_ID, roster, T0 + 200)).toBe(true);
	});

	describe("war-ended teardown eligibility", () => {
		it("reports no prior render for an untouched faction", () => {
			expect(hasRwTravelingBroadcastState(FACTION_ID)).toBe(false);
		});

		it("reports a prior render once a payload has been broadcast", () => {
			shouldBroadcastRwTraveling(FACTION_ID, buckets(["Japan", [1]]), T0);
			expect(hasRwTravelingBroadcastState(FACTION_ID)).toBe(true);
		});

		it("clears the prior-render flag after a teardown so it fires only once", () => {
			shouldBroadcastRwTraveling(FACTION_ID, buckets(["Japan", [1]]), T0);
			clearRwTravelingBroadcastState(FACTION_ID);
			expect(hasRwTravelingBroadcastState(FACTION_ID)).toBe(false);
			expect(hasRwTravelingBroadcastState(FACTION_ID)).toBe(false);
		});
	});
});
