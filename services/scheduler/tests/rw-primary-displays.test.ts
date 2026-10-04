import { beforeEach, describe, expect, it } from "bun:test";
import { emptyRwDisplayBuckets } from "@sentinel/schemas";
import {
	buildBucketSignature,
	clearRwDisplaysBroadcastState,
	hasRwDisplaysBroadcastState,
	resetRwDisplaysBroadcastState,
	shouldBroadcastRwDisplays,
} from "../src/lib/rw-primary-displays";

const FACTION_ID = 2013;
const T0 = 1_800_000_000_000;

function bucketsWith(ids: number[], overrides: Record<string, unknown> = {}) {
	const buckets = emptyRwDisplayBuckets();
	buckets.onlineOkay = ids.map((id) => ({
		id,
		name: `P${id}`,
		estimatedBs: 1_000,
		lastSeenAt: 1_800_000_000,
		hospitalUntil: null,
		...overrides,
	}));
	return buckets;
}

describe("ranked-war primary displays broadcast suppression", () => {
	beforeEach(() => {
		resetRwDisplaysBroadcastState();
	});

	it("always broadcasts the first update for a faction", () => {
		expect(shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0)).toBe(
			true,
		);
	});

	it("suppresses an identical roster inside the minimum interval", () => {
		shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0);
		expect(
			shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0 + 1_000),
		).toBe(false);
	});

	it("suppresses a changed roster until the minimum interval elapses", () => {
		shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0);
		expect(
			shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1, 2]), T0 + 1_000),
		).toBe(false);
	});

	it("broadcasts a changed roster once the minimum interval elapses", () => {
		shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0);
		expect(
			shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1, 2]), T0 + 5_000),
		).toBe(true);
	});

	it("re-broadcasts an unchanged roster at the heartbeat interval", () => {
		shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0);
		expect(
			shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0 + 5_000),
		).toBe(false);
		expect(
			shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0 + 30_000),
		).toBe(true);
	});

	it("treats a reordered roster as changed, since the embeds reorder too", () => {
		const a = bucketsWith([1, 2, 3]);
		const b = bucketsWith([3, 2, 1]);
		expect(buildBucketSignature(a)).not.toBe(buildBucketSignature(b));
	});

	it("treats a changed last-seen or battle stat as a change", () => {
		const base = bucketsWith([1]);
		expect(buildBucketSignature(base)).not.toBe(
			buildBucketSignature(bucketsWith([1], { lastSeenAt: 1_799_000_000 })),
		);
		expect(buildBucketSignature(base)).not.toBe(
			buildBucketSignature(bucketsWith([1], { estimatedBs: 9_000_000 })),
		);
	});

	it("tracks factions independently", () => {
		expect(shouldBroadcastRwDisplays(2013, bucketsWith([1]), T0)).toBe(true);
		expect(shouldBroadcastRwDisplays(27312, bucketsWith([1]), T0)).toBe(true);
	});

	it("forces a broadcast after the faction's state is cleared", () => {
		shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0);
		expect(
			shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0 + 1_000),
		).toBe(false);

		clearRwDisplaysBroadcastState(FACTION_ID);

		// The next war's first push must paint even if the roster is identical.
		expect(
			shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0 + 1_100),
		).toBe(true);
	});

	it("produces distinct signatures per empty category", () => {
		const buckets = emptyRwDisplayBuckets();
		expect(buckets).toEqual({
			hospital: [],
			offlineOkay: [],
			onlineOkay: [],
			revivable: [],
		});
		expect(buildBucketSignature(buckets)).toContain("hospital:0");
		expect(buildBucketSignature(buckets)).toContain("revivable:0");
	});

	/**
	 * The teardown for a finished war is only emitted to a faction that had
	 * rendered something. Without this signal a permanently idle faction would
	 * broadcast a `no_war` teardown on every cycle forever.
	 */
	describe("war-ended teardown eligibility", () => {
		it("reports no prior render for an untouched faction", () => {
			expect(hasRwDisplaysBroadcastState(FACTION_ID)).toBe(false);
		});

		it("reports a prior render once a payload has been broadcast", () => {
			shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0);
			expect(hasRwDisplaysBroadcastState(FACTION_ID)).toBe(true);
		});

		it("clears the prior-render flag after a teardown so it fires only once", () => {
			shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0);
			clearRwDisplaysBroadcastState(FACTION_ID);

			expect(hasRwDisplaysBroadcastState(FACTION_ID)).toBe(false);
			// Subsequent idle cycles must not re-emit a teardown.
			expect(hasRwDisplaysBroadcastState(FACTION_ID)).toBe(false);
		});

		it("re-arms after teardown so the next war paints again", () => {
			shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0);
			clearRwDisplaysBroadcastState(FACTION_ID);

			expect(
				shouldBroadcastRwDisplays(FACTION_ID, bucketsWith([1]), T0 + 100),
			).toBe(true);
		});
	});
});
