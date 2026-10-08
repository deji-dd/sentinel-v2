import { describe, expect, it } from "bun:test";
import {
	clearStuckBackfillTracking,
	deriveDirection,
	hasReachedWatermark,
	isBackfillCursorStuck,
	nextPageCursor,
	normaliseAttack,
	resolveBackfillWarStart,
	trackBackfillCursor,
} from "../src/workers/merc/faction-attack-feed-worker";
import {
	findStalledFactions,
	isWithinPausedWindow,
} from "../src/workers/merc/merc-attack-validator-worker";
import {
	qualifiesAsRetal,
	RETAL_WINDOW_SECONDS,
	resolveRetalTimestamp,
} from "../src/workers/subversive/retal-tracker";

/**
 * Replicates the start-time gate used by the merc target worker so the
 * "no targets before contract start" rule is covered by a test.
 */
function shouldPopulateTargets(
	contractStartMs: number,
	nowMs: number,
): boolean {
	return nowMs >= contractStartMs;
}

describe("Faction Attack Feed - Ingestion & Watermarks", () => {
	describe("deriveDirection", () => {
		it("classifies an attack on our faction member as incoming", () => {
			expect(
				deriveDirection(
					{
						id: 1,
						attacker: { id: 9, faction: { id: 16312 } },
						defender: { id: 3, faction: { id: 2013 } },
					},
					2013,
				),
			).toBe("incoming");
		});

		it("classifies an attack by one of our members as outgoing", () => {
			expect(
				deriveDirection(
					{
						id: 2,
						attacker: { id: 9, faction: { id: 2013 } },
						defender: { id: 3, faction: { id: 16312 } },
					},
					2013,
				),
			).toBe("outgoing");
		});

		it("returns null when neither side belongs to the tracked faction", () => {
			expect(
				deriveDirection(
					{
						id: 3,
						attacker: { id: 9, faction: { id: 555 } },
						defender: { id: 4, faction: { id: 777 } },
					},
					2013,
				),
			).toBeNull();
		});
	});

	describe("hasReachedWatermark", () => {
		it("treats an attack at or below the watermark as already seen", () => {
			const watermark = {
				lastAttackId: 1000,
				lastAttackTimestamp: 1728123456,
				backfillCursor: null,
				backfilledWarStart: null,
				updatedAt: "",
			};
			expect(hasReachedWatermark(1000, watermark)).toBe(true);
			expect(hasReachedWatermark(999, watermark)).toBe(true);
		});

		it("treats an attack above the watermark as new", () => {
			const watermark = {
				lastAttackId: 1000,
				lastAttackTimestamp: 1728123456,
				backfillCursor: null,
				backfilledWarStart: null,
				updatedAt: "",
			};
			expect(hasReachedWatermark(1001, watermark)).toBe(false);
		});

		it("never stops on a cold start with no watermark", () => {
			expect(hasReachedWatermark(1, null)).toBe(false);
			expect(
				hasReachedWatermark(1, {
					lastAttackId: 0,
					lastAttackTimestamp: 0,
					backfillCursor: null,
					backfilledWarStart: null,
					updatedAt: "",
				}),
			).toBe(false);
		});
	});

	describe("nextPageCursor", () => {
		const stub = (attack: Record<string, number>) =>
			({ ...attack, defender: { id: 1, faction: { id: 2013 } } }) as never;

		it("prefers ended over started for the backfill cursor", () => {
			expect(nextPageCursor(stub({ id: 1, ended: 500, started: 400 }))).toBe(
				500,
			);
		});

		it("falls back to the started timestamp for an in-progress attack", () => {
			expect(nextPageCursor(stub({ id: 1, started: 400 }))).toBe(400);
		});

		it("returns null when the page carries no usable timestamp", () => {
			expect(nextPageCursor(stub({ id: 1 }))).toBeNull();
			expect(nextPageCursor(undefined)).toBeNull();
		});

		// Guards the cursor-advance rule: when a full page ends on the timestamp we
		// queried with, the feed must step the cursor back rather than treat the
		// cycle as "caught up" (which would advance the watermark past unread
		// attacks) or re-request the identical page forever.
		it("reports a non-advancing cursor when a full page shares one timestamp", () => {
			const cursor = 1728000000;
			const pageEndsOnCursor = stub({ id: 99, ended: cursor });
			const next = nextPageCursor(pageEndsOnCursor);
			expect(next).toBe(cursor);
			// The feed relies on this comparison to detect the collision and step
			// the cursor back a second instead of declaring itself caught up.
			expect(next !== null && next >= cursor).toBe(true);
		});
	});

	describe("resolveBackfillWarStart", () => {
		/** 2026-10-08T16:11Z — "now" at the point the incident was diagnosed. */
		const NOW = 1_791_475_866;
		/** Faction 2013's war 50527: declared Oct 6, starting 2026-10-09T13:00Z. */
		const WAR_50527_START = 1_791_550_800;
		/** The watermark value faction 2013 froze on: 2026-10-06T11:55:09Z. */
		const FROZEN_WATERMARK_TS = 1_791_287_709;

		it("ignores a scheduled war, whose start is still in the future", () => {
			expect(
				resolveBackfillWarStart(
					{ warId: 50527, start: WAR_50527_START, opponentFactionId: 10174 },
					NOW,
				),
			).toBeNull();
		});

		it("keeps the start of a war that has actually begun", () => {
			const context = {
				warId: 50527,
				start: WAR_50527_START,
				opponentFactionId: 10174,
			};
			expect(resolveBackfillWarStart(context, WAR_50527_START)).toBe(
				WAR_50527_START,
			);
			expect(resolveBackfillWarStart(context, WAR_50527_START + 3_600)).toBe(
				WAR_50527_START,
			);
		});

		it("returns null with no war, or a war with no start", () => {
			expect(resolveBackfillWarStart(null, NOW)).toBeNull();
			expect(
				resolveBackfillWarStart(
					{ warId: 1, start: null, opponentFactionId: null },
					NOW,
				),
			).toBeNull();
		});

		// The regression this guards: anchoring on a future war start made the
		// backfill precondition trivially true, so the feed pinned `backfillCursor` at
		// the newest watermark timestamp. Every later cycle then re-read that same
		// page, matched the watermark on its first row and returned zero events, so
		// the watermark could never advance and the pin was re-applied forever —
		// faction 2013's ingestion stayed dead for two days and lost every merc hit
		// it landed, including $57M of payable hits on a live contract.
		it("cannot satisfy the backfill precondition with an unstarted war", () => {
			// The raw comparison that used to create the pin, which is unavoidable
			// against a start that has not happened yet.
			expect(FROZEN_WATERMARK_TS < WAR_50527_START).toBe(true);

			// Anchored through the resolver, that comparison can never be reached.
			const anchoredWarStart = resolveBackfillWarStart(
				{ warId: 50527, start: WAR_50527_START, opponentFactionId: 10174 },
				NOW,
			);
			expect(anchoredWarStart).toBeNull();
			expect(
				anchoredWarStart !== null && FROZEN_WATERMARK_TS < anchoredWarStart,
			).toBe(false);
		});
	});

	// The deadlock detector. This is the hard invariant that replaces relying on
	// silence heuristics: a cursor at or past the newest ingested attack cannot make
	// progress no matter how long it is left alone, which was the true state of
	// faction 2013's watermark for two days (cursor 1791287709 == lastAttackTimestamp).
	describe("isBackfillCursorStuck", () => {
		const watermark = (overrides: {
			lastAttackTimestamp: number;
			backfillCursor: number | null;
		}) => ({
			lastAttackId: 521733930,
			lastAttackTimestamp: overrides.lastAttackTimestamp,
			backfillCursor: overrides.backfillCursor,
			backfilledWarStart: null,
			updatedAt: "",
		});

		it("flags a cursor sitting exactly on the newest ingested attack", () => {
			expect(
				isBackfillCursorStuck(
					watermark({
						lastAttackTimestamp: 1_791_287_709,
						backfillCursor: 1_791_287_709,
					}),
				),
			).toBe(true);
		});

		it("flags a cursor ahead of the newest ingested attack", () => {
			expect(
				isBackfillCursorStuck(
					watermark({
						lastAttackTimestamp: 1_791_287_709,
						backfillCursor: 1_791_300_000,
					}),
				),
			).toBe(true);
		});

		it("accepts a cursor walking strictly behind the watermark", () => {
			expect(
				isBackfillCursorStuck(
					watermark({
						lastAttackTimestamp: 1_791_287_709,
						backfillCursor: 1_791_287_709 - 1,
					}),
				),
			).toBe(false);
		});

		it("accepts a cleared cursor and a missing watermark", () => {
			expect(
				isBackfillCursorStuck(
					watermark({
						lastAttackTimestamp: 1_791_287_709,
						backfillCursor: null,
					}),
				),
			).toBe(false);
			expect(isBackfillCursorStuck(null)).toBe(false);
			expect(isBackfillCursorStuck(undefined)).toBe(false);
		});
	});

	describe("trackBackfillCursor", () => {
		const FACTION = 2013;
		type CursorState = {
			lastAttackId: number;
			lastAttackTimestamp: number;
			backfillCursor: number | null;
			backfilledWarStart: number | null;
			updatedAt: string;
		};
		const stuck: CursorState = {
			lastAttackId: 1,
			lastAttackTimestamp: 1_791_287_709,
			backfillCursor: 1_791_287_709,
			backfilledWarStart: null,
			updatedAt: "",
		};
		const healthy: CursorState = { ...stuck, backfillCursor: null };

		const observe = (cycles: number, wm: CursorState | null) => {
			const seen: (string | null)[] = [];
			for (let i = 0; i < cycles; i += 1) {
				seen.push(trackBackfillCursor(FACTION, wm));
			}
			return seen;
		};

		it("waits for consecutive stuck cycles before reporting", () => {
			clearStuckBackfillTracking();
			// A cursor is legitimately re-written mid-drain, so one cycle proves nothing.
			expect(observe(2, stuck)).toEqual([null, null]);
			expect(trackBackfillCursor(FACTION, stuck)).toBe("stuck");
		});

		it("reports a stalled drain only once", () => {
			clearStuckBackfillTracking();
			observe(3, stuck);
			expect(observe(5, stuck)).toEqual([null, null, null, null, null]);
		});

		it("reports recovery when the cursor clears, then re-arms", () => {
			clearStuckBackfillTracking();
			observe(3, stuck);
			expect(trackBackfillCursor(FACTION, healthy)).toBe("recovered");
			expect(trackBackfillCursor(FACTION, healthy)).toBeNull();
			// A later stall is a new outage and must be reported again.
			observe(3, stuck);
			expect(trackBackfillCursor(FACTION, stuck)).toBeNull();
		});

		it("never reports a healthy faction", () => {
			clearStuckBackfillTracking();
			expect(observe(10, healthy)).toEqual(Array(10).fill(null));
		});

		it("counts each faction independently", () => {
			clearStuckBackfillTracking();
			expect(trackBackfillCursor(2013, stuck)).toBeNull();
			expect(trackBackfillCursor(2013, stuck)).toBeNull();
			// 27312 starting its own run must not inherit 2013's count.
			expect(trackBackfillCursor(27312, stuck)).toBeNull();
			expect(trackBackfillCursor(27312, stuck)).toBeNull();
			expect(trackBackfillCursor(2013, stuck)).toBe("stuck");
			expect(trackBackfillCursor(27312, stuck)).toBe("stuck");
		});
	});

	describe("normaliseAttack", () => {
		it("detects the Stricken finishing hit for merc premium pricing", () => {
			const event = normaliseAttack(
				{
					id: 42,
					started: 100,
					ended: 160,
					result: "Hospitalized",
					attacker: { id: 9, name: "Merc", faction: { id: 2013 } },
					defender: { id: 3, name: "Target", faction: { id: 16312 } },
					finishing_hit_effects: [{ name: "stricken", value: 1 }],
				},
				2013,
			);

			expect(event?.isStricken).toBe(true);
			expect(event?.direction).toBe("outgoing");
		});

		it("does not flag Stricken for other finishing effects", () => {
			const event = normaliseAttack(
				{
					id: 43,
					started: 100,
					ended: 160,
					attacker: { id: 9, name: "Merc", faction: { id: 2013 } },
					defender: { id: 3, name: "Target", faction: { id: 16312 } },
					finishing_hit_effects: [{ name: "plunder", value: 23 }],
				},
				2013,
			);

			expect(event?.isStricken).toBe(false);
		});

		it("rejects records with no id or no defender", () => {
			expect(
				normaliseAttack(
					{ id: 0, defender: { id: 3, faction: { id: 2013 } } },
					2013,
				),
			).toBeNull();
			expect(normaliseAttack({ id: 5 } as never, 2013)).toBeNull();
		});
	});
});

describe("Merc Attack Validator - Contract Gating", () => {
	describe("isWithinPausedWindow", () => {
		const pausedAt = "2026-01-01T12:00:00.000Z";
		const resumedAt = "2026-01-01T14:00:00.000Z";

		it("returns false when no windows exist", () => {
			expect(isWithinPausedWindow([], 1767270000)).toBe(false);
			expect(isWithinPausedWindow(undefined, 1767270000)).toBe(false);
			expect(isWithinPausedWindow(null, 1767270000)).toBe(false);
		});

		it("excludes hits landing inside a closed pause window", () => {
			const windows = [{ pausedAt, resumedAt }];
			const midWindow = Math.floor(
				new Date("2026-01-01T13:00:00.000Z").getTime() / 1000,
			);
			expect(isWithinPausedWindow(windows, midWindow)).toBe(true);
		});

		it("includes boundary hits at the start and end of the window", () => {
			const windows = [{ pausedAt, resumedAt }];
			const startSec = Math.floor(new Date(pausedAt).getTime() / 1000);
			const endSec = Math.floor(new Date(resumedAt).getTime() / 1000);
			expect(isWithinPausedWindow(windows, startSec)).toBe(true);
			expect(isWithinPausedWindow(windows, endSec)).toBe(true);
		});

		it("keeps hits that landed before the pause", () => {
			const windows = [{ pausedAt, resumedAt }];
			const beforePause = Math.floor(
				new Date("2026-01-01T11:00:00.000Z").getTime() / 1000,
			);
			expect(isWithinPausedWindow(windows, beforePause)).toBe(false);
		});

		it("keeps hits that landed after the resume", () => {
			const windows = [{ pausedAt, resumedAt }];
			const afterResume = Math.floor(
				new Date("2026-01-01T15:00:00.000Z").getTime() / 1000,
			);
			expect(isWithinPausedWindow(windows, afterResume)).toBe(false);
		});

		it("treats an open window as extending to the present", () => {
			const windows = [{ pausedAt, resumedAt: null }];
			const longAfter = Math.floor(
				new Date("2026-06-01T00:00:00.000Z").getTime() / 1000,
			);
			expect(isWithinPausedWindow(windows, longAfter)).toBe(true);
		});

		it("ignores attacks with no resolvable timestamp", () => {
			const windows = [{ pausedAt, resumedAt: null }];
			expect(isWithinPausedWindow(windows, 0)).toBe(false);
		});

		it("handles multiple sequential pause windows", () => {
			const windows = [
				{
					pausedAt: "2026-01-01T12:00:00.000Z",
					resumedAt: "2026-01-01T13:00:00.000Z",
				},
				{ pausedAt: "2026-01-01T16:00:00.000Z", resumedAt: null },
			];
			const inFirst = Math.floor(
				new Date("2026-01-01T12:30:00.000Z").getTime() / 1000,
			);
			const inSecond = Math.floor(
				new Date("2026-01-01T17:00:00.000Z").getTime() / 1000,
			);
			const betweenWindows = Math.floor(
				new Date("2026-01-01T14:30:00.000Z").getTime() / 1000,
			);
			expect(isWithinPausedWindow(windows, inFirst)).toBe(true);
			expect(isWithinPausedWindow(windows, inSecond)).toBe(true);
			expect(isWithinPausedWindow(windows, betweenWindows)).toBe(false);
		});
	});

	describe("target population start-time gate", () => {
		const startMs = new Date("2026-01-01T12:00:00.000Z").getTime();

		it("does not populate targets before the contract start time", () => {
			// Regression: targets appeared 5 minutes early because startTime was
			// back-dated by the "minutes before war" offset.
			const fiveMinsEarly = startMs - 5 * 60 * 1000;
			expect(shouldPopulateTargets(startMs, fiveMinsEarly)).toBe(false);
		});

		it("does not populate targets one millisecond before start", () => {
			expect(shouldPopulateTargets(startMs, startMs - 1)).toBe(false);
		});

		it("populates targets exactly at the contract start time", () => {
			expect(shouldPopulateTargets(startMs, startMs)).toBe(true);
		});

		it("populates targets after the contract start time", () => {
			expect(shouldPopulateTargets(startMs, startMs + 60_000)).toBe(true);
		});
	});

	describe("resolveRetalTimestamp", () => {
		it("prefers ended over started", () => {
			expect(resolveRetalTimestamp({ endedAt: 200, startedAt: 100 })).toBe(200);
		});

		it("falls back to started while an attack is still in progress", () => {
			expect(resolveRetalTimestamp({ endedAt: null, startedAt: 150 })).toBe(
				150,
			);
		});

		it("returns 0 when neither timestamp is present", () => {
			expect(resolveRetalTimestamp({ endedAt: null, startedAt: null })).toBe(0);
		});
	});

	describe("auto-stop price condition", () => {
		function shouldAutoStop(
			totalPayout: number,
			autoStopPrice?: number | null,
		): boolean {
			if (!autoStopPrice || autoStopPrice <= 0) return false;
			return totalPayout >= autoStopPrice;
		}

		it("does not auto-stop when autoStopPrice is undefined or null", () => {
			expect(shouldAutoStop(10_000_000, undefined)).toBe(false);
			expect(shouldAutoStop(10_000_000, null)).toBe(false);
			expect(shouldAutoStop(10_000_000, 0)).toBe(false);
		});

		it("does not auto-stop when totalPayout is below autoStopPrice", () => {
			expect(shouldAutoStop(9_000_000, 10_000_000)).toBe(false);
		});

		it("auto-stops when totalPayout reaches autoStopPrice exactly", () => {
			expect(shouldAutoStop(10_000_000, 10_000_000)).toBe(true);
		});

		it("auto-stops when totalPayout exceeds autoStopPrice", () => {
			expect(shouldAutoStop(12_000_000, 10_000_000)).toBe(true);
		});
	});

	describe("start-time edit guard on started contracts", () => {
		function isStartTimeEditable(
			contract: { status: string; startTime: string },
			nowMs: number,
		): boolean {
			const hasStarted =
				contract.status === "active" ||
				contract.status === "paused" ||
				contract.status === "completed" ||
				contract.status === "cancelled" ||
				new Date(contract.startTime).getTime() <= nowMs;
			return !hasStarted;
		}

		it("allows editing start time when contract is upcoming and start time is in future", () => {
			const now = Date.now();
			const contract = {
				status: "upcoming",
				startTime: new Date(now + 60_000).toISOString(),
			};
			expect(isStartTimeEditable(contract, now)).toBe(true);
		});

		it("prevents editing start time when contract is active", () => {
			const now = Date.now();
			const contract = {
				status: "active",
				startTime: new Date(now - 60_000).toISOString(),
			};
			expect(isStartTimeEditable(contract, now)).toBe(false);
		});

		it("prevents editing start time when contract status is upcoming but start time has passed", () => {
			const now = Date.now();
			const contract = {
				status: "upcoming",
				startTime: new Date(now - 1_000).toISOString(),
			};
			expect(isStartTimeEditable(contract, now)).toBe(false);
		});

		it("prevents editing start time when contract is paused", () => {
			const now = Date.now();
			const contract = {
				status: "paused",
				startTime: new Date(now - 60_000).toISOString(),
			};
			expect(isStartTimeEditable(contract, now)).toBe(false);
		});
	});
});

describe("Merc Attack Validator - Feed Liveness", () => {
	const MINUTE_MS = 60_000;
	const THRESHOLD_MS = 10 * MINUTE_MS;
	const NOW_MS = 1_791_475_866_000;

	describe("findStalledFactions", () => {
		it("reports a faction silent past the threshold", () => {
			expect(
				findStalledFactions({
					factionIds: [2013, 27312],
					lastEventAtByFaction: new Map([
						[2013, NOW_MS - 11 * MINUTE_MS],
						[27312, NOW_MS - MINUTE_MS],
					]),
					nowMs: NOW_MS,
					thresholdMs: THRESHOLD_MS,
					alreadyWarned: new Set(),
				}),
			).toEqual([{ factionId: 2013, silentSeconds: 660 }]);
		});

		it("stays quiet for a faction that is merely between attacks", () => {
			expect(
				findStalledFactions({
					factionIds: [2013],
					lastEventAtByFaction: new Map([[2013, NOW_MS - 9 * MINUTE_MS]]),
					nowMs: NOW_MS,
					thresholdMs: THRESHOLD_MS,
					alreadyWarned: new Set(),
				}),
			).toEqual([]);
		});

		it("does not repeat a warning for the same outage", () => {
			expect(
				findStalledFactions({
					factionIds: [2013],
					lastEventAtByFaction: new Map([[2013, NOW_MS - 3_600_000]]),
					nowMs: NOW_MS,
					thresholdMs: THRESHOLD_MS,
					alreadyWarned: new Set([2013]),
				}),
			).toEqual([]);
		});

		// The caller seeds a faction the first time it sees it, so that a fresh boot
		// is not reported as silent since the epoch.
		it("ignores a faction that has never been observed", () => {
			expect(
				findStalledFactions({
					factionIds: [2013, 27312],
					lastEventAtByFaction: new Map([[27312, NOW_MS - MINUTE_MS]]),
					nowMs: NOW_MS,
					thresholdMs: THRESHOLD_MS,
					alreadyWarned: new Set(),
				}),
			).toEqual([]);
		});

		it("never reports a faction we do not ingest", () => {
			expect(
				findStalledFactions({
					factionIds: [27312],
					lastEventAtByFaction: new Map([
						[2013, NOW_MS - 3_600_000],
						[27312, NOW_MS - MINUTE_MS],
					]),
					nowMs: NOW_MS,
					thresholdMs: THRESHOLD_MS,
					alreadyWarned: new Set(),
				}),
			).toEqual([]);
		});
	});
});

describe("Retal Tracker - Window & Faction Scoping", () => {
	const NOW = 1_800_000_000;

	const incomingHit = (overrides: Record<string, unknown> = {}) => ({
		direction: "incoming",
		defenderFactionId: 2013,
		attackerId: 555,
		endedAt: NOW,
		startedAt: NOW - 30,
		...overrides,
	});

	describe("qualifiesAsRetal", () => {
		it("accepts an incoming hit on our faction inside the window", () => {
			expect(qualifiesAsRetal(incomingHit(), 2013, NOW)).toBe(true);
		});

		it("rejects an attack exactly 300s old because the window is strict", () => {
			expect(
				qualifiesAsRetal(
					incomingHit({ endedAt: NOW - RETAL_WINDOW_SECONDS }),
					2013,
					NOW,
				),
			).toBe(false);
		});

		it("accepts an attack 299s old", () => {
			expect(
				qualifiesAsRetal(
					incomingHit({ endedAt: NOW - (RETAL_WINDOW_SECONDS - 1) }),
					2013,
					NOW,
				),
			).toBe(true);
		});

		it("rejects an attack older than the window", () => {
			expect(
				qualifiesAsRetal(
					incomingHit({ endedAt: NOW - RETAL_WINDOW_SECONDS - 60 }),
					2013,
					NOW,
				),
			).toBe(false);
		});

		it("never qualifies our own outgoing attacks", () => {
			expect(
				qualifiesAsRetal(incomingHit({ direction: "outgoing" }), 2013, NOW),
			).toBe(false);
		});

		it("is faction scoped: a hit on the other family faction does not apply", () => {
			expect(
				qualifiesAsRetal(incomingHit({ defenderFactionId: 27312 }), 2013, NOW),
			).toBe(false);
		});

		it("rejects attacks with no resolvable attacker", () => {
			expect(
				qualifiesAsRetal(incomingHit({ attackerId: null }), 2013, NOW),
			).toBe(false);
			expect(qualifiesAsRetal(incomingHit({ attackerId: 0 }), 2013, NOW)).toBe(
				false,
			);
		});

		it("treats an in-progress attack as a live retal", () => {
			expect(
				qualifiesAsRetal(
					incomingHit({ endedAt: null, startedAt: NOW - 10 }),
					2013,
					NOW,
				),
			).toBe(true);
		});

		it("rejects attacks with no usable timestamp", () => {
			expect(
				qualifiesAsRetal(
					incomingHit({ endedAt: null, startedAt: null }),
					2013,
					NOW,
				),
			).toBe(false);
		});
	});
});
