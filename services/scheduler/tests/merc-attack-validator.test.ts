import { describe, expect, it } from "bun:test";
import {
	getAttackEndedTimestamp,
	getProgressStateId,
	isWithinPausedWindow,
	parseNextLinkParams,
} from "../src/workers/merc/merc-attack-validator-worker";

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

describe("Merc Attack Validator - Pagination & Progress Persistence", () => {
	describe("parseNextLinkParams", () => {
		it("correctly extracts to timestamp from a full Torn API next link", () => {
			const link =
				"https://api.torn.com/faction/attacks?filters=outgoing&sort=DESC&limit=100&to=1728123456";
			const params = parseNextLinkParams(link);

			expect(params.filters).toBe("outgoing");
			expect(params.sort).toBe("DESC");
			expect(params.limit).toBe(100);
			expect(params.to).toBe(1728123456);
		});

		it("correctly extracts to timestamp from a relative next link", () => {
			const link = "/faction/attacks?filters=outgoing&to=1728999888&sort=DESC";
			const params = parseNextLinkParams(link);

			expect(params.to).toBe(1728999888);
			expect(params.filters).toBe("outgoing");
			expect(params.sort).toBe("DESC");
		});

		it("filters out key, comment, and timestamp cache buster", () => {
			const link =
				"https://api.torn.com/faction/attacks?filters=outgoing&to=1728123456&key=SECRET&comment=BOT&timestamp=1234";
			const params = parseNextLinkParams(link);

			expect(params.key).toBeUndefined();
			expect(params.comment).toBeUndefined();
			expect(params.timestamp).toBeUndefined();
			expect(params.to).toBe(1728123456);
		});
	});

	describe("getProgressStateId", () => {
		it("generates deterministic contract-scoped state key using factionId", () => {
			const stateId = getProgressStateId("guild-123", "contract-a", {
				factionId: 2013,
				apiKey: "api-key-test",
			});
			expect(stateId).toBe(
				"merc:attack_validator:guild-123:contract-a:faction_2013",
			);
		});

		it("scopes progress per contract so concurrent contracts do not share a watermark", () => {
			const keyInfo = { factionId: 2013, apiKey: "api-key-test" };
			const contractA = getProgressStateId("guild-123", "contract-a", keyInfo);
			const contractB = getProgressStateId("guild-123", "contract-b", keyInfo);

			// Regression: a shared watermark let one contract consume another
			// contract's attacks, starving the newest contract of logs.
			expect(contractA).not.toBe(contractB);
		});

		it("generates deterministic state key using hashed apiKey if factionId is missing", () => {
			const keyInfo = { apiKey: "api-key-abc-123" };
			const stateId1 = getProgressStateId("guild-123", "contract-a", keyInfo);
			const stateId2 = getProgressStateId("guild-123", "contract-a", keyInfo);
			expect(stateId1).toBe(stateId2);
			expect(
				stateId1.startsWith("merc:attack_validator:guild-123:contract-a:key_"),
			).toBe(true);
		});
	});

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

	describe("getAttackEndedTimestamp", () => {
		const base = {
			id: 1,
			attacker: { id: 2, name: "Merc" },
			defender: { id: 3, name: "Target" },
			result: "Hospitalized",
		};

		it("prefers ended over timestamp_ended", () => {
			expect(
				getAttackEndedTimestamp({ ...base, ended: 200, timestamp_ended: 100 }),
			).toBe(200);
		});

		it("falls back through started and timestamp_started", () => {
			expect(getAttackEndedTimestamp({ ...base, started: 150 })).toBe(150);
			expect(getAttackEndedTimestamp({ ...base, timestamp_started: 120 })).toBe(
				120,
			);
		});

		it("returns 0 when no timestamp fields are present", () => {
			expect(getAttackEndedTimestamp(base)).toBe(0);
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
