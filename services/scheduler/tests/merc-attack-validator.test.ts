import { describe, expect, it } from "bun:test";
import {
	deriveDirection,
	hasReachedWatermark,
	nextPageCursor,
	normaliseAttack,
} from "../src/workers/merc/faction-attack-feed-worker";
import { isWithinPausedWindow } from "../src/workers/merc/merc-attack-validator-worker";
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
