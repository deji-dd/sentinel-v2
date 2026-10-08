import { describe, expect, it } from "bun:test";
import {
	classifyFriendlyRevivables,
	type FriendlyRosterMember,
	isFriendlyRevivable,
} from "../src/lib/rw-friendly-buckets";

/**
 * The friendly revive board lists our *own* members who allow revives.
 *
 * The rule that matters most here is the one verified against the live Torn API
 * for the sibling opponent bucket: `is_revivable` is a standing permission flag,
 * not a live "is down right now" state. Requiring a Hospital status on top of it
 * empties the board whenever nobody happens to be down, which reads as a broken
 * embed rather than as a quiet moment.
 */

function member(
	overrides: Partial<FriendlyRosterMember> & { id: number },
): FriendlyRosterMember {
	return {
		name: `Member${overrides.id}`,
		isRevivable: false,
		reviveSetting: "Unknown",
		lastAction: { timestamp: 1_800_000_000 },
		status: { state: "Okay", until: null },
		...overrides,
	};
}

const NOW = 1_800_000_000;

describe("isFriendlyRevivable", () => {
	it("includes a member whose standing flag allows revives", () => {
		expect(
			isFriendlyRevivable(
				member({ id: 1, isRevivable: true, reviveSetting: "Everyone" }),
			),
		).toBe(true);
	});

	it("includes a member who is okay, so an idle board is not empty", () => {
		expect(
			isFriendlyRevivable(
				member({
					id: 2,
					isRevivable: true,
					reviveSetting: "Everyone",
					status: { state: "Okay", until: null },
				}),
			),
		).toBe(true);
	});

	it("excludes a member who opted out even if the flag looks stale", () => {
		expect(
			isFriendlyRevivable(
				member({ id: 3, isRevivable: true, reviveSetting: "No one" }),
			),
		).toBe(false);
	});

	it("excludes a member with revives off", () => {
		expect(
			isFriendlyRevivable(
				member({ id: 4, isRevivable: false, reviveSetting: "No one" }),
			),
		).toBe(false);
	});

	it("excludes a fallen account even when flagged", () => {
		expect(
			isFriendlyRevivable(
				member({
					id: 5,
					isRevivable: true,
					reviveSetting: "Everyone",
					status: { state: "Fallen", until: null },
				}),
			),
		).toBe(false);
	});

	/**
	 * The key pool round-robins across both family factions, and Torn only
	 * populates `revive_setting` for the key's own faction. A sibling-faction
	 * key therefore reports "Unknown" for the whole roster, where the flag is
	 * the only usable signal.
	 */
	it("falls back to the flag when the key reports an unknown setting", () => {
		expect(
			isFriendlyRevivable(
				member({ id: 6, isRevivable: true, reviveSetting: "Unknown" }),
			),
		).toBe(true);
		expect(
			isFriendlyRevivable(
				member({ id: 7, isRevivable: false, reviveSetting: "Unknown" }),
			),
		).toBe(false);
	});

	it("trusts an allow-list setting the flag has not caught up with", () => {
		expect(
			isFriendlyRevivable(
				member({
					id: 8,
					isRevivable: false,
					reviveSetting: "Friends & faction",
				}),
			),
		).toBe(true);
	});
});

describe("classifyFriendlyRevivables", () => {
	it("drops everyone who cannot be revived", () => {
		const lines = classifyFriendlyRevivables(
			[
				member({ id: 1, isRevivable: true, reviveSetting: "Everyone" }),
				member({ id: 2, isRevivable: false, reviveSetting: "No one" }),
				member({
					id: 3,
					isRevivable: true,
					reviveSetting: "Everyone",
					status: { state: "Fallen", until: null },
				}),
			],
			NOW,
		);

		expect(lines.map((l) => l.id)).toEqual([1]);
	});

	it("puts downed members first, soonest hospital exit leading", () => {
		const lines = classifyFriendlyRevivables(
			[
				member({ id: 1, isRevivable: true, reviveSetting: "Everyone" }),
				member({
					id: 2,
					isRevivable: true,
					reviveSetting: "Everyone",
					status: { state: "Hospital", until: NOW + 3_600 },
				}),
				member({
					id: 3,
					isRevivable: true,
					reviveSetting: "Everyone",
					status: { state: "Hospital", until: NOW + 600 },
				}),
			],
			NOW,
		);

		expect(lines.map((l) => l.id)).toEqual([3, 2, 1]);
	});

	it("orders the rest most recently active first", () => {
		const lines = classifyFriendlyRevivables(
			[
				member({
					id: 1,
					isRevivable: true,
					reviveSetting: "Everyone",
					lastAction: { timestamp: 1_700_000_000 },
				}),
				member({
					id: 2,
					isRevivable: true,
					reviveSetting: "Everyone",
					lastAction: { timestamp: 1_799_000_000 },
				}),
			],
			NOW,
		);

		expect(lines.map((l) => l.id)).toEqual([2, 1]);
	});

	it("breaks ties on name so the order is stable", () => {
		const lines = classifyFriendlyRevivables(
			[
				member({
					id: 1,
					name: "Zed",
					isRevivable: true,
					reviveSetting: "Everyone",
					lastAction: { timestamp: 1_800_000_000 },
				}),
				member({
					id: 2,
					name: "Abe",
					isRevivable: true,
					reviveSetting: "Everyone",
					lastAction: { timestamp: 1_800_000_000 },
				}),
			],
			NOW,
		);

		expect(lines.map((l) => l.name)).toEqual(["Abe", "Zed"]);
	});

	it("carries the hospital timer only for hospitalised members", () => {
		const lines = classifyFriendlyRevivables(
			[
				member({
					id: 1,
					isRevivable: true,
					reviveSetting: "Everyone",
					status: { state: "Hospital", until: NOW + 120 },
				}),
				// Torn keeps `until` populated for Jail too; only the Hospital state
				// makes it a revive window.
				member({
					id: 2,
					isRevivable: true,
					reviveSetting: "Everyone",
					status: { state: "Jail", until: NOW + 120 },
				}),
			],
			NOW,
		);

		expect(lines[0]?.hospitalUntil).toBe(NOW + 120);
		expect(lines[1]?.hospitalUntil).toBeNull();
	});

	/**
	 * Torn keeps reporting the Hospital state for a moment after `until` has
	 * elapsed. Treating that as downed would send a reviver to a bed the member
	 * has already left.
	 */
	it("clears a hospital timer that has already elapsed", () => {
		const lines = classifyFriendlyRevivables(
			[
				member({
					id: 1,
					isRevivable: true,
					reviveSetting: "Everyone",
					status: { state: "Hospital", until: NOW - 30 },
				}),
			],
			NOW,
		);

		expect(lines[0]?.hospitalUntil).toBeNull();
	});

	it("orders an elapsed-timer member as up rather than downed", () => {
		const lines = classifyFriendlyRevivables(
			[
				member({
					id: 1,
					isRevivable: true,
					reviveSetting: "Everyone",
					status: { state: "Hospital", until: NOW - 30 },
				}),
				member({
					id: 2,
					isRevivable: true,
					reviveSetting: "Everyone",
					status: { state: "Hospital", until: NOW + 300 },
				}),
			],
			NOW,
		);

		expect(lines.map((l) => l.id)).toEqual([2, 1]);
	});

	it("reports an unknown last-seen as zero rather than a bogus time", () => {
		const lines = classifyFriendlyRevivables(
			[
				member({
					id: 1,
					isRevivable: true,
					reviveSetting: "Everyone",
					lastAction: {},
				}),
			],
			NOW,
		);

		expect(lines[0]?.lastSeenAt).toBe(0);
	});

	it("returns an empty list when nobody allows revives", () => {
		expect(
			classifyFriendlyRevivables(
				[
					member({ id: 1, reviveSetting: "No one" }),
					member({ id: 2, reviveSetting: "No one" }),
				],
				NOW,
			),
		).toEqual([]);
	});
});
