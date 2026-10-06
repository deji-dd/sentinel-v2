import { describe, expect, test } from "bun:test";
import {
	buildUserStockAlertConditionKey,
	createEmptyUserStockAlertState,
	type UserStockAlertCondition,
	type UserStockAlertState,
	type UserStockAlertSubscription,
} from "@sentinel/schemas";
import type { StockAlertSnapshot } from "../src/workers/subversive/stock-alert-rules";
import {
	evaluateUserStockAlert,
	normaliseUserStockAlertState,
} from "../src/workers/subversive/user-stock-alert-rules";

/**
 * Pure coverage for personal stock alerts.
 *
 * The cases that matter are the ones a user would notice: being DM'd the instant
 * they subscribe, being DM'd repeatedly while a condition simply stays true, and
 * being DM'd about a high that was already announced.
 */

const NOW_MS = 1_800_000_000_000;

function subscription(
	patch: Partial<UserStockAlertSubscription> = {},
): UserStockAlertSubscription {
	const base: UserStockAlertSubscription = {
		id: "sub-1",
		guildId: "111111111111111111",
		discordUserId: "555555555555555555",
		stockId: 1,
		condition: "price_above",
		range: null,
		threshold: 1200,
		conditionKey: "",
		enabled: true,
		state: createEmptyUserStockAlertState(),
	};

	const merged = { ...base, ...patch };
	return {
		...merged,
		conditionKey:
			merged.conditionKey ||
			buildUserStockAlertConditionKey({
				stockId: merged.stockId,
				condition: merged.condition,
				range: merged.range,
				threshold: merged.threshold,
			}),
	};
}

function snapshot(patch: Partial<StockAlertSnapshot> = {}): StockAlertSnapshot {
	return {
		stockId: 1,
		name: "Torn & Shanghai Banking",
		acronym: "TSB",
		price: 1000,
		performance: {
			"1h": { changePct: 0, start: 1000, high: 1005, low: 995 },
			"24h": { changePct: 0, start: 1000, high: 1010, low: 990 },
			"7d": { changePct: 5, start: 950, high: 1060, low: 900 },
			"30d": { changePct: 12, start: 890, high: 1100, low: 850 },
			"1y": { changePct: 40, start: 700, high: 1300, low: 600 },
			all_time: { changePct: 90, start: 500, high: 1500, low: 400 },
		},
		history: [],
		...patch,
	};
}

/** A seeded state, so the next evaluation is a real one rather than a baseline. */
function seeded(patch: Partial<UserStockAlertState> = {}): UserStockAlertState {
	return { ...createEmptyUserStockAlertState(), seeded: true, ...patch };
}

describe("Personal stock alert rules", () => {
	describe("seeding", () => {
		test("records the baseline and stays quiet on the first evaluation", () => {
			// The price is already above the threshold: subscribing must not fire.
			const { event, nextState } = evaluateUserStockAlert({
				snapshot: snapshot({ price: 1500 }),
				subscription: subscription({ threshold: 1200 }),
				state: null,
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
			expect(nextState.seeded).toBe(true);
			expect(nextState.wasTrue).toBe(true);
		});

		test("seeds a new-high subscription with the extreme Torn reports", () => {
			const { event, nextState } = evaluateUserStockAlert({
				snapshot: snapshot(),
				subscription: subscription({ condition: "new_high", range: "7d" }),
				state: null,
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
			expect(nextState.seeded).toBe(true);
			expect(nextState.lastExtreme).toBe(1060);
		});
	});

	describe("price comparisons", () => {
		const condition: UserStockAlertCondition = "price_above";

		test("fires on the crossing, not while the condition holds", () => {
			const first = evaluateUserStockAlert({
				snapshot: snapshot({ price: 1250 }),
				subscription: subscription({ condition, threshold: 1200 }),
				state: seeded({ wasTrue: false }),
				nowMs: NOW_MS,
			});

			expect(first.event).not.toBeNull();
			expect(first.event?.description).toContain("rose above");
			// A price alert has no range of its own, so it opens the daily chart.
			expect(first.event?.event.range).toBeUndefined();
			expect(first.nextState.wasTrue).toBe(true);

			// Still above on the next cycle: already announced, so nothing is sent.
			const second = evaluateUserStockAlert({
				snapshot: snapshot({ price: 1300 }),
				subscription: subscription({ condition, threshold: 1200 }),
				state: first.nextState,
				nowMs: NOW_MS + 5 * 60_000,
			});

			expect(second.event).toBeNull();
		});

		test("re-arms once the price falls back below the threshold", () => {
			const armed = evaluateUserStockAlert({
				snapshot: snapshot({ price: 1100 }),
				subscription: subscription({ condition, threshold: 1200 }),
				state: seeded({ wasTrue: true }),
				nowMs: NOW_MS,
			});
			expect(armed.event).toBeNull();
			expect(armed.nextState.wasTrue).toBe(false);

			const fired = evaluateUserStockAlert({
				snapshot: snapshot({ price: 1250 }),
				subscription: subscription({ condition, threshold: 1200 }),
				state: armed.nextState,
				nowMs: NOW_MS + 5 * 60_000,
			});
			expect(fired.event).not.toBeNull();
		});

		test("a price below alert fires on the downward crossing", () => {
			const { event } = evaluateUserStockAlert({
				snapshot: snapshot({ price: 900 }),
				subscription: subscription({
					condition: "price_below",
					threshold: 950,
				}),
				state: seeded({ wasTrue: false }),
				nowMs: NOW_MS,
			});

			expect(event).not.toBeNull();
			expect(event?.description).toContain("fell below");
		});
	});

	describe("percentage changes", () => {
		test("a weekly rise of 5% satisfies a 4% rule", () => {
			const { event } = evaluateUserStockAlert({
				snapshot: snapshot(),
				subscription: subscription({
					condition: "change_up",
					range: "7d",
					threshold: 4,
				}),
				state: seeded({ wasTrue: false }),
				nowMs: NOW_MS,
			});

			expect(event).not.toBeNull();
			expect(event?.description).toContain("5.00%");
			expect(event?.event.windowLabel).toBe("7 days");
			expect(event?.event.range).toBe("7d");
		});

		test("a 4% rule is not satisfied by a 5% rise when it asked for 8%", () => {
			const { event } = evaluateUserStockAlert({
				snapshot: snapshot(),
				subscription: subscription({
					condition: "change_up",
					range: "7d",
					threshold: 8,
				}),
				state: seeded({ wasTrue: false }),
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
		});

		test("a fall is measured against the magnitude of the threshold", () => {
			const falling = snapshot({
				performance: {
					"24h": { changePct: -12, start: 1140, high: 1150, low: 990 },
				},
			});

			const { event } = evaluateUserStockAlert({
				snapshot: falling,
				subscription: subscription({
					condition: "change_down",
					range: "24h",
					threshold: 10,
				}),
				state: seeded({ wasTrue: false }),
				nowMs: NOW_MS,
			});

			expect(event).not.toBeNull();
			expect(event?.event.changePct).toBe(-12);
			expect(event?.event.thresholdPct).toBe(10);
		});

		test("a missing range figure is not treated as a crossing", () => {
			const { event, nextState } = evaluateUserStockAlert({
				snapshot: snapshot({ performance: {} }),
				subscription: subscription({
					condition: "change_up",
					range: "30d",
					threshold: 5,
				}),
				state: seeded({ wasTrue: false }),
				nowMs: NOW_MS,
			});

			// No figure to judge with: the edge memory is left alone so the next
			// cycle re-evaluates from the same state.
			expect(event).toBeNull();
			expect(nextState.wasTrue).toBe(false);
		});
	});

	describe("new highs and lows", () => {
		test("fires once when Torn's range high beats the recorded one", () => {
			const { event, nextState } = evaluateUserStockAlert({
				snapshot: snapshot(),
				subscription: subscription({ condition: "new_high", range: "7d" }),
				state: seeded({ lastExtreme: 1000 }),
				nowMs: NOW_MS,
			});

			expect(event).not.toBeNull();
			expect(event?.event.type).toBe("high");
			expect(event?.event.range).toBe("7d");
			expect(event?.event.extreme).toBe(1060);
			expect(event?.event.previousExtreme).toBe(1000);
			expect(nextState.lastExtreme).toBe(1060);
		});

		test("does not repeat while the same high stands", () => {
			const { event } = evaluateUserStockAlert({
				snapshot: snapshot(),
				subscription: subscription({ condition: "new_high", range: "7d" }),
				state: seeded({ lastExtreme: 1060 }),
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
		});

		test("a low alert fires when the range low drops below the record", () => {
			const { event } = evaluateUserStockAlert({
				snapshot: snapshot(),
				subscription: subscription({ condition: "new_low", range: "30d" }),
				state: seeded({ lastExtreme: 870 }),
				nowMs: NOW_MS,
			});

			expect(event).not.toBeNull();
			expect(event?.event.type).toBe("low");
			expect(event?.event.extreme).toBe(850);
		});

		test("advances the record even when the cooldown swallows the message", () => {
			const { event, nextState } = evaluateUserStockAlert({
				snapshot: snapshot(),
				subscription: subscription({ condition: "new_high", range: "7d" }),
				// Alerted a minute ago, well inside the one-hour backstop.
				state: seeded({ lastExtreme: 1000, lastAlertAt: NOW_MS - 60_000 }),
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
			// The peak is recorded, so it is not announced later as if it were new.
			expect(nextState.lastExtreme).toBe(1060);
		});
	});

	describe("cooldown backstop", () => {
		test("suppresses a second crossing inside the cooldown window", () => {
			const { event } = evaluateUserStockAlert({
				snapshot: snapshot({ price: 1250 }),
				subscription: subscription({
					condition: "price_above",
					threshold: 1200,
				}),
				state: seeded({
					wasTrue: false,
					lastAlertAt: NOW_MS - 10 * 60_000,
				}),
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
		});

		test("allows a crossing once the cooldown has elapsed", () => {
			const { event } = evaluateUserStockAlert({
				snapshot: snapshot({ price: 1250 }),
				subscription: subscription({
					condition: "price_above",
					threshold: 1200,
				}),
				state: seeded({
					wasTrue: false,
					lastAlertAt: NOW_MS - 61 * 60_000,
				}),
				nowMs: NOW_MS,
			});

			expect(event).not.toBeNull();
		});
	});

	describe("state normalisation", () => {
		test("repairs a malformed stored state instead of trusting it", () => {
			expect(normaliseUserStockAlertState("not an object")).toEqual(
				createEmptyUserStockAlertState(),
			);

			expect(
				normaliseUserStockAlertState({
					seeded: "yes",
					wasTrue: "perhaps",
					lastExtreme: Number.NaN,
					lastAlertAt: "soon",
				}),
			).toEqual({
				seeded: false,
				wasTrue: null,
				lastExtreme: null,
				lastAlertAt: null,
			});
		});

		test("keeps a well-formed state intact", () => {
			const state = {
				seeded: true,
				wasTrue: false,
				lastExtreme: 1234.5,
				lastAlertAt: NOW_MS,
			};

			expect(normaliseUserStockAlertState(state)).toEqual(state);
		});
	});
});
