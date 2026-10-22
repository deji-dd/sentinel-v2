import { describe, expect, test } from "bun:test";

import {
	buildUserStockAlertConditionKey,
	createEmptyUserStockAlertState,
	isUserStockAlertFlowCondition,
	readUserStockAlertFlow,
	USER_STOCK_ALERT_CONDITIONS,
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
		// After the spread, so the field stays non-optional for the flow rules:
		// `Partial` would otherwise make it `number | null | undefined`. An
		// explicit null is preserved, which is how a missing Torn figure is tested.
		shares: patch.shares === undefined ? 26_000_000_000 : patch.shares,
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

	describe("flow vocabulary", () => {
		test("reads each flow condition's direction and unit from its name", () => {
			expect(readUserStockAlertFlow("bulk_buy")).toEqual({
				direction: "buy",
				unit: "pct",
			});
			expect(readUserStockAlertFlow("bulk_buy_shares")).toEqual({
				direction: "buy",
				unit: "shares",
			});
			expect(readUserStockAlertFlow("bulk_sell")).toEqual({
				direction: "sell",
				unit: "pct",
			});
			expect(readUserStockAlertFlow("bulk_sell_shares")).toEqual({
				direction: "sell",
				unit: "shares",
			});
			expect(readUserStockAlertFlow("price_above")).toBeNull();
		});

		test("classifies every bulk condition as a flow condition", () => {
			// Guards the one thing the name-derived reading cannot: a `bulk_`
			// variant added to the vocabulary but left out of the flow list would
			// silently fall through to the price conditions.
			const bulk = USER_STOCK_ALERT_CONDITIONS.filter((condition) =>
				condition.startsWith("bulk_"),
			);

			expect(bulk.length).toBe(4);
			for (const condition of bulk) {
				expect(isUserStockAlertFlowCondition(condition)).toBe(true);
			}
		});
	});

	describe("bulk buying and selling", () => {
		/** 26B shares outstanding, the scale the real market trades at. */
		const OUTSTANDING = 26_000_000_000;
		const SWEEP_MS = 5 * 60_000;

		/** A state that has already recorded one sweep, so the next one has a flow. */
		function flowed(
			shares: number,
			at = NOW_MS - SWEEP_MS,
		): UserStockAlertState {
			return seeded({ lastShares: shares, lastSharesAt: at });
		}

		test("seeds the share count and stays quiet on the first sweep", () => {
			// Without the baseline, the first evaluation would report every
			// outstanding share as a fresh bulk buy.
			const { event, nextState } = evaluateUserStockAlert({
				snapshot: snapshot({ shares: OUTSTANDING }),
				subscription: subscription({ condition: "bulk_buy", threshold: 0.25 }),
				state: null,
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
			expect(nextState.seeded).toBe(true);
			expect(nextState.lastShares).toBe(OUTSTANDING);
			expect(nextState.lastSharesAt).toBe(NOW_MS);
		});

		test("fires on a bulk buy once the flow clears the threshold", () => {
			// +0.5% of the float: a whale-scale block on a 26B-share stock.
			const shares = OUTSTANDING + 130_000_000;
			const { event, nextState } = evaluateUserStockAlert({
				snapshot: snapshot({ shares, price: 1174.06 }),
				subscription: subscription({ condition: "bulk_buy", threshold: 0.25 }),
				state: flowed(OUTSTANDING),
				nowMs: NOW_MS,
			});

			expect(event).not.toBeNull();
			expect(event?.condition).toBe("bulk_buy");
			expect(event?.event.type).toBe("flow");
			expect(event?.event.flowShares).toBe(130_000_000);
			expect(event?.event.flowPct).toBeCloseTo(0.5, 6);
			expect(event?.event.outstandingShares).toBe(shares);
			expect(event?.event.windowLabel).toBe("5 minutes");
			expect(event?.description).toContain("+130,000,000 shares");
			// The threshold travels in the unit the subscription chose.
			expect(event?.event.flowThresholdPct).toBe(0.25);
			expect(event?.event.flowThresholdShares).toBeUndefined();
			expect(nextState.lastAlertAt).toBe(NOW_MS);
		});

		test("fires on a share-count buy, where the threshold is the share count", () => {
			// The same 130M shares, but this subscription watches the count itself,
			// so a 120M threshold clears and a 140M threshold does not.
			const shares = OUTSTANDING + 130_000_000;
			const passing = evaluateUserStockAlert({
				snapshot: snapshot({ shares }),
				subscription: subscription({
					condition: "bulk_buy_shares",
					threshold: 120_000_000,
				}),
				state: flowed(OUTSTANDING),
				nowMs: NOW_MS,
			});
			const failing = evaluateUserStockAlert({
				snapshot: snapshot({ shares }),
				subscription: subscription({
					condition: "bulk_buy_shares",
					threshold: 140_000_000,
				}),
				state: flowed(OUTSTANDING),
				nowMs: NOW_MS,
			});

			expect(passing.event).not.toBeNull();
			expect(passing.event?.event.flowThresholdShares).toBe(120_000_000);
			expect(passing.event?.event.flowThresholdPct).toBeUndefined();
			expect(passing.event?.description).toContain(
				"120,000,000 shares per 5-min sweep",
			);
			// A share-count threshold is not a percentage: 140M shares is 0.54% of
			// the float here, so a percentage subscription at that number would have
			// fired while this one must not.
			expect(failing.event).toBeNull();
		});

		test("fires on a share-count sell in the selling direction only", () => {
			const dumped = OUTSTANDING - 400_000_000;
			const sell = evaluateUserStockAlert({
				snapshot: snapshot({ shares: dumped }),
				subscription: subscription({
					condition: "bulk_sell_shares",
					threshold: 250_000_000,
				}),
				state: flowed(OUTSTANDING),
				nowMs: NOW_MS,
			});
			const buy = evaluateUserStockAlert({
				snapshot: snapshot({ shares: dumped }),
				subscription: subscription({
					condition: "bulk_buy_shares",
					threshold: 250_000_000,
				}),
				state: flowed(OUTSTANDING),
				nowMs: NOW_MS,
			});

			expect(sell.event?.event.flowThresholdShares).toBe(250_000_000);
			expect(sell.event?.description).toContain(
				"Bulk selling 250,000,000 shares",
			);
			// Shares retired satisfy a sell threshold and never a buy one.
			expect(buy.event).toBeNull();
		});

		test("fires on a bulk sell, and reports the retired shares as negative", () => {
			const shares = OUTSTANDING - 321_407_138;
			const { event } = evaluateUserStockAlert({
				snapshot: snapshot({ shares }),
				subscription: subscription({
					condition: "bulk_sell",
					threshold: 1.2,
				}),
				state: flowed(OUTSTANDING),
				nowMs: NOW_MS,
			});

			expect(event).not.toBeNull();
			expect(event?.event.flowShares).toBe(-321_407_138);
			expect(event?.event.flowPct).toBeCloseTo(-1.2362, 3);
			expect(event?.description).toContain("-321,407,138 shares");
		});

		test("ignores a flow smaller than the threshold", () => {
			const { event, nextState } = evaluateUserStockAlert({
				snapshot: snapshot({ shares: OUTSTANDING + 3_000_000 }),
				subscription: subscription({ condition: "bulk_buy", threshold: 0.25 }),
				state: flowed(OUTSTANDING),
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
			// The baseline still advances: a small flow must not accumulate into a
			// large one across sweeps.
			expect(nextState.lastShares).toBe(OUTSTANDING + 3_000_000);
		});

		test("does not report the same flow twice on the next sweep", () => {
			const bulked = OUTSTANDING + 130_000_000;
			const first = evaluateUserStockAlert({
				snapshot: snapshot({ shares: bulked }),
				subscription: subscription({ condition: "bulk_buy", threshold: 0.25 }),
				state: flowed(OUTSTANDING),
				nowMs: NOW_MS,
			});
			expect(first.event).not.toBeNull();

			// The share count has not moved since, so the next sweep sees no flow.
			const second = evaluateUserStockAlert({
				snapshot: snapshot({ shares: bulked }),
				subscription: subscription({ condition: "bulk_buy", threshold: 0.25 }),
				state: first.nextState,
				nowMs: NOW_MS + SWEEP_MS,
			});

			expect(second.event).toBeNull();
		});

		test("keeps the baseline when Torn omits the share count", () => {
			const { event, nextState } = evaluateUserStockAlert({
				snapshot: snapshot({ shares: null }),
				subscription: subscription({ condition: "bulk_sell", threshold: 0.25 }),
				state: flowed(OUTSTANDING),
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
			// "No opinion", not "no flow": the next sweep must still measure from
			// the last figure Torn actually published.
			expect(nextState.lastShares).toBe(OUTSTANDING);
			expect(nextState.lastSharesAt).toBe(NOW_MS - SWEEP_MS);
		});

		test("honours the cooldown without losing the new baseline", () => {
			const shares = OUTSTANDING - 400_000_000;
			const { event, nextState } = evaluateUserStockAlert({
				snapshot: snapshot({ shares }),
				subscription: subscription({ condition: "bulk_sell", threshold: 0.5 }),
				// A delivery ten minutes ago sits inside the default one-hour
				// cooldown, so this dump is suppressed...
				state: seeded({
					lastShares: OUTSTANDING,
					lastSharesAt: NOW_MS - 10 * 60_000,
					lastAlertAt: NOW_MS - 10 * 60_000,
				}),
				nowMs: NOW_MS,
			});

			expect(event).toBeNull();
			// ...but still consumed: the suppression must not queue the same flow
			// up to be announced once the cooldown lapses.
			expect(nextState.lastShares).toBe(shares);
			expect(nextState.lastAlertAt).toBe(NOW_MS - 10 * 60_000);
		});

		test("reports the window it actually measured, not the nominal cadence", () => {
			// A skipped cycle: the flow below accumulated over half an hour.
			const { event } = evaluateUserStockAlert({
				snapshot: snapshot({ shares: OUTSTANDING + 200_000_000 }),
				subscription: subscription({ condition: "bulk_buy", threshold: 0.25 }),
				state: flowed(OUTSTANDING, NOW_MS - 30 * 60_000),
				nowMs: NOW_MS,
			});

			expect(event?.event.windowLabel).toBe("30 minutes");
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
					lastShares: "many",
					lastSharesAt: Number.POSITIVE_INFINITY,
					lastAlertAt: "soon",
				}),
			).toEqual({
				seeded: false,
				wasTrue: null,
				lastExtreme: null,
				lastShares: null,
				lastSharesAt: null,
				lastAlertAt: null,
			});
		});

		test("keeps a well-formed state intact", () => {
			const state = {
				seeded: true,
				wasTrue: false,
				lastExtreme: 1234.5,
				lastShares: 26_000_000_000,
				lastSharesAt: NOW_MS - 300_000,
				lastAlertAt: NOW_MS,
			};

			expect(normaliseUserStockAlertState(state)).toEqual(state);
		});
	});
});
