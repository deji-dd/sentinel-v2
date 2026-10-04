import { describe, expect, it } from "bun:test";
import { classifyOpponentsIntoRwBuckets } from "../src/lib/rw-opponent-buckets";
import type { RankedWarOpponent } from "../src/workers/subversive/ranked-war-worker";

const NOW_SEC = 1_800_000_000;

function opponent(
	overrides: Partial<RankedWarOpponent> & { id: number; name: string },
): RankedWarOpponent {
	return {
		level: 75,
		daysInFaction: 100,
		position: "Member",
		isOnWall: false,
		isInOc: false,
		hasEarlyDischarge: false,
		isRevivable: false,
		reviveSetting: "Unknown",
		lastAction: { status: "Offline", timestamp: NOW_SEC - 3600, relative: "" },
		status: {
			description: "",
			details: null,
			state: "Okay",
			color: "green",
			until: null,
		},
		estimatedBs: 1_000_000,
		estimatedScore: 2000,
		...overrides,
	};
}

const inHospital = (untilSec: number, revivable: boolean) =>
	opponent({
		id: 1,
		name: "Down",
		isRevivable: revivable,
		status: {
			description: "In hospital",
			details: null,
			state: "Hospital",
			color: "red",
			until: untilSec,
		},
	});

describe("classifyOpponentsIntoRwBuckets", () => {
	describe("hospital bucket", () => {
		it("includes players in hospital with time remaining", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[inHospital(NOW_SEC + 600, false)],
				NOW_SEC,
			);
			expect(buckets.hospital).toHaveLength(1);
			expect(buckets.hospital[0]?.hospitalUntil).toBe(NOW_SEC + 600);
		});

		it("excludes players whose hospital timer has already elapsed", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[inHospital(NOW_SEC - 60, false)],
				NOW_SEC,
			);
			expect(buckets.hospital).toHaveLength(0);
		});

		it("excludes players reporting Hospital with a null until", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[
					opponent({
						id: 1,
						name: "NullUntil",
						status: {
							description: "",
							details: null,
							state: "Hospital",
							color: "red",
							until: null,
						},
					}),
				],
				NOW_SEC,
			);
			expect(buckets.hospital).toHaveLength(0);
		});

		it("sorts by soonest departure first", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[
					inHospital(NOW_SEC + 1800, false),
					inHospital(NOW_SEC + 300, false),
					inHospital(NOW_SEC + 900, false),
				].map((o, i) => ({ ...o, id: i + 1 })),
				NOW_SEC,
			);
			expect(buckets.hospital.map((l) => l.hospitalUntil)).toEqual([
				NOW_SEC + 300,
				NOW_SEC + 900,
				NOW_SEC + 1800,
			]);
		});
	});

	/**
	 * Regression guard for the semantics that live API testing overturned.
	 * A real 99-member opposing roster returned 40 members with `is_revivable`
	 * set while exactly one was in hospital, and zero overlapped. Treating the
	 * flag alone as "revivable" would have listed 40 healthy players as downed.
	 */
	describe("revivable bucket", () => {
		it("does NOT include healthy players who merely allow revives", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[
					opponent({
						id: 100,
						name: "AllowsRevives",
						isRevivable: true,
						status: {
							description: "",
							details: null,
							state: "Okay",
							color: "green",
							until: null,
						},
					}),
				],
				NOW_SEC,
			);
			expect(buckets.revivable).toHaveLength(0);
		});

		it("includes only players who are both downed and allow revives", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[inHospital(NOW_SEC + 600, true)],
				NOW_SEC,
			);
			expect(buckets.revivable).toHaveLength(1);
			expect(buckets.revivable[0]?.id).toBe(1);
		});

		it("excludes downed players who have revives turned off", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[inHospital(NOW_SEC + 600, false)],
				NOW_SEC,
			);
			expect(buckets.revivable).toHaveLength(0);
			// They still appear in the wider hospital window.
			expect(buckets.hospital).toHaveLength(1);
		});

		it("is a subset of the hospital bucket", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[
					inHospital(NOW_SEC + 120, true),
					inHospital(NOW_SEC + 60, false),
					inHospital(NOW_SEC + 30, true),
				].map((o, i) => ({ ...o, id: i + 1 })),
				NOW_SEC,
			);
			const hospitalIds = new Set(buckets.hospital.map((l) => l.id));
			for (const line of buckets.revivable) {
				expect(hospitalIds.has(line.id)).toBe(true);
			}
			expect(buckets.hospital).toHaveLength(3);
			expect(buckets.revivable).toHaveLength(2);
		});
	});

	describe("online / offline buckets", () => {
		it("splits Okay players by last action status", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[
					opponent({
						id: 1,
						name: "On",
						lastAction: { status: "Online", timestamp: NOW_SEC, relative: "" },
					}),
					opponent({
						id: 2,
						name: "Off",
						lastAction: {
							status: "Offline",
							timestamp: NOW_SEC - 60,
							relative: "",
						},
					}),
				],
				NOW_SEC,
			);
			expect(buckets.onlineOkay.map((l) => l.id)).toEqual([1]);
			expect(buckets.offlineOkay.map((l) => l.id)).toEqual([2]);
		});

		it("excludes Idle players from both buckets", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[
					opponent({
						id: 1,
						name: "Idle",
						lastAction: { status: "Idle", timestamp: NOW_SEC, relative: "" },
					}),
				],
				NOW_SEC,
			);
			expect(buckets.onlineOkay).toHaveLength(0);
			expect(buckets.offlineOkay).toHaveLength(0);
		});

		it("excludes non-Okay states from both buckets", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				["Traveling", "Jail", "Abroad", "Federal", "Fallen"].map((state, i) =>
					opponent({
						id: i + 1,
						name: state,
						lastAction: { status: "Online", timestamp: NOW_SEC, relative: "" },
						status: {
							description: "",
							details: null,
							state,
							color: "grey",
							until: null,
						},
					}),
				),
				NOW_SEC,
			);
			expect(buckets.onlineOkay).toHaveLength(0);
			expect(buckets.offlineOkay).toHaveLength(0);
		});

		it("sorts offline by most recently seen and online by battle stat size", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[
					opponent({
						id: 1,
						name: "OldNews",
						estimatedBs: 9_000_000_000,
						lastAction: {
							status: "Offline",
							timestamp: NOW_SEC - 9999,
							relative: "",
						},
					}),
					opponent({
						id: 2,
						name: "Fresh",
						estimatedBs: 100,
						lastAction: {
							status: "Offline",
							timestamp: NOW_SEC - 10,
							relative: "",
						},
					}),
					opponent({
						id: 3,
						name: "Small",
						estimatedBs: 1_000,
						lastAction: { status: "Online", timestamp: NOW_SEC, relative: "" },
					}),
					opponent({
						id: 4,
						name: "Big",
						estimatedBs: 5_000_000_000,
						lastAction: { status: "Online", timestamp: NOW_SEC, relative: "" },
					}),
				],
				NOW_SEC,
			);
			expect(buckets.offlineOkay.map((l) => l.id)).toEqual([2, 1]);
			expect(buckets.onlineOkay.map((l) => l.id)).toEqual([4, 3]);
		});

		it("excludes Fallen players whose last-seen runs back years", () => {
			const ancient = Math.floor(new Date("2000-01-01").getTime() / 1000);
			const buckets = classifyOpponentsIntoRwBuckets(
				[
					opponent({
						id: 1,
						name: "LongGone",
						isRevivable: true,
						lastAction: { status: "Offline", timestamp: ancient, relative: "" },
						status: {
							description: "",
							details: null,
							state: "Fallen",
							color: "grey",
							until: null,
						},
					}),
				],
				NOW_SEC,
			);
			expect(buckets.offlineOkay).toHaveLength(0);
			expect(buckets.revivable).toHaveLength(0);
		});
	});

	it("returns empty buckets for an empty roster", () => {
		const buckets = classifyOpponentsIntoRwBuckets([], NOW_SEC);
		expect(buckets).toEqual({
			hospital: [],
			offlineOkay: [],
			onlineOkay: [],
			revivable: [],
		});
	});

	it("never mutates the input array", () => {
		const input = [
			opponent({
				id: 1,
				name: "B",
				lastAction: { status: "Offline", timestamp: 1, relative: "" },
			}),
			opponent({
				id: 2,
				name: "A",
				lastAction: { status: "Offline", timestamp: 2, relative: "" },
			}),
		];
		const before = input.map((o) => o.id);
		classifyOpponentsIntoRwBuckets(input, NOW_SEC);
		expect(input.map((o) => o.id)).toEqual(before);
	});
});
