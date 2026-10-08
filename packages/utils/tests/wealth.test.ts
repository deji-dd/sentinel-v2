import { describe, expect, test } from "bun:test";
import {
	buildWealthCategoryBreakdown,
	buildWealthTimeline,
	classifyWealthLog,
	computeLedgerNetWorthChange,
	deriveOpeningBalances,
	readItemRefs,
	readNumber,
	startOfUtcDay,
	summariseWealth,
	type WealthClassifyContext,
	type WealthEvent,
	type WealthLogRow,
} from "../src/wealth";

/**
 * Coverage for the wealth engine.
 *
 * Every payload below is a real entry from the account's own `personal_logs`,
 * kept verbatim. They are the evidence for the rules that are easy to get quietly
 * wrong, and each one is annotated with what it proves:
 *
 *  - a bookie bet is a transfer to an account, not an expense
 *  - a trade draft edit is not a payment
 *  - high-low's `pot` on a round log is a running counter, not money
 *  - a poker hand "win" is already inside the cash-out
 *  - a faction transfer is written twice
 *  - prose in a money field must not become NaN
 */

const NO_PRICES: WealthClassifyContext = { itemPrices: new Map() };

/** Builds a personal log row in the envelope `personal_logs.data` stores. */
function row(
	id: string,
	logId: number,
	data: Record<string, unknown>,
	options?: { title?: string; category?: string; timestamp?: number },
): WealthLogRow {
	const timestamp = options?.timestamp ?? 1_790_000_000;
	return {
		id,
		log: logId,
		title: options?.title ?? null,
		timestamp: new Date(timestamp * 1000),
		data: {
			id,
			timestamp,
			data,
			params: {},
			details: {
				id: logId,
				title: options?.title ?? `Log ${logId}`,
				category: options?.category ?? "Test",
			},
		},
	};
}

function classify(
	logId: number,
	data: Record<string, unknown>,
	ctx: WealthClassifyContext = NO_PRICES,
) {
	return mustRow(row("test", logId, data), ctx);
}

/**
 * Classifies a row that must produce an event.
 *
 * The engine only returns null for a row it cannot read at all, so a null here
 * is a failure of the test's own fixture rather than a case to assert on.
 */
function mustRow(
	logRow: WealthLogRow,
	ctx: WealthClassifyContext = NO_PRICES,
): WealthEvent {
	const event = classifyWealthLog(logRow, ctx);
	if (!event) throw new Error(`log ${logRow.log} produced no event`);
	return event;
}

describe("payload reading", () => {
	test("a numeric string is a number, prose is not a zero", () => {
		expect(readNumber(895)).toBe(895);
		expect(readNumber("895.00")).toBe(895);
		// 5555 Subscription success really does carry this.
		expect(readNumber("4.00 GBP ($4.85)")).toBeNull();
		expect(readNumber("")).toBeNull();
		expect(readNumber(null)).toBeNull();
		expect(readNumber(Number.NaN)).toBeNull();
	});

	test("every item shape Torn uses is read", () => {
		// A bare id, with the quantity in a sibling field (1210, 2548, 5600).
		expect(readItemRefs(984, 20)).toEqual([
			{ itemId: "984", quantity: 20, uid: null },
		]);
		// A map of id to quantity (5530, 9020).
		expect(readItemRefs({ "707": 10, "1233": 1 }, null)).toEqual([
			{ itemId: "707", quantity: 10, uid: null },
			{ itemId: "1233", quantity: 1, uid: null },
		]);
		// An array of stacks (1302, 4446).
		expect(
			readItemRefs([{ id: 108, qty: 1, uid: 13_319_937_736 }], null),
		).toEqual([{ itemId: "108", quantity: 1, uid: 13_319_937_736 }]);
		// A single structured stack (4103).
		expect(
			readItemRefs({ id: 206, qty: 1, uid: 21_227_970_782 }, null),
		).toEqual([{ itemId: "206", quantity: 1, uid: 21_227_970_782 }]);
		// Uid 0 means "no unique id", not "uid zero" (1223).
		expect(readItemRefs([{ id: 727, qty: 1, uid: 0 }], null)).toEqual([
			{ itemId: "727", quantity: 1, uid: null },
		]);
		expect(readItemRefs(undefined, null)).toEqual([]);
	});
});

describe("the four effects", () => {
	test("buying an item at market is a swap, not a loss", () => {
		// 1220 Bazaar buy (legacy): 17 item 616 at 16,990 each.
		const event = classify(
			1220,
			{
				item: 616,
				seller: 2_998_518,
				quantity: 17,
				cost_each: 16_990,
				cost_total: 288_830,
			},
			{ itemPrices: new Map([["616", 16_990]]) },
		);
		expect(event?.walletDelta).toBe(-288_830);
		expect(event?.itemsInValue).toBe(288_830);
		expect(event?.netWorthDelta).toBe(0);
	});

	test("a bazaar sale is cash in minus the item that left", () => {
		// 1221 Bazaar sell (legacy): 21 item 984 at 1,326,989 each.
		const event = classify(
			1221,
			{
				item: 984,
				buyer: 1_823_867,
				quantity: 21,
				cost_each: 1_326_989,
				cost_total: 27_866_769,
			},
			{ itemPrices: new Map([["984", 1_326_989]]) },
		);
		expect(event?.walletDelta).toBe(27_866_769);
		expect(event?.itemsOutValue).toBe(27_866_769);
		expect(event?.netWorthDelta).toBe(0);
	});

	test("an item with no market price is unpriced, not worthless", () => {
		const event = classify(7011, { item: 533 });
		expect(event?.itemsIn).toEqual([{ itemId: "533", quantity: 1, uid: null }]);
		expect(event?.priced).toBe(false);
	});
});

describe("transfers are not expenses", () => {
	test("a bookie bet moves money to the bookie account, not out of net worth", () => {
		// 8460 Bookie bet: proved against the 2026-09-17 chain (bet, win, withdraw).
		const bet = classify(8460, {
			bet: 58_160_000,
			odds: "1.52",
			selection: [6_234_553, 1_158_573_565, 9_887_645_256],
		});
		expect(bet?.walletDelta).toBe(-58_160_000);
		expect(bet?.account).toBe("bookie");
		expect(bet?.accountDelta).toBe(58_160_000);
		expect(bet?.netWorthDelta).toBe(0);

		const win = classify(8462, {
			bet: 58_160_000,
			odds: "1.52",
			winnings: 88_403_200,
		});
		expect(win?.walletDelta).toBe(0);
		expect(win?.accountDelta).toBe(88_403_200);

		const withdraw = classify(8465, { withdrawn: 159_697_600 });
		expect(withdraw?.walletDelta).toBe(159_697_600);
		expect(withdraw?.accountDelta).toBe(-159_697_600);
		expect(withdraw?.netWorthDelta).toBe(0);
	});

	test("a losing bookie bet settles to nothing, because the stake already left", () => {
		const lose = classify(8461, {
			bet: 5_000_000,
			odds: "1.91",
			selection: [],
		});
		expect(lose?.walletDelta).toBe(0);
		expect(lose?.accountDelta).toBe(0);
		expect(lose?.netWorthDelta).toBe(0);
	});

	test("a vault deposit is cash out and account in", () => {
		const deposit = classify(5850, { deposited: 211_431_573 });
		expect(deposit?.walletDelta).toBe(-211_431_573);
		expect(deposit?.account).toBe("vault");
		expect(deposit?.accountDelta).toBe(211_431_573);
		expect(deposit?.netWorthDelta).toBe(0);
	});

	test("a company deposit names `deposited`, not `money`", () => {
		const deposit = classify(6284, {
			balance: 1,
			company: 90_288,
			deposited: 44_588_800,
		});
		expect(deposit?.walletDelta).toBe(-44_588_800);
		expect(deposit?.accountDelta).toBe(44_588_800);
	});

	test("the piggy bank names `deposited` too, and its `item` is the bank itself", () => {
		const deposit = classify(2380, {
			item: 820,
			faction: 0,
			deposited: 200_000,
		});
		expect(deposit?.walletDelta).toBe(-200_000);
		expect(deposit?.account).toBe("piggy");
		expect(deposit?.accountDelta).toBe(200_000);
		// The piggy bank is not stock moving.
		expect(deposit?.itemsOut).toEqual([]);
		expect(deposit?.priced).toBe(true);
	});
});

describe("the double-count traps", () => {
	test("adding money to a trade draft is not a payment", () => {
		// Trade 13364479: `4442 add 324,000,000`, then `4440 outgoing` 33s later.
		const draft = classify(4442, {
			user: 2_542_050,
			money: 324_000_000,
			total: 324_000_000,
			parsed_trade_id: 13_364_479,
		});
		expect(draft?.walletDelta).toBe(0);

		// Only the settlement moves money.
		const settled = classify(4440, { user: 2_542_050, money: 324_000_000 });
		expect(settled?.walletDelta).toBe(-324_000_000);
	});

	test("a received trade payment is cash in", () => {
		const received = classify(4441, { user: 2_430_598, money: 6_300_000_000 });
		expect(received?.walletDelta).toBe(6_300_000_000);
	});

	test("high-low round logs are counters, not money", () => {
		// A 2024-12-21 session bets 10 and the pot climbs 10, 12, 15, 18, 22 —
		// exactly the `pot_increase` values 2, 3, 3, 4. It is a running total.
		const start = classify(8310, { bet_amount: 10 });
		expect(start?.walletDelta).toBe(-10);

		const won = classify(8313, {
			pot: 33,
			round: 6,
			action: "high",
			result: "high",
			dealer_card: 10,
			player_card: 49,
			pot_increase: 6,
		});
		expect(won?.walletDelta).toBe(0);
		expect(won?.netWorthDelta).toBe(0);

		const cashedIn = classify(8314, { pot: 2_441_406, round: 4 });
		expect(cashedIn?.walletDelta).toBe(2_441_406);
	});

	test("a poker hand win is already inside the cash-out", () => {
		// The real pair: join 1,000,000, leave 1,007,500, and a 7,500 hand win.
		const join = classify(8410, { table: 8, value: 1_000_000 });
		expect(join?.walletDelta).toBe(-1_000_000);

		const handWin = classify(8435, { cards: "21, 46", table: 8, value: 7_500 });
		expect(handWin?.walletDelta).toBe(0);

		const leave = classify(8411, { table: 8, value: 1_007_500 });
		expect(leave?.walletDelta).toBe(1_007_500);
	});

	test("roulette has no separate bet log, so the win nets the stake", () => {
		const win = classify(8305, {
			result: 26,
			bet_type: 16,
			bet_amount: 1_000_000,
			won_amount: 2_000_000,
			bet_numbers: [],
		});
		expect(win?.walletDelta).toBe(1_000_000);

		const lose = classify(8306, {
			result: 29,
			bet_type: 16,
			bet_amount: 1_000_000,
		});
		expect(lose?.walletDelta).toBe(-1_000_000);
	});

	test("a stock sale uses `worth`, which is already net of fees", () => {
		// Gross 667,455,471 − fees 667,456 = `worth` 666,788,014. Torn's own
		// `profit` of 2,689,304 is a third figure and must not be added again.
		const sale = classify(5511, {
			fees: 667_456,
			price: "893.48",
			stock: 15,
			worth: 666_788_014,
			amount: 747_029,
			profit: 2_689_304,
		});
		expect(sale?.walletDelta).toBe(666_788_014);
	});

	test("the faction receive line carries the money, and the send line does not", () => {
		// `6735` means "I gave faction money to somebody" — the receiver can be any
		// member and the funds come out of the faction bank, which the player does
		// not own. `6736` is the receive line: either the player moved money from
		// the faction to themselves, or somebody gave them faction money. Booking
		// 6735 as a mirror of 6736 silenced every receipt.
		const given = mustRow(
			row("a", 6735, {
				faction: 2013,
				receiver: 2_108_464,
				money_given: 139_743_967,
			}),
		);
		expect(given.walletDelta).toBe(0);
		expect(given.accountDelta).toBe(0);
		expect(given.mirrored).toBe(false);
		// Not flagged either: it is a real event, it just is not the player's money.
		expect(given.priced).toBe(true);

		const received = mustRow(
			row("b", 6736, {
				sender: 1_934_909,
				faction: 2013,
				money_given: 59_000_000,
			}),
		);
		expect(received.walletDelta).toBe(59_000_000);
		expect(received.mirrored).toBe(false);

		// Both lines can appear for the same self-transfer, and only one of them
		// moves money, so the pair is counted once for value and twice for history.
		const totals = summariseWealth([given, received]);
		expect(totals.eventCount).toBe(2);
		expect(totals.walletNet).toBe(59_000_000);
	});

	test("the same construction holds for faction items", () => {
		const given = mustRow(
			row("a", 6732, { faction: 2013, receiver: 1_934_909, items: [] }),
		);
		expect(given.itemsIn).toEqual([]);
		expect(given.itemsOut).toEqual([]);

		const received = mustRow(
			row("b", 6733, {
				sender: 1_934_909,
				faction: 2013,
				item: [{ id: 1120, qty: 3, uid: null }],
			}),
		);
		expect(received.itemsIn).toEqual([
			{ itemId: "1120", quantity: 3, uid: null },
		]);
	});

	test("a payday receive carries money, because it is shaped like 6736", () => {
		// The discriminator is `balance_change`: 0 of 3,426 rows of 6736 and 0 of
		// 218 rows of 6811 have it, so both pay the player. Every one of the 60
		// rows of 6795 does, so that one credits a faction balance instead.
		const payday = mustRow(
			row("a", 6811, {
				sender: 1_934_909,
				faction: 2013,
				money_given: 15_000_000,
			}),
		);
		expect(payday.walletDelta).toBe(15_000_000);

		const payoutShare = mustRow(
			row("b", 6795, {
				role: "Robber",
				replay: 2_257_564,
				sender: 332_505,
				faction: 2013,
				percentage: 15,
				balance_before: 54_712_500,
				balance_after: 110_205_150,
				balance_change: 55_492_650,
			}),
		);
		expect(payoutShare.walletDelta).toBe(0);
		expect(payoutShare.accountDelta).toBe(0);
		expect(payoutShare.priced).toBe(false);
	});

	test("the genuine duplicate pair is still counted once", () => {
		// 6737 and 6738 fire in the same second with byte-identical payloads.
		const a = mustRow(
			row("a", 6737, {
				user: 1_934_909,
				faction: 2013,
				balance_after: 59_000_000,
				balance_before: 152_000_000,
			}),
		);
		const b = mustRow(
			row("b", 6738, {
				user: 1_934_909,
				faction: 2013,
				balance_after: 59_000_000,
				balance_before: 152_000_000,
			}),
		);
		expect(a.mirrored).toBe(false);
		expect(b.mirrored).toBe(true);
		expect(summariseWealth([a, b]).eventCount).toBe(1);
	});

	test("a faction deposit is a real wallet outflow", () => {
		// The faction balance is not an account the player owns, so this genuinely
		// leaves their wealth rather than moving inside it.
		const deposit = classify(6726, {
			faction: 2013,
			money_deposited: 152_000_000,
		});
		expect(deposit?.walletDelta).toBe(-152_000_000);
		expect(deposit?.account).toBeNull();
		expect(deposit?.netWorthDelta).toBe(-152_000_000);
	});

	test("faction balance-change feed is informational only", () => {
		const change = classify(6737, {
			user: 1_934_909,
			faction: 2013,
			balance_after: 59_000_000,
			balance_before: 152_000_000,
		});
		expect(change?.walletDelta).toBe(0);
		expect(change?.accountDelta).toBe(0);
		expect(change?.priced).toBe(false);
	});
});

describe("income and costs", () => {
	test("hunting is income minus cost, both sides read", () => {
		const hunt = classify(6020, {
			cost: 500,
			income: 8_385,
			session_type: "an advanced hunting session",
			hunting_skill: "60.6565",
			hunting_skill_gain: "and gained 0.0810 hunting skill",
		});
		expect(hunt?.walletDelta).toBe(7_885);
	});

	test("property upkeep falls back to `upkeep_due`", () => {
		expect(classify(5920, { upkeep_paid: 705_000 })?.walletDelta).toBe(
			-705_000,
		);
		expect(
			classify(5920, { upkeep_due: 705_000, property_id: 2_739_378 })
				?.walletDelta,
		).toBe(-705_000);
	});

	test("a subscription's prose value never becomes a number", () => {
		const event = classify(5555, {
			email: "hidden",
			value: "4.00 GBP ($4.85)",
			points: 75,
			service: "Amazon",
			frequency: "monthly",
			donator_days: 31,
		});
		expect(event?.walletDelta).toBe(0);
		expect(Number.isNaN(event?.netWorthDelta)).toBe(false);
		expect(event?.priced).toBe(false);
	});

	test("an unrecognised log type is recorded, not dropped", () => {
		const event = classify(999_999, { money: 500 });
		expect(event).not.toBeNull();
		expect(event?.unknownType).toBe(true);
		expect(event?.category).toBe("other");
		expect(event?.priced).toBe(false);
	});

	test("a known band with no rule is filed correctly and still unpriced", () => {
		// 4460 sits in the Trades band but has no rule of its own.
		const event = classify(4460, { money: 500 });
		expect(event?.unknownType).toBe(false);
		expect(event?.category).toBe("trades");
		expect(event?.priced).toBe(false);
	});
});

describe("points have a value", () => {
	// The points market price comes from the daily reference sync, which already
	// samples the top 5,000 points and stores a volume-weighted average.
	const WITH_POINTS = {
		...NO_PRICES,
		unitRates: new Map([["points", 31_000]]),
	};

	test("a refill costs what its points cost", () => {
		// 4900: 25 points for 145 energy. The payload carries the count, so the
		// cost is read rather than assumed.
		const event = mustRow(
			row("a", 4900, {
				faction: " ",
				points_used: 25,
				energy_increased: 145,
			}),
			WITH_POINTS,
		);
		expect(event.units).toEqual([{ unit: "points", quantity: -25 }]);
		expect(event.unitsValue).toBe(-775_000);
		expect(event.walletDelta).toBe(0);
		expect(event.netWorthDelta).toBe(-775_000);
		expect(event.priced).toBe(true);
	});

	test("a free refill costs nothing, because the payload says zero", () => {
		const event = mustRow(
			row("a", 4900, { faction: " ", points_used: 0, energy_increased: 150 }),
			WITH_POINTS,
		);
		expect(event.units).toEqual([]);
		expect(event.netWorthDelta).toBe(0);
	});

	test("without a price a refill is unpriced, not free", () => {
		// No rate means we do not know what the points were worth. Reporting a
		// zero would say the refill cost nothing.
		const event = mustRow(
			row("a", 4905, { faction: null, points_used: 25, nerve_increased: 53 }),
			NO_PRICES,
		);
		expect(event.units).toEqual([{ unit: "points", quantity: -25 }]);
		expect(event.priced).toBe(false);
	});

	test("every points unlock is the same shape", () => {
		const unlock = mustRow(
			row("a", 4950, {
				points_used: 250,
				merits_total: 340,
				merits_increased: 1,
			}),
			WITH_POINTS,
		);
		expect(unlock.unitsValue).toBe(-7_750_000);
		expect(unlock.priced).toBe(true);
	});

	test("buying points is a swap, not an expense", () => {
		// Sold at the market rate: cash out, points in, worth the same. Leaving the
		// points side at zero made buying points look like a total loss.
		const bought = mustRow(
			row("a", 5010, {
				seller: 1,
				quantity: 100,
				cost_each: 31_000,
				cost_total: 3_100_000,
			}),
			WITH_POINTS,
		);
		expect(bought.walletDelta).toBe(-3_100_000);
		expect(bought.unitsValue).toBe(3_100_000);
		expect(bought.netWorthDelta).toBe(0);

		const sold = mustRow(
			row("b", 5011, {
				buyer: 1,
				quantity: 100,
				cost_each: 31_000,
				cost_total: 3_100_000,
			}),
			WITH_POINTS,
		);
		expect(sold.walletDelta).toBe(3_100_000);
		expect(sold.unitsValue).toBe(-3_100_000);
		expect(sold.netWorthDelta).toBe(0);
	});

	test("earning points is valued the same way spending them is", () => {
		// Otherwise points would only ever cost the ledger money.
		const gained = mustRow(
			row("a", 9025, { points_gained: 10, nerve: 3, crime_action: "x" }),
			WITH_POINTS,
		);
		expect(gained.unitsValue).toBe(310_000);
		expect(gained.netWorthDelta).toBe(310_000);
	});

	test("points spent and earned net out over the same price", () => {
		const spent = mustRow(
			row("a", 4900, { points_used: 25, energy_increased: 145 }),
			WITH_POINTS,
		);
		const earned = mustRow(
			row("b", 9025, { points_gained: 25, nerve: 3, crime_action: "x" }),
			WITH_POINTS,
		);
		expect(summariseWealth([spent, earned]).netWorthDelta).toBe(0);
	});
});

describe("aggregation", () => {
	test("live and backfilled rows produce the same event", () => {
		// The live stream hands the classifier the parsed log object; the backfill
		// hands it the stored row. Both must classify identically or the two paths
		// silently disagree.
		const payload = { money: 5_000, sender: 4_499_095, anonymous: 0 };
		const stored = classifyWealthLog(
			row("same", 4810, payload, {
				title: "Money receive",
				category: "Money sending",
			}),
			NO_PRICES,
		);
		const live = classifyWealthLog(
			{
				id: "same",
				log: 4810,
				title: "Money receive",
				timestamp: new Date(1_790_000_000 * 1000),
				data: {
					id: "same",
					details: {
						id: 4810,
						title: "Money receive",
						category: "Money sending",
					},
					data: payload,
					params: {},
					timestamp: 1_790_000_000,
				},
			},
			NO_PRICES,
		);
		expect(live).toEqual(stored);
		expect(stored?.walletDelta).toBe(5_000);
	});

	test("a timeline buckets by UTC day and a mirrored row is excluded", () => {
		const events = [
			mustRow(row("a", 4810, { money: 100 }, { timestamp: 1_790_000_000 })),
			mustRow(row("b", 4800, { money: 40 }, { timestamp: 1_790_000_100 })),
			// A genuine duplicate: 6738 is the redundant half of the 6737/6738 pair.
			mustRow(
				row(
					"c",
					6738,
					{ user: 1_934_909, balance_before: 1, balance_after: 2 },
					{ timestamp: 1_790_000_200 },
				),
			),
		];
		const timeline = buildWealthTimeline(events);
		expect(timeline).toHaveLength(1);
		expect(timeline[0]?.walletIn).toBe(100);
		expect(timeline[0]?.walletOut).toBe(40);
		expect(timeline[0]?.walletNet).toBe(60);
		expect(timeline[0]?.events).toBe(2);
	});

	test("totals separate priced from unpriced rather than zeroing", () => {
		const events = [
			mustRow(row("a", 4810, { money: 1_000 })),
			mustRow(row("b", 7011, { item: 533 })),
		];
		const totals = summariseWealth(events);
		expect(totals.walletIn).toBe(1_000);
		expect(totals.pricedEvents).toBe(1);
		expect(totals.unpricedEvents).toBe(1);
		expect(totals.netWorthDelta).toBe(1_000);
		// The unpriced event moved an unknown amount, and says so.
		expect(totals.unpricedEvents).toBeGreaterThan(0);
	});

	test("the category breakdown groups and orders by magnitude", () => {
		const events = [
			mustRow(row("a", 4810, { money: 1_000 })),
			mustRow(row("b", 4800, { money: 50_000 })),
		];
		const breakdown = buildWealthCategoryBreakdown(events);
		expect(breakdown).toHaveLength(1);
		expect(breakdown[0]?.category).toBe("bank");
		expect(breakdown[0]?.walletNet).toBe(-49_000);
	});

	test("net worth change ignores mirrored rows", () => {
		const events = [
			mustRow(row("a", 4810, { money: 500 })),
			mustRow(
				row("b", 6738, {
					user: 1_934_909,
					balance_before: 0,
					balance_after: 9_999,
				}),
			),
		];
		expect(computeLedgerNetWorthChange(events)).toBe(500);
	});
});

describe("the 00:00 UTC anchor", () => {
	test("startOfUtcDay is midnight UTC, not midnight local", () => {
		const midAfternoon = new Date("2026-10-08T21:47:13.000Z");
		expect(startOfUtcDay(midAfternoon)).toBe(
			Math.floor(Date.UTC(2026, 9, 8) / 1000),
		);
		// One second past midnight is still that same day.
		expect(startOfUtcDay(new Date("2026-10-08T00:00:01.000Z"))).toBe(
			Math.floor(Date.UTC(2026, 9, 8) / 1000),
		);
	});

	test("opening balances unwind the day's activity so it is not counted twice", () => {
		// The account already earned 1,000 and spent 250 since midnight, and the
		// observed wallet already includes both. Recording the observation as day
		// zero would count them a second time when the events are replayed.
		const events = [
			mustRow(row("a", 4810, { money: 1_000 })),
			mustRow(row("b", 4800, { money: 250 })),
		];
		const opening = deriveOpeningBalances({
			observedWallet: 10_750,
			observedHoldingsValue: 0,
			observedAccounts: { vault: 5_000 },
			todayEvents: events,
		});
		expect(opening.wallet).toBe(10_000);

		// And the anchor plus the events reproduces the observation exactly.
		expect(opening.wallet + summariseWealth(events).walletNet).toBe(10_750);
	});

	test("a vault deposit since midnight is unwound from the vault, not the wallet", () => {
		const events = [mustRow(row("a", 5850, { deposited: 2_000 }))];
		const opening = deriveOpeningBalances({
			observedWallet: 8_000,
			observedHoldingsValue: 0,
			observedAccounts: { vault: 7_000 },
			todayEvents: events,
		});
		expect(opening.wallet).toBe(10_000);
		expect(opening.accounts.vault).toBe(5_000);
	});
});
