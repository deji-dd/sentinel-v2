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
	inArray,
	subversiveStockAlertConfigs,
	subversiveStockAlertStates,
	subversiveTargetFinderUsers,
} from "@sentinel/database";
import type { IpcMessage } from "@sentinel/schemas";
import {
	DEFAULT_SUBVERSIVE_STOCK_ALERT_CONFIG,
	type StockAlertEvent,
	type StockAlertState,
	type SubversiveStockAlertConfig,
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

const NOW_MS = 1_800_000_000_000; // fixed instant: every figure below is relative to it

/** Test key enrolled in the Subversive pool so key acquisition always succeeds. */
const TEST_KEY_TORN_ID = 9_000_001;
const TEST_KEY = "abcdefghijklmnop";

const TEST_FACTION_ID = 2013;
const TEST_CHANNEL_ID = "111111111111111111";

function config(
	patch: Partial<SubversiveStockAlertConfig> = {},
): SubversiveStockAlertConfig {
	return { ...DEFAULT_SUBVERSIVE_STOCK_ALERT_CONFIG, ...patch };
}

function snapshot(patch: Partial<StockAlertSnapshot> = {}): StockAlertSnapshot {
	return {
		stockId: 1,
		name: "Torn & Shanghai Banking",
		acronym: "TSB",
		price: 1000,
		performance: {
			"24h": { changePct: 0, start: 1000, high: 1010, low: 990 },
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
				config: config({ changeRules: [], highLowWindows: ["24h"] }),
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
				config: config({ changeRules: [], highLowWindows: ["all_time"] }),
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
				config: config({ changeRules: [], highLowWindows: ["24h"] }),
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
				config: config({ changeRules: [], highLowWindows: ["24h"] }),
				state: seededState(),
				nowMs: NOW_MS,
			});

			expect(events).toHaveLength(1);
			expect((events[0] as StockAlertEvent).alertKey).toBe("high:24h");
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

	beforeAll(async () => {
		await db
			.delete(subversiveTargetFinderUsers)
			.where(eq(subversiveTargetFinderUsers.tornId, TEST_KEY_TORN_ID));
		await db.insert(subversiveTargetFinderUsers).values({
			tornId: TEST_KEY_TORN_ID,
			tornName: "Stock Alert Test Key",
			apiKeyEncrypted: TEST_KEY,
			apiKeyHash: `test-hash-${TEST_KEY_TORN_ID}`,
			isActive: true,
		});
	});

	afterAll(async () => {
		await db
			.delete(subversiveTargetFinderUsers)
			.where(eq(subversiveTargetFinderUsers.tornId, TEST_KEY_TORN_ID));
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
			.delete(subversiveStockAlertStates)
			.where(eq(subversiveStockAlertStates.factionId, TEST_FACTION_ID));
		await db
			.delete(subversiveStockAlertConfigs)
			.where(eq(subversiveStockAlertConfigs.factionId, TEST_FACTION_ID));

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
		await db.insert(subversiveStockAlertConfigs).values({
			factionId: TEST_FACTION_ID,
			enabled: true,
			channelId: null,
			changeRules: [{ windowMinutes: 5, thresholdPct: 0.5 }],
			highLowWindows: ["24h"],
			cooldownMinutes: 0,
		});

		const result = await runStockAlertCycle();

		expect(result.stocksPolled).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test("seeds baselines on the first cycle and alerts on a later move", async () => {
		await db.insert(subversiveStockAlertConfigs).values({
			factionId: TEST_FACTION_ID,
			enabled: true,
			channelId: TEST_CHANNEL_ID,
			changeRules: [],
			highLowWindows: ["24h", "all_time"],
			cooldownMinutes: 0,
		});

		const first = await runStockAlertCycle();
		expect(first.stocksPolled).toBe(1);
		expect(first.detailsFetched).toBe(1);
		expect(first.alertsQueued).toBe(0);
		expect(broadcasts).toEqual([]);

		const seeded = await db.query.subversiveStockAlertStates.findFirst({
			where: eq(subversiveStockAlertStates.factionId, TEST_FACTION_ID),
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
		await db.insert(subversiveStockAlertConfigs).values({
			factionId: TEST_FACTION_ID,
			enabled: true,
			channelId: TEST_CHANNEL_ID,
			changeRules: [],
			highLowWindows: ["24h"],
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
		await db.insert(subversiveStockAlertConfigs).values({
			factionId: TEST_FACTION_ID,
			enabled: true,
			channelId: TEST_CHANNEL_ID,
			changeRules: [],
			highLowWindows: ["24h", "all_time"],
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

	test("merges two factions sharing a channel into a single delivery", async () => {
		await db.insert(subversiveStockAlertConfigs).values([
			{
				factionId: 2013,
				enabled: true,
				channelId: TEST_CHANNEL_ID,
				changeRules: [],
				highLowWindows: ["24h", "all_time"],
				cooldownMinutes: 0,
			},
			{
				factionId: 27312,
				enabled: true,
				channelId: TEST_CHANNEL_ID,
				changeRules: [],
				highLowWindows: ["24h", "all_time"],
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

			expect(broadcasts).toHaveLength(1);
			const payload = broadcasts[0];
			if (payload?.action !== "subversive_stock_alerts") {
				throw new Error("Expected a stock alert broadcast");
			}
			// Both factions raised the same two extremes; the shared channel gets
			// one embed per event, not one per faction.
			expect(payload.data.alerts).toHaveLength(2);
			expect(second.channelsNotified).toBe(1);

			const rows = await db
				.select()
				.from(subversiveStockAlertStates)
				.where(inArray(subversiveStockAlertStates.factionId, [2013, 27312]));
			expect(rows).toHaveLength(2);
		} finally {
			await db
				.delete(subversiveStockAlertStates)
				.where(inArray(subversiveStockAlertStates.factionId, [2013, 27312]));
			await db
				.delete(subversiveStockAlertConfigs)
				.where(inArray(subversiveStockAlertConfigs.factionId, [2013, 27312]));
		}
	});

	test("skips an unreachable stock without losing the rest of the sweep", async () => {
		universeIds = [1, 2];
		failingDetailIds = new Set([1]);
		await db.insert(subversiveStockAlertConfigs).values({
			factionId: TEST_FACTION_ID,
			enabled: true,
			channelId: TEST_CHANNEL_ID,
			changeRules: [],
			highLowWindows: ["24h"],
			cooldownMinutes: 0,
		});

		const result = await runStockAlertCycle();

		expect(result.stocksPolled).toBe(2);
		expect(result.detailsFetched).toBe(1);

		const rows = await db
			.select()
			.from(subversiveStockAlertStates)
			.where(eq(subversiveStockAlertStates.factionId, TEST_FACTION_ID));
		// Only the healthy stock was recorded; the failing one keeps its previous
		// state so the next cycle retries its detailed fetch.
		expect(rows.map((row) => row.stockId)).toEqual([2]);
	});

	test("gives up on a sweep when the whole key pool is failing", async () => {
		universeIds = [1, 2, 3, 4, 5, 6, 7];
		failingDetailIds = new Set(universeIds);
		await db.insert(subversiveStockAlertConfigs).values({
			factionId: TEST_FACTION_ID,
			enabled: true,
			channelId: TEST_CHANNEL_ID,
			changeRules: [],
			highLowWindows: ["24h"],
			cooldownMinutes: 0,
		});

		const result = await runStockAlertCycle();

		expect(result.detailsFetched).toBe(0);
		// Five failures is the breaker: the last two stocks were never attempted.
		expect(detailRequests).toHaveLength(5);

		const rows = await db
			.select()
			.from(subversiveStockAlertStates)
			.where(eq(subversiveStockAlertStates.factionId, TEST_FACTION_ID));
		expect(rows).toHaveLength(0);
	});
});
