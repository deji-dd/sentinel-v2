import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	spyOn,
	test,
} from "bun:test";
import {
	db,
	eq,
	guildStockAlertConfigs,
	guildStockAlertStates,
	inArray,
	userStockAlerts,
} from "@sentinel/database";
import type { IpcMessage } from "@sentinel/schemas";
import {
	buildUserStockAlertConditionKey,
	DEFAULT_GUILD_STOCK_ALERT_CONFIG,
	type GuildStockAlertConfig,
	type StockAlertEvent,
	type StockAlertState,
} from "@sentinel/schemas";
import { setActiveIpcServer } from "../src/lib/ipc/server";
import {
	createEmptyStockAlertState,
	evaluateStockAlerts,
	findReferenceSample,
	normaliseStockAlertState,
	type StockAlertSnapshot,
} from "../src/workers/subversive/stock-alert-rules";
import {
	resetStockAlertWorkerState,
	runStockAlertCycle,
} from "../src/workers/subversive/stock-alerts";
import { removeSystemApiKey, seedSystemApiKey } from "./helpers/system-api-key";

const NOW_MS = 1_800_000_000_000; // fixed instant: every figure below is relative to it

const TEST_GUILD_ID = "111111111111111111";
const TEST_GUILD_ID_2 = "222222222222222222";
const TEST_CHANNEL_ID = "333333333333333333";
const TEST_CHANNEL_ID_2 = "444444444444444444";
const TEST_USER_ID = "555555555555555555";

function config(
	patch: Partial<GuildStockAlertConfig> = {},
): GuildStockAlertConfig {
	return { ...DEFAULT_GUILD_STOCK_ALERT_CONFIG, ...patch };
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
			all_time: { changePct: 50, start: 500, high: 1200, low: 400 },
		},
		history: [],
		...patch,
	};
}

/** A history series at one-minute resolution ending one minute before `nowMs`. */
function minuteHistory(
	nowMs: number,
	prices: number[],
): { timestamp: number; price: number }[] {
	const newestMinute = Math.floor(nowMs / 60_000) - 1;
	return prices.map((price, index) => {
		const minutesAgo = prices.length - 1 - index;
		return { timestamp: (newestMinute - minutesAgo) * 60, price };
	});
}

/** A seeded state whose recorded extremes are the given figures. */
function seededState(patch: Partial<StockAlertState> = {}): StockAlertState {
	return {
		...createEmptyStockAlertState(),
		seeded: true,
		lastPrice: 1000,
		extremes: {
			"24h": { high: 1010, low: 990 },
			all_time: { high: 1200, low: 400 },
		},
		...patch,
	};
}

describe("Stock alert rules", () => {
	describe("seed cycle", () => {
		test("records Torn's own extremes and emits nothing on first sight", () => {
			const { events, nextState } = evaluateStockAlerts({
				snapshot: snapshot(),
				config: config(),
				state: null,
				nowMs: NOW_MS,
			});

			expect(events).toEqual([]);
			expect(nextState.seeded).toBe(true);
			expect(nextState.lastPrice).toBe(1000);
			expect(nextState.extremes["24h"]).toEqual({ high: 1010, low: 990 });
			expect(nextState.extremes.all_time).toEqual({ high: 1200, low: 400 });
		});

		test("stays unseeded when the detailed response carried no window figures", () => {
			const { events, nextState } = evaluateStockAlerts({
				snapshot: snapshot({ performance: {} }),
				config: config(),
				state: null,
				nowMs: NOW_MS,
			});

			expect(events).toEqual([]);
			expect(nextState.seeded).toBe(false);
		});
	});

	describe("change rules", () => {
		test("emits when the move exactly reaches the threshold", () => {
			// 1000 -> 1005 over 30 minutes is exactly 0.5%.
			const history = minuteHistory(NOW_MS, [1000, 1000, 1000, 1005]);
			const { events } = evaluateStockAlerts({
				snapshot: snapshot({ price: 1005, history }),
				config: config({
					changeRules: [{ windowMinutes: 5, thresholdPct: 0.5 }],
				}),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events).toHaveLength(1);
			const event = events[0] as StockAlertEvent;
			expect(event.type).toBe("change");
			expect(event.alertKey).toBe("change:5");
			expect(event.changePct).toBeCloseTo(0.5, 10);
			expect(event.windowLabel).toBe("5 minutes");
		});

		test("stays silent just below the threshold", () => {
			const history = minuteHistory(NOW_MS, [1000, 1000, 1000, 1000.4]);
			const { events } = evaluateStockAlerts({
				snapshot: snapshot({ price: 1000.4, history }),
				config: config({
					changeRules: [{ windowMinutes: 5, thresholdPct: 0.5 }],
				}),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events).toEqual([]);
		});

		test("reports drops with a negative percentage", () => {
			const history = minuteHistory(NOW_MS, [1000, 1000, 1000, 990]);
			const { events } = evaluateStockAlerts({
				snapshot: snapshot({ price: 990, history }),
				config: config({
					changeRules: [{ windowMinutes: 5, thresholdPct: 0.5 }],
				}),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events).toHaveLength(1);
			expect((events[0] as StockAlertEvent).changePct).toBeCloseTo(-1, 10);
		});

		test("uses Torn's rolling day figure for the 24-hour rule", () => {
			const { events } = evaluateStockAlerts({
				snapshot: snapshot({
					price: 1000,
					performance: {
						// Window extremes match the seeded baseline, so the only event
						// this cycle can produce is the recorded move.
						"24h": { changePct: 2.5, start: 975.61, high: 1010, low: 990 },
						all_time: { changePct: 50, start: 500, high: 1200, low: 400 },
					},
				}),
				config: config({
					changeRules: [{ windowMinutes: 1440, thresholdPct: 1 }],
				}),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events).toHaveLength(1);
			const event = events[0] as StockAlertEvent;
			expect(event.windowLabel).toBe("24 hours");
			expect(event.changePct).toBeCloseTo(2.5, 10);
			expect(event.referencePrice).toBeCloseTo(975.61, 10);
		});

		test("skips a rule when the history cannot cover half the window", () => {
			// Only two minutes of history for a 30-minute rule.
			const history = minuteHistory(NOW_MS, [1000, 1000]);
			const { events } = evaluateStockAlerts({
				snapshot: snapshot({ price: 1100, history }),
				config: config({
					changeRules: [{ windowMinutes: 30, thresholdPct: 0.5 }],
				}),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events).toEqual([]);
		});
	});

	describe("cooldown and episode semantics", () => {
		test("suppresses a repeat inside the cooldown but still records the move", () => {
			const history = minuteHistory(NOW_MS, [1000, 1000, 1000, 1005]);
			const { events, nextState } = evaluateStockAlerts({
				snapshot: snapshot({ price: 1005, history }),
				config: config({
					changeRules: [{ windowMinutes: 5, thresholdPct: 0.5 }],
					cooldownMinutes: 30,
				}),
				state: seededState({ lastAlertAt: { "change:5": NOW_MS - 60_000 } }),
				nowMs: NOW_MS,
			});

			expect(events).toEqual([]);
			// The suppressed alert still refreshes the cooldown, so an ongoing move
			// is reported once per episode rather than on a timer.
			expect(nextState.lastAlertAt["change:5"]).toBe(NOW_MS);
		});

		test("emits again once the cooldown has elapsed", () => {
			const history = minuteHistory(NOW_MS, [1000, 1000, 1000, 1005]);
			const { events } = evaluateStockAlerts({
				snapshot: snapshot({ price: 1005, history }),
				config: config({
					changeRules: [{ windowMinutes: 5, thresholdPct: 0.5 }],
					cooldownMinutes: 30,
				}),
				state: seededState({
					lastAlertAt: { "change:5": NOW_MS - 31 * 60_000 },
				}),
				nowMs: NOW_MS,
			});

			expect(events).toHaveLength(1);
		});
	});

	describe("highs and lows", () => {
		test("emits a new 24-hour high and stores it", () => {
			const { events, nextState } = evaluateStockAlerts({
				snapshot: snapshot({
					price: 1015,
					performance: {
						"24h": { changePct: 1, start: 1000, high: 1015, low: 990 },
						all_time: { changePct: 50, start: 500, high: 1200, low: 400 },
					},
				}),
				config: config({ changeRules: [], highLowRanges: ["24h"] }),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events).toHaveLength(1);
			const event = events[0] as StockAlertEvent;
			expect(event.type).toBe("high");
			expect(event.windowLabel).toBe("24 hours");
			expect(event.extreme).toBe(1015);
			expect(event.previousExtreme).toBe(1010);
			expect(nextState.extremes["24h"]?.high).toBe(1015);
		});

		test("emits a new all-time low", () => {
			const { events, nextState } = evaluateStockAlerts({
				snapshot: snapshot({
					price: 380,
					performance: {
						"24h": { changePct: -20, start: 1000, high: 1010, low: 380 },
						all_time: { changePct: -24, start: 500, high: 1200, low: 380 },
					},
				}),
				config: config({ changeRules: [], highLowRanges: ["all_time"] }),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events).toHaveLength(1);
			const event = events[0] as StockAlertEvent;
			expect(event.type).toBe("low");
			expect(event.windowLabel).toBe("all time");
			expect(event.extreme).toBe(380);
			expect(event.previousExtreme).toBe(400);
			expect(nextState.extremes.all_time?.low).toBe(380);
		});

		test("does not repeat while the price merely sits at its high", () => {
			const { events } = evaluateStockAlerts({
				snapshot: snapshot({
					price: 1010,
					performance: {
						"24h": { changePct: 1, start: 1000, high: 1010, low: 990 },
						all_time: { changePct: 50, start: 500, high: 1200, low: 400 },
					},
				}),
				config: config({ changeRules: [], highLowRanges: ["24h"] }),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events).toEqual([]);
		});

		test("ignores windows that are not selected", () => {
			const { events } = evaluateStockAlerts({
				snapshot: snapshot({
					price: 1300,
					performance: {
						"24h": { changePct: 30, start: 1000, high: 1300, low: 990 },
						all_time: { changePct: 160, start: 500, high: 1300, low: 400 },
					},
				}),
				config: config({ changeRules: [], highLowRanges: ["24h"] }),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events).toHaveLength(1);
			expect((events[0] as StockAlertEvent).alertKey).toBe("high:24h");
		});
	});

	describe("configurable ranges", () => {
		test("seeds a baseline for every range Torn published, not just the enabled ones", () => {
			const { nextState } = evaluateStockAlerts({
				snapshot: snapshot(),
				config: config({ changeRules: [], highLowRanges: ["24h"] }),
				state: null,
				nowMs: NOW_MS,
			});

			// Only 24h is enabled, but every published range is recorded — so turning
			// 7d on later compares against Torn's own figures instead of alerting on
			// the first high it happens to observe.
			expect(nextState.extremes["7d"]).toEqual({ high: 1060, low: 900 });
			expect(nextState.extremes["30d"]).toEqual({ high: 1100, low: 850 });
			expect(nextState.extremes["1y"]).toEqual({ high: 1300, low: 600 });
		});

		test("raises a new-week-high alert for a range beyond the original two", () => {
			const { events } = evaluateStockAlerts({
				snapshot: snapshot(),
				config: config({ changeRules: [], highLowRanges: ["7d"] }),
				state: seededState({
					extremes: { "7d": { high: 1000, low: 900 } },
				}),
				nowMs: NOW_MS,
			});

			expect(events).toHaveLength(1);
			const event = events[0] as StockAlertEvent;
			expect(event.alertKey).toBe("high:7d");
			expect(event.windowLabel).toBe("7 days");
			expect(event.range).toBe("7d");
			expect(event.extreme).toBe(1060);
			expect(event.previousExtreme).toBe(1000);
		});

		test("raises a new-month-low alert", () => {
			const { events } = evaluateStockAlerts({
				snapshot: snapshot(),
				config: config({ changeRules: [], highLowRanges: ["30d"] }),
				state: seededState({
					extremes: { "30d": { high: 1100, low: 880 } },
				}),
				nowMs: NOW_MS,
			});

			expect(events).toHaveLength(1);
			const event = events[0] as StockAlertEvent;
			expect(event.alertKey).toBe("low:30d");
			expect(event.range).toBe("30d");
			expect(event.extreme).toBe(850);
		});

		test("reports only the ranges the guild tracks in the alert context", () => {
			const { events } = evaluateStockAlerts({
				snapshot: snapshot(),
				config: config({ changeRules: [], highLowRanges: ["7d", "1y"] }),
				state: seededState({
					extremes: {
						"7d": { high: 1000, low: 900 },
						"1y": { high: 1300, low: 600 },
					},
				}),
				nowMs: NOW_MS,
			});

			const event = events[0] as StockAlertEvent;
			expect(event.context.ranges.map((entry) => entry.range)).toEqual([
				"7d",
				"1y",
			]);
			expect(event.context.ranges[0]?.label).toBe("7 days");
		});

		test("does not alert for a selected range Torn did not publish", () => {
			const { events } = evaluateStockAlerts({
				snapshot: snapshot({
					performance: {
						"24h": { changePct: 0, start: 1000, high: 1010, low: 990 },
					},
				}),
				config: config({ changeRules: [], highLowRanges: ["7d"] }),
				state: seededState({ extremes: { "7d": { high: 1000, low: 900 } } }),
				nowMs: NOW_MS,
			});

			expect(events).toEqual([]);
		});
	});

	describe("long move windows", () => {
		test("measures a weekly window from Torn's own weekly figures", () => {
			const { events } = evaluateStockAlerts({
				snapshot: snapshot(),
				config: config({
					changeRules: [{ windowMinutes: 10_080, thresholdPct: 4 }],
					highLowRanges: [],
				}),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events).toHaveLength(1);
			const event = events[0] as StockAlertEvent;
			expect(event.alertKey).toBe("change:10080");
			expect(event.windowLabel).toBe("7 days");
			// The range behind the window, so the embed opens the weekly chart.
			expect(event.range).toBe("7d");
			expect(event.changePct).toBe(5);
			expect(event.referencePrice).toBe(950);
		});

		test("does not fire a weekly rule on a move that is too small", () => {
			const { events } = evaluateStockAlerts({
				snapshot: snapshot(),
				config: config({
					changeRules: [{ windowMinutes: 10_080, thresholdPct: 6 }],
					highLowRanges: [],
				}),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events).toEqual([]);
		});

		test("fires a monthly rule while an intraday rule stays quiet", () => {
			const { events } = evaluateStockAlerts({
				snapshot: snapshot(),
				config: config({
					changeRules: [
						{ windowMinutes: 30, thresholdPct: 5 },
						{ windowMinutes: 43_200, thresholdPct: 10 },
					],
					highLowRanges: [],
				}),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events.map((event) => event.alertKey)).toEqual(["change:43200"]);
			expect((events[0] as StockAlertEvent).windowLabel).toBe("30 days");
			expect((events[0] as StockAlertEvent).range).toBe("30d");
		});
	});

	describe("reference sample selection", () => {
		test("picks the oldest point that is not older than the target", () => {
			const history = minuteHistory(NOW_MS, [1, 2, 3, 4, 5, 6]);
			const reference = findReferenceSample(history, NOW_MS, 3);
			// Six points span minutes [now-6, now-1]; a three-minute window starts
			// at now-3, so the oldest usable point is now-3.
			expect(reference?.price).toBe(4);
		});

		test("tolerates unordered history", () => {
			const history = minuteHistory(NOW_MS, [1, 2, 3, 4, 5, 6]).reverse();
			const reference = findReferenceSample(history, NOW_MS, 3);
			expect(reference?.price).toBe(4);
		});

		test("returns null when every point is newer than half the window", () => {
			const history = minuteHistory(NOW_MS, [1, 2]).slice(1);
			expect(findReferenceSample(history, NOW_MS, 60)).toBeNull();
		});
	});

	describe("state normalisation", () => {
		test("repairs malformed stored state instead of trusting it", () => {
			const state = normaliseStockAlertState({
				seeded: "yes",
				lastPrice: "1000",
				extremes: { "24h": { high: 1, low: 2 }, bogus: { high: 3, low: 4 } },
				lastAlertAt: { "change:5": 123, broken: "nope" },
			});

			expect(state.seeded).toBe(false);
			expect(state.lastPrice).toBeNull();
			expect(state.extremes["24h"]).toEqual({ high: 1, low: 2 });
			expect(state.extremes.all_time).toBeUndefined();
			expect(state.lastAlertAt).toEqual({ "change:5": 123 });
		});
	});
});

describe("Stock alert worker", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let broadcasts: IpcMessage[] = [];
	let detailRequests: number[] = [];
	/**
	 * Mutable market state the mocked Torn endpoints report. Tests advance it
	 * between cycles to simulate the only thing that can raise an alert: the price
	 * actually moving.
	 */
	let market = {
		listPrice: 1000,
		high: 1010,
		low: 990,
		allTimeHigh: 1200,
		allTimeLow: 400,
	};
	/** Stock ids the mocked `/torn/stocks` lists this test. */
	let universeIds = [1];
	/** Stock ids whose detailed response fails, for resilience coverage. */
	let failingDetailIds = new Set<number>();

	/** Minimal IPC server stand-in; the worker only ever calls broadcast. */
	const fakeIpcServer = {
		broadcast: (payload: IpcMessage) => {
			broadcasts.push(payload);
		},
	} as unknown as Parameters<typeof setActiveIpcServer>[0];

	function tornStock(id: number, price: number) {
		return {
			id,
			name: `Stock ${id}`,
			acronym: `S${id}`,
			images: { logo: "logo", full: "full" },
			market: { price, cap: 1, shares: 1, investors: 1 },
			bonus: {
				passive: false,
				frequency: 1,
				requirement: 1,
				description: "test",
			},
		};
	}

	function tornDetailed(
		id: number,
		args: {
			price: number;
			high: number;
			low: number;
			allTimeHigh?: number;
			allTimeLow?: number;
			history?: { timestamp: number; price: number }[];
		},
	) {
		return {
			...tornStock(id, args.price),
			chart: {
				performance: {
					last_hour: {
						change: 0,
						change_percentage: 0,
						start: args.price,
						end: args.price,
						high: args.high,
						low: args.low,
					},
					last_day: {
						change: 0,
						change_percentage: 0,
						start: args.price,
						end: args.price,
						high: args.high,
						low: args.low,
					},
					last_week: {
						change: 0,
						change_percentage: 0,
						start: args.price,
						end: args.price,
						high: args.high,
						low: args.low,
					},
					last_month: {
						change: 0,
						change_percentage: 0,
						start: args.price,
						end: args.price,
						high: args.high,
						low: args.low,
					},
					last_year: {
						change: 0,
						change_percentage: 0,
						start: args.price,
						end: args.price,
						high: args.high,
						low: args.low,
					},
					all_time: {
						change: 0,
						change_percentage: 0,
						start: args.price,
						end: args.price,
						high: args.allTimeHigh ?? args.high,
						low: args.allTimeLow ?? args.low,
					},
				},
				history: args.history ?? [],
			},
		};
	}

	/**
	 * The worker sweeps *every* guild with alerts enabled and every subscription,
	 * so a single row left in the database by a developer or a previous run would
	 * make these assertions meaningless. The tables are therefore emptied for the
	 * duration of the suite and put back exactly as they were afterwards, rather
	 * than being destroyed.
	 */
	let savedConfigs: Array<typeof guildStockAlertConfigs.$inferSelect> = [];
	let savedStates: Array<typeof guildStockAlertStates.$inferSelect> = [];
	let savedSubscriptions: Array<typeof userStockAlerts.$inferSelect> = [];

	beforeAll(async () => {
		// The worker acquires its Torn credentials from the shared key pool before
		// it can reach the mocked `fetch`, so the pool has to hold a key even on a
		// database that has never seen one. Enrolling a user key is not enough:
		// that path is gated on `ENCRYPTION_KEY`, which CI does not have.
		await seedSystemApiKey();

		savedConfigs = await db.select().from(guildStockAlertConfigs);
		savedStates = await db.select().from(guildStockAlertStates);
		savedSubscriptions = await db.select().from(userStockAlerts);

		await db.delete(guildStockAlertStates);
		await db.delete(guildStockAlertConfigs);
		await db.delete(userStockAlerts);
	});

	afterAll(async () => {
		await db.delete(guildStockAlertStates);
		await db.delete(guildStockAlertConfigs);
		await db.delete(userStockAlerts);

		if (savedConfigs.length > 0) {
			await db.insert(guildStockAlertConfigs).values(savedConfigs);
		}
		if (savedStates.length > 0) {
			await db.insert(guildStockAlertStates).values(savedStates);
		}
		if (savedSubscriptions.length > 0) {
			await db.insert(userStockAlerts).values(savedSubscriptions);
		}

		await removeSystemApiKey();
		shutDownTestState();
	});

	beforeEach(async () => {
		setSystemTime(new Date(NOW_MS));
		resetStockAlertWorkerState();
		broadcasts = [];
		detailRequests = [];
		market = {
			listPrice: 1000,
			high: 1010,
			low: 990,
			allTimeHigh: 1200,
			allTimeLow: 400,
		};
		universeIds = [1];
		failingDetailIds = new Set<number>();
		setActiveIpcServer(fakeIpcServer);

		await db
			.delete(guildStockAlertStates)
			.where(eq(guildStockAlertStates.guildId, TEST_GUILD_ID));
		await db
			.delete(guildStockAlertConfigs)
			.where(eq(guildStockAlertConfigs.guildId, TEST_GUILD_ID));

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
		) => {
			const url = input.toString();
			const json = (payload: unknown) =>
				new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});

			if (url.includes("/torn/stocks")) {
				return json({
					stocks: universeIds.map((id) => tornStock(id, market.listPrice)),
				});
			}

			const detailMatch = url.match(/\/torn\/(\d+)\/stocks/);
			if (detailMatch?.[1]) {
				const id = Number(detailMatch[1]);
				detailRequests.push(id);
				if (failingDetailIds.has(id)) {
					// A per-stock upstream failure: Torn answers 200 with an error
					// body, which is not a key error and must not kill the sweep.
					return json({
						error: { code: 14, error: "Stock temporarily unavailable" },
					});
				}
				return json({
					stocks: tornDetailed(id, {
						price: market.listPrice,
						high: market.high,
						low: market.low,
						allTimeHigh: market.allTimeHigh,
						allTimeLow: market.allTimeLow,
					}),
				});
			}

			return json({});
		}) as unknown as typeof fetch);
	});

	afterEach(async () => {
		setSystemTime();
		fetchSpy.mockRestore();
		shutDownTestState();
	});

	function shutDownTestState(): void {
		setActiveIpcServer(null);
	}

	test("makes no Torn requests while every faction is disabled", async () => {
		const result = await runStockAlertCycle();

		expect(result.stocksPolled).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("makes no Torn requests when alerts are enabled without a channel", async () => {
		await db.insert(guildStockAlertConfigs).values({
			guildId: TEST_GUILD_ID,
			enabled: true,
			channelId: null,
			changeRules: [{ windowMinutes: 5, thresholdPct: 0.5 }],
			highLowRanges: ["24h"],
			cooldownMinutes: 0,
		});

		const result = await runStockAlertCycle();

		expect(result.stocksPolled).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("seeds baselines on the first cycle and alerts on a later move", async () => {
		await db.insert(guildStockAlertConfigs).values({
			guildId: TEST_GUILD_ID,
			enabled: true,
			channelId: TEST_CHANNEL_ID,
			changeRules: [],
			highLowRanges: ["24h", "all_time"],
			cooldownMinutes: 0,
		});

		const first = await runStockAlertCycle();
		expect(first.stocksPolled).toBe(1);
		expect(first.detailsFetched).toBe(1);
		expect(first.alertsQueued).toBe(0);
		expect(broadcasts).toEqual([]);

		const seeded = await db.query.guildStockAlertStates.findFirst({
			where: eq(guildStockAlertStates.guildId, TEST_GUILD_ID),
		});
		expect(seeded?.state.seeded).toBe(true);
		expect(seeded?.state.extremes["24h"]).toEqual({ high: 1010, low: 990 });

		// The market moves: a new day high and a new all-time high.
		market = {
			listPrice: 1015,
			high: 1015,
			low: 990,
			allTimeHigh: 1210,
			allTimeLow: 400,
		};

		const second = await runStockAlertCycle();
		expect(second.alertsQueued).toBe(2);
		expect(broadcasts).toHaveLength(1);

		const payload = broadcasts[0];
		if (payload?.action !== "subversive_stock_alerts") {
			throw new Error("Expected a stock alert broadcast");
		}
		expect(payload.data.notificationChannelId).toBe(TEST_CHANNEL_ID);
		const keys = payload.data.alerts.map((alert) => alert.alertKey).sort();
		expect(keys).toEqual(["high:24h", "high:all_time"]);
	});

	test("skips detail requests when the price has not moved", async () => {
		await db.insert(guildStockAlertConfigs).values({
			guildId: TEST_GUILD_ID,
			enabled: true,
			channelId: TEST_CHANNEL_ID,
			changeRules: [],
			highLowRanges: ["24h"],
			cooldownMinutes: 0,
		});

		// First cycle always performs a full sweep, which is what arms the fast path.
		const first = await runStockAlertCycle();
		expect(first.detailsFetched).toBe(1);

		broadcasts = [];
		detailRequests = [];

		const second = await runStockAlertCycle();

		expect(second.detailsFetched).toBe(0);
		expect(detailRequests).toEqual([]);
		expect(second.stocksPolled).toBe(1);
	});

	test("persists state so a restart does not re-announce an extreme", async () => {
		await db.insert(guildStockAlertConfigs).values({
			guildId: TEST_GUILD_ID,
			enabled: true,
			channelId: TEST_CHANNEL_ID,
			changeRules: [],
			highLowRanges: ["24h", "all_time"],
			cooldownMinutes: 0,
		});

		// Seed, then move the market so one cycle announces the new high.
		await runStockAlertCycle();
		market = {
			listPrice: 1015,
			high: 1015,
			low: 990,
			allTimeHigh: 1210,
			allTimeLow: 400,
		};
		await runStockAlertCycle();
		expect(broadcasts).toHaveLength(1);

		// A restart mid-run must not re-announce what is already recorded.
		resetStockAlertWorkerState();
		const third = await runStockAlertCycle();

		expect(third.alertsQueued).toBe(0);
		expect(broadcasts).toHaveLength(1);
	});

	test("evaluates each guild independently and delivers to its own channel", async () => {
		await db.insert(guildStockAlertConfigs).values([
			{
				guildId: TEST_GUILD_ID,
				enabled: true,
				channelId: TEST_CHANNEL_ID,
				changeRules: [],
				highLowRanges: ["24h", "all_time"],
				cooldownMinutes: 0,
			},
			{
				guildId: TEST_GUILD_ID_2,
				enabled: true,
				channelId: TEST_CHANNEL_ID_2,
				changeRules: [],
				highLowRanges: ["24h", "all_time"],
				cooldownMinutes: 0,
			},
		]);

		try {
			await runStockAlertCycle();
			broadcasts = [];
			detailRequests = [];

			market = {
				listPrice: 1015,
				high: 1015,
				low: 990,
				allTimeHigh: 1210,
				allTimeLow: 400,
			};

			const second = await runStockAlertCycle();

			// Two guilds, two channels, so two independent deliveries — and each one
			// carries the same two extremes.
			expect(second.channelsNotified).toBe(2);
			expect(broadcasts).toHaveLength(2);
			for (const payload of broadcasts) {
				if (payload.action !== "subversive_stock_alerts") {
					throw new Error("Expected a stock alert broadcast");
				}
				expect(payload.data.alerts).toHaveLength(2);
			}
			expect(
				broadcasts
					.map((payload) =>
						payload.action === "subversive_stock_alerts"
							? payload.data.notificationChannelId
							: null,
					)
					.sort(),
			).toEqual([TEST_CHANNEL_ID, TEST_CHANNEL_ID_2].sort());

			const rows = await db
				.select()
				.from(guildStockAlertStates)
				.where(
					inArray(guildStockAlertStates.guildId, [
						TEST_GUILD_ID,
						TEST_GUILD_ID_2,
					]),
				);
			expect(rows).toHaveLength(2);
		} finally {
			await db
				.delete(guildStockAlertStates)
				.where(
					inArray(guildStockAlertStates.guildId, [
						TEST_GUILD_ID,
						TEST_GUILD_ID_2,
					]),
				);
			await db
				.delete(guildStockAlertConfigs)
				.where(
					inArray(guildStockAlertConfigs.guildId, [
						TEST_GUILD_ID,
						TEST_GUILD_ID_2,
					]),
				);
		}
	});

	test("sweeps for personal alerts alone, with no guild configured", async () => {
		await db.insert(userStockAlerts).values({
			guildId: TEST_GUILD_ID,
			discordUserId: TEST_USER_ID,
			stockId: 1,
			condition: "price_above",
			rangeKey: null,
			threshold: 1200,
			conditionKey: buildUserStockAlertConditionKey({
				stockId: 1,
				condition: "price_above",
				range: null,
				threshold: 1200,
			}),
			enabled: true,
			state: {
				seeded: false,
				wasTrue: null,
				lastExtreme: null,
				lastAlertAt: null,
			},
		});

		// The guild tables are empty, so this proves the short-circuit no longer
		// requires a channel — a member's own alert is enough to poll the market.
		const first = await runStockAlertCycle();
		expect(first.stocksPolled).toBe(1);
		expect(first.detailsFetched).toBe(1);
		// The seeding cycle records the baseline and stays silent.
		expect(first.userAlertsQueued).toBe(0);
		expect(broadcasts).toEqual([]);

		market = {
			listPrice: 1250,
			high: 1250,
			low: 990,
			allTimeHigh: 1250,
			allTimeLow: 400,
		};

		const second = await runStockAlertCycle();
		expect(second.userAlertsQueued).toBe(1);
		expect(second.alertsQueued).toBe(0);

		const payload = broadcasts.find(
			(message) => message.action === "user_stock_alerts",
		);
		if (payload?.action !== "user_stock_alerts") {
			throw new Error("Expected a personal stock alert broadcast");
		}
		expect(payload.data.alerts).toHaveLength(1);
		const alert = payload.data.alerts[0];
		expect(alert?.discordUserId).toBe(TEST_USER_ID);
		expect(alert?.condition).toBe("price_above");
		expect(alert?.description).toContain("rose above");
		expect(alert?.event.acronym).toBe("S1");

		// The stored state advanced, so the crossing is not announced again.
		const row = await db.query.userStockAlerts.findFirst({
			where: eq(userStockAlerts.discordUserId, TEST_USER_ID),
		});
		expect(row?.state.wasTrue).toBe(true);
		expect(row?.state.seeded).toBe(true);
	});

	test("delivers channel and personal alerts from one sweep", async () => {
		await db.insert(guildStockAlertConfigs).values({
			guildId: TEST_GUILD_ID,
			enabled: true,
			channelId: TEST_CHANNEL_ID,
			changeRules: [],
			highLowRanges: ["24h"],
			cooldownMinutes: 0,
		});
		// Both sides are already seeded and both are watching the same figure, so a
		// single cycle produces a channel post *and* a DM.
		await db.insert(guildStockAlertStates).values({
			guildId: TEST_GUILD_ID,
			stockId: 1,
			state: {
				seeded: true,
				lastPrice: 1000,
				extremes: { "24h": { high: 1010, low: 995 } },
				lastAlertAt: {},
			},
		});
		await db.insert(userStockAlerts).values({
			guildId: TEST_GUILD_ID,
			discordUserId: TEST_USER_ID,
			stockId: 1,
			condition: "new_low",
			rangeKey: "24h",
			threshold: null,
			conditionKey: buildUserStockAlertConditionKey({
				stockId: 1,
				condition: "new_low",
				range: "24h",
				threshold: null,
			}),
			enabled: true,
			state: {
				seeded: true,
				wasTrue: null,
				lastExtreme: 1000,
				lastAlertAt: null,
			},
		});

		const result = await runStockAlertCycle();

		// One Torn sweep, two destinations: the guild's channel and the member's DM.
		expect(result.detailsFetched).toBe(1);
		expect(broadcasts.map((message) => message.action).sort()).toEqual([
			"subversive_stock_alerts",
			"user_stock_alerts",
		]);
		expect(result.alertsQueued).toBe(1);
		expect(result.userAlertsQueued).toBe(1);
	});

	test("skips an unreachable stock without losing the rest of the sweep", async () => {
		universeIds = [1, 2];
		failingDetailIds = new Set([1]);
		await db.insert(guildStockAlertConfigs).values({
			guildId: TEST_GUILD_ID,
			enabled: true,
			channelId: TEST_CHANNEL_ID,
			changeRules: [],
			highLowRanges: ["24h"],
			cooldownMinutes: 0,
		});

		const result = await runStockAlertCycle();

		expect(result.stocksPolled).toBe(2);
		expect(result.detailsFetched).toBe(1);

		const rows = await db
			.select()
			.from(guildStockAlertStates)
			.where(eq(guildStockAlertStates.guildId, TEST_GUILD_ID));
		// Only the healthy stock was recorded; the failing one keeps its previous
		// state so the next cycle retries its detailed fetch.
		expect(rows.map((row) => row.stockId)).toEqual([2]);
	});

	test("gives up on a sweep when the whole key pool is failing", async () => {
		universeIds = [1, 2, 3, 4, 5, 6, 7];
		failingDetailIds = new Set(universeIds);
		await db.insert(guildStockAlertConfigs).values({
			guildId: TEST_GUILD_ID,
			enabled: true,
			channelId: TEST_CHANNEL_ID,
			changeRules: [],
			highLowRanges: ["24h"],
			cooldownMinutes: 0,
		});

		const result = await runStockAlertCycle();

		expect(result.detailsFetched).toBe(0);
		// Five failures is the breaker: the last two stocks were never attempted.
		expect(detailRequests).toHaveLength(5);

		const rows = await db
			.select()
			.from(guildStockAlertStates)
			.where(eq(guildStockAlertStates.guildId, TEST_GUILD_ID));
		expect(rows).toHaveLength(0);
	});
});
