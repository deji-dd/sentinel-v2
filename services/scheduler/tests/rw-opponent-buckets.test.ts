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

		it("excludes a stay in a hospital abroad", () => {
			// Torn reports an overseas hospitalisation with the same Hospital state
			// and a live timer; only the description names the foreign hospital. A
			// member cannot attack that opponent without flying, so it must not be
			// advertised as a departure target.
			const buckets = classifyOpponentsIntoRwBuckets(
				[
					opponent({
						id: 1,
						name: "Overseas",
						status: {
							description: "In a Japanese hospital for 24 mins",
							details: null,
							state: "Hospital",
							color: "red",
							until: NOW_SEC + 600,
						},
					}),
				],
				NOW_SEC,
			);

			expect(buckets.hospital).toHaveLength(0);
		});

		it("keeps an overseas-hospital opponent on the revivable list", () => {
			// The revivable list is a permission list, not a target list: it names
			// opponents who allow revives whether they are down, okay or abroad, and
			// a reviver can travel to them. Only the hospital bucket is reachability
			// filtered, so this stays a deliberate asymmetry.
			const buckets = classifyOpponentsIntoRwBuckets(
				[
					opponent({
						id: 1,
						name: "Overseas",
						isRevivable: true,
						status: {
							description: "In a Japanese hospital for 24 mins",
							details: null,
							state: "Hospital",
							color: "red",
							until: NOW_SEC + 600,
						},
					}),
				],
				NOW_SEC,
			);

			expect(buckets.hospital).toHaveLength(0);
			expect(buckets.revivable.map((line) => line.id)).toEqual([1]);
			expect(buckets.revivable[0]?.hospitalUntil).toBe(NOW_SEC + 600);
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
	 * `is_revivable` is Torn's standing "this member allows revives" permission
	 * flag, verified live against the key's own faction: it is true for exactly
	 * the members whose `revive_setting` is "Everyone" or "Friends & faction",
	 * and false for every "No one" member. The bucket mirrors the flag alone so
	 * the embed's count agrees with what the API reports for the same roster.
	 */
	describe("revivable bucket", () => {
		it("includes healthy players who allow revives", () => {
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
			expect(buckets.revivable).toHaveLength(1);
			expect(buckets.revivable[0]?.id).toBe(100);
			// Healthy players still belong to their own status bucket too.
			expect(buckets.offlineOkay).toHaveLength(1);
		});

		it("includes downed players who allow revives", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[inHospital(NOW_SEC + 600, true)],
				NOW_SEC,
			);
			expect(buckets.revivable).toHaveLength(1);
			expect(buckets.revivable[0]?.id).toBe(1);
		});

		it("includes flagged players in states outside hospital and okay", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				["Traveling", "Abroad", "Federal", "Jail"].map((state, i) =>
					opponent({
						id: i + 1,
						name: state,
						isRevivable: true,
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
			expect(buckets.revivable).toHaveLength(4);
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

		it("excludes healthy players who have revives turned off", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[opponent({ id: 7, name: "NoRevives", isRevivable: false })],
				NOW_SEC,
			);
			expect(buckets.revivable).toHaveLength(0);
		});

		it("orders downed players first by soonest exit, then the rest by last seen", () => {
			const buckets = classifyOpponentsIntoRwBuckets(
				[
					opponent({
						id: 1,
						name: "StaleHealthy",
						isRevivable: true,
						lastAction: {
							status: "Offline",
							timestamp: NOW_SEC - 9000,
							relative: "",
						},
					}),
					opponent({
						id: 2,
						name: "FreshHealthy",
						isRevivable: true,
						lastAction: {
							status: "Offline",
							timestamp: NOW_SEC - 30,
							relative: "",
						},
					}),
					{ ...inHospital(NOW_SEC + 1800, true), id: 3, name: "DownLater" },
					{ ...inHospital(NOW_SEC + 120, true), id: 4, name: "DownSooner" },
				],
				NOW_SEC,
			);
			expect(buckets.revivable.map((l) => l.id)).toEqual([4, 3, 2, 1]);
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
