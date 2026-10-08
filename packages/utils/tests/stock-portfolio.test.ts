import { describe, expect, test } from "bun:test";
import { catalogStock, STOCK_CATALOG } from "../src/stock-catalog";
import {
	buildBenefitProgress,
	computeStockPortfolio,
	lotsForHeldShares,
	normalizeStockLog,
	readTransactionLots,
	replayStockEvents,
	resolveStockBenefit,
	type StockEvent,
	type StockLogRow,
	type StockPortfolioInput,
} from "../src/stock-portfolio";

/**
 * Coverage for the current-term stock portfolio engine.
 *
 * These tests are the specification of the two things that are easy to get
 * quietly wrong: what a "term" is (so a holding that was closed and reopened does
 * not inherit the previous term's cost basis or dividends), and what a dash means
 * (an unpriceable benefit must never be silently counted as zero).
 */

const DAY = 86_400;

/** Builds a personal log row in the envelope shape the API stores. */
function log(
	id: string,
	logId: number,
	timestampSeconds: number,
	data: Record<string, unknown>,
): StockLogRow {
	return {
		id,
		log: logId,
		timestamp: timestampSeconds,
		data: { id, timestamp: timestampSeconds, details: { id: logId }, data },
	};
}

function eventsOf(rows: StockLogRow[]): StockEvent[] {
	const events: StockEvent[] = [];
	for (const row of rows) {
		const event = normalizeStockLog(row);
		if (event) events.push(event);
	}
	return events;
}

describe("normalizeStockLog", () => {
	test("reads buys, sells, splits and merges including Torn's realised profit", () => {
		const buy = normalizeStockLog(
			log("b1", 5510, 1000, {
				stock: 15,
				amount: 2_000_000,
				worth: 1_400_000_000,
				price: "700",
			}),
		);
		expect(buy).toMatchObject({
			kind: "buy",
			stockId: 15,
			shares: 2_000_000,
			worth: 1_400_000_000,
			price: 700,
		});

		const sell = normalizeStockLog(
			log("s1", 5511, 2000, {
				stock: 15,
				amount: 2_000_000,
				worth: 1_500_000_000,
				price: "750",
				fees: 1_500_000,
				profit: 98_500_000,
			}),
		);
		expect(sell).toMatchObject({
			kind: "sell",
			profit: 98_500_000,
			fees: 1_500_000,
		});

		expect(
			normalizeStockLog(log("sp", 5520, 3000, { stock: 17, amount: 22_634 })),
		).toMatchObject({
			kind: "split",
			shares: 22_634,
		});
		expect(
			normalizeStockLog(log("mg", 5521, 3001, { stock: 6, amount: 263_568 })),
		).toMatchObject({
			kind: "merge",
		});
	});

	test("reads all three item payload shapes Torn has shipped", () => {
		const asMap = normalizeStockLog(
			log("i1", 5530, 10, { stock: 16, item: { "370": 1 } }),
		);
		expect(asMap).toMatchObject({
			kind: "dividend",
			payment: { kind: "item", itemId: 370, quantity: 1 },
		});

		const asId = normalizeStockLog(
			log("i2", 5530, 11, { stock: 17, item: 369 }),
		);
		expect(asId).toMatchObject({
			payment: { kind: "item", itemId: 369, quantity: 1 },
		});

		const asObject = normalizeStockLog(
			log("i3", 5530, 12, { stock: 31, item: { id: 1_112, quantity: 2 } }),
		);
		expect(asObject).toMatchObject({
			payment: { kind: "item", itemId: 1_112, quantity: 2 },
		});
	});

	test("reads money and each resource dividend", () => {
		expect(
			normalizeStockLog(log("m", 5531, 20, { stock: 9, money: 1_000_000 })),
		).toMatchObject({
			payment: { kind: "cash", amount: 1_000_000 },
		});
		expect(
			normalizeStockLog(
				log("e", 5535, 21, { stock: 29, energy_increased: 100 }),
			),
		).toMatchObject({
			payment: { kind: "resource", unit: "energy", quantity: 100 },
		});
		expect(
			normalizeStockLog(
				log("h", 5534, 22, { stock: 28, happy_increased: 1000 }),
			),
		).toMatchObject({
			payment: { kind: "resource", unit: "happy", quantity: 1000 },
		});
		expect(
			normalizeStockLog(log("n", 5536, 23, { stock: 33, nerve_increased: 50 })),
		).toMatchObject({
			payment: { kind: "resource", unit: "nerve", quantity: 50 },
		});
	});

	test("ignores logs that are not stock events", () => {
		expect(normalizeStockLog(log("c", 9010, 5, { crime: 1 }))).toBeNull();
		expect(normalizeStockLog(log("x", 5510, 5, { amount: 10 }))).toBeNull();
	});
});

describe("replayStockEvents — the term is the open holding period", () => {
	const rows: StockLogRow[] = [
		log("b1", 5510, 1_700_000_000, {
			stock: 15,
			amount: 2_000_000,
			worth: 1_400_000_000,
			price: "700",
		}),
		log("d1", 5530, 1_700_000_000 + 7 * DAY, { stock: 15, item: { "367": 1 } }),
		log("d2", 5530, 1_700_000_000 + 14 * DAY, {
			stock: 15,
			item: { "367": 1 },
		}),
		log("s1", 5511, 1_700_000_000 + 21 * DAY, {
			stock: 15,
			amount: 2_000_000,
			worth: 1_500_000_000,
			price: "750",
			fees: 1_500_000,
			profit: 98_500_000,
		}),
		// The re-buy: a new term, and the old dividends must not follow it.
		log("b2", 5510, 1_750_000_000, {
			stock: 15,
			amount: 1_000_000,
			worth: 900_000_000,
			price: "900",
		}),
		log("d3", 5530, 1_750_000_000 + 7 * DAY, { stock: 15, item: { "367": 1 } }),
	];

	const options = {
		asOfSeconds: 1_750_000_000 + 9 * DAY,
		recordedDividendValues: new Map([
			["d1", 5_000_000],
			["d2", 5_000_000],
			["d3", 5_500_000],
		]),
		rates: { energy: 0, nerve: 0, happy: 0, points: 0 },
		itemPricesById: new Map<number, number>(),
		itemNamesById: new Map<number, string>([[367, "Feathery Hotel Coupon"]]),
	};

	test("keeps only the open term's cost basis, dividends and sales", () => {
		const replay = replayStockEvents(eventsOf(rows), options);

		expect(replay.termStart).toBe(1_750_000_000);
		expect(replay.shares).toBe(1_000_000);
		expect(replay.invested).toBe(900_000_000);
		expect(replay.costBasis).toBe(900_000_000);
		expect(replay.realized).toBe(0);
		// One dividend since the re-buy; the two from the closed term stay behind.
		expect(replay.dividends).toHaveLength(1);
	});

	test("banks the closed term separately", () => {
		const replay = replayStockEvents(eventsOf(rows), options);

		expect(replay.dividends).toHaveLength(1);
		expect(replay.dividends[0]?.value).toBe(5_500_000);
		expect(replay.sells).toHaveLength(0);
		expect(replay.orphanDividendCount).toBe(0);

		expect(replay.previousTerm).not.toBeNull();
		expect(replay.previousTerm?.start).toBe(1_700_000_000);
		expect(replay.previousTerm?.invested).toBe(1_400_000_000);
		// Realised 98.5M plus the two coupons collected while it was open.
		expect(replay.previousTerm?.profit).toBe(108_500_000);
		expect(replay.previousTerm?.roiPct).toBeCloseTo(
			(108_500_000 / 1_400_000_000) * 100,
			6,
		);
	});

	test("average cost accounting on a partial sale", () => {
		const partial = eventsOf([
			log("pb", 5510, 1_000, {
				stock: 16,
				amount: 1_000_000,
				worth: 500_000_000,
				price: "500",
			}),
			log("ps", 5511, 2_000, {
				stock: 16,
				amount: 400_000,
				worth: 220_000_000,
				price: "550",
				fees: 220_000,
				profit: null,
			}),
		]);
		const replay = replayStockEvents(partial, {
			...options,
			recordedDividendValues: new Map(),
		});

		// 400k of 1M sold at an average cost of $500 removes $200M of basis.
		expect(replay.shares).toBe(600_000);
		expect(replay.costBasis).toBe(300_000_000);
		expect(replay.sells[0]?.fromLog).toBe(false);
		// Derived: proceeds − fees − cost removed.
		expect(replay.sells[0]?.realized).toBeCloseTo(
			220_000_000 - 220_000 - 200_000_000,
			6,
		);
		expect(replay.previousTerm).toBeNull();
	});
});

describe("lotsForHeldShares", () => {
	test("keeps the most recent purchases when the log cannot explain the position", () => {
		const lots = readTransactionLots([
			{ shares: 1_000_000, price: 100, timestamp: 1_000 },
			{ shares: 1_000_000, price: 200, timestamp: 2_000 },
		]);
		expect(lots).toHaveLength(2);

		const held = lotsForHeldShares(lots, 1_000_000);
		expect(held.completed).toBe(true);
		expect(held.costBasis).toBe(200_000_000);
		expect(held.lots[0]?.price).toBe(200);
	});

	test("uses every lot when the purchases are exactly the position", () => {
		const lots = readTransactionLots([
			{ shares: 500_000, price: 300, timestamp: 1_000 },
			{ shares: 500_000, price: 400, timestamp: 2_000 },
		]);
		const held = lotsForHeldShares(lots, 1_000_000);
		expect(held.costBasis).toBe(350_000_000);
		expect(held.completed).toBe(true);
	});
});

describe("replayStockEvents — splits and merges report the resulting total", () => {
	/**
	 * Real shape from a live account (stock 17, December 2018): a merge and a split
	 * of the same block, where each log carries the share count AFTER the move.
	 * Reading them as deltas is what made four real positions impossible to
	 * reconcile, one of them off by 1.2 million shares.
	 */
	const rows: StockLogRow[] = [
		log("m1", 5521, 1_000, { stock: 17, amount: 199_110 }),
		log("m2", 5521, 1_100, { stock: 17, amount: 499_110 }),
		log("b1", 5510, 1_200, {
			stock: 17,
			amount: 890,
			worth: 500_000,
			price: "561.8",
		}),
		log("s1", 5520, 1_300, { stock: 17, amount: 7_936 }),
	];

	test("assigns the reported total instead of adding or subtracting it", () => {
		const replay = replayStockEvents(eventsOf(rows), {
			asOfSeconds: 2_000,
			recordedDividendValues: new Map(),
			rates: { energy: 0, nerve: 0, happy: 0, points: 0 },
			itemPricesById: new Map(),
			itemNamesById: new Map(),
		});

		// 199,110 → 499,110 → +890 → then the split takes it back to 7,936.
		expect(replay.shares).toBe(7_936);
		expect(replay.adjustedBySplitOrMerge).toBe(true);
		// Only the buy is cash. The shares the merges produced carry no basis, so the
		// average cost is diluted and the replay says so rather than reporting a gain.
		expect(replay.invested).toBe(500_000);
		expect(replay.basisIncomplete).toBe(true);
	});

	test("preserves the average cost per share rather than inventing a gain", () => {
		const bought = eventsOf([
			log("b1", 5510, 1_000, {
				stock: 1,
				amount: 1_000,
				worth: 1_000_000,
				price: "1000",
			}),
			log("m1", 5521, 1_100, { stock: 1, amount: 2_000 }),
			log("s1", 5520, 1_200, { stock: 1, amount: 1_000 }),
		]);
		const replay = replayStockEvents(bought, {
			asOfSeconds: 2_000,
			recordedDividendValues: new Map(),
			rates: { energy: 0, nerve: 0, happy: 0, points: 0 },
			itemPricesById: new Map(),
			itemNamesById: new Map(),
		});

		// Doubled to 2,000 shares and halved back to 1,000: the basis tracks the
		// count, so nothing was realised and nothing was gifted.
		expect(replay.shares).toBe(1_000);
		expect(replay.costBasis).toBe(1_000_000);
		expect(replay.invested).toBe(1_000_000);
		expect(replay.realized).toBe(0);
		expect(replay.basisIncomplete).toBe(false);
	});

	test("flags shares that appeared with no purchase behind them", () => {
		const replay = replayStockEvents(
			eventsOf([log("m1", 5521, 1_000, { stock: 17, amount: 500_000 })]),
			{
				asOfSeconds: 2_000,
				recordedDividendValues: new Map(),
				rates: { energy: 0, nerve: 0, happy: 0, points: 0 },
				itemPricesById: new Map(),
				itemNamesById: new Map(),
			},
		);

		expect(replay.shares).toBe(500_000);
		expect(replay.costBasis).toBe(0);
		expect(replay.basisIncomplete).toBe(true);
	});

	test("reads pre-2018 listing logs as buys and sales", () => {
		expect(
			normalizeStockLog(
				log("l1", 5500, 1_000, {
					stock: 17,
					amount: 100_000,
					worth: 31_967_700,
				}),
			),
		).toMatchObject({ kind: "buy", shares: 100_000, worth: 31_967_700 });
		expect(
			normalizeStockLog(
				log("l2", 5501, 1_100, {
					stock: 6,
					amount: 500_000,
					worth: 100_112_000,
				}),
			),
		).toMatchObject({ kind: "sell", shares: 500_000, worth: 100_112_000 });
	});
});

describe("computeStockPortfolio", () => {
	const referenceStocks = [
		{
			stockId: 15,
			name: "Feathery Hotels Group",
			acronym: "FHG",
			price: 950,
			requirementShares: 2_000_000,
			passive: false,
			frequencyDays: 7,
			description: "1x Feathery Hotel Coupon",
		},
		{
			stockId: 29,
			name: "Mc Smoogle Corp",
			acronym: "MCS",
			price: 800,
			requirementShares: 350_000,
			passive: false,
			frequencyDays: 7,
			description: "100 energy",
		},
	];

	function input(
		overrides: Partial<StockPortfolioInput> = {},
	): StockPortfolioInput {
		const rows: StockLogRow[] = [
			log("b1", 5510, 1_750_000_000, {
				stock: 15,
				amount: 1_000_000,
				worth: 900_000_000,
				price: "900",
			}),
			log("d1", 5530, 1_750_000_000 + 7 * DAY, {
				stock: 15,
				item: { "367": 1 },
			}),
		];
		return {
			asOfSeconds: 1_750_000_000 + 10 * DAY,
			holdings: [
				{
					stockId: 15,
					shares: 1_000_000,
					transactions: [
						{ shares: 1_000_000, price: 900, timestamp: 1_750_000_000 },
					],
					bonus: { available: false, increment: 0, progress: 3, frequency: 7 },
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
			events: eventsOf(rows),
			recordedDividendValues: new Map([["d1", 5_000_000]]),
			stocks: referenceStocks,
			rates: { energy: 0, nerve: 0, happy: 0, points: 0 },
			itemPricesById: new Map<number, number>([[367, 5_200_000]]),
			itemPricesByName: new Map<string, number>(),
			itemNamesById: new Map<number, string>([[367, "Feathery Hotel Coupon"]]),
			positionAsOfIso: "2026-01-01T00:00:00.000Z",
			pricesAsOfIso: "2026-01-01T00:00:00.000Z",
			...overrides,
		};
	}

	test("marks an item dividend to the recorded value and the position to market", () => {
		const portfolio = computeStockPortfolio(input());
		const holding = portfolio.holdings[0];

		expect(holding).toBeDefined();
		expect(holding?.reconciliation.source).toBe("logs");
		expect(holding?.reconciliation.reconciled).toBe(true);
		expect(holding?.term.invested).toBe(900_000_000);
		expect(holding?.term.dividendsValue).toBe(5_000_000);
		expect(holding?.marketValue).toBe(950_000_000);
		expect(holding?.unrealized).toBe(50_000_000);
		expect(holding?.profit).toBe(55_000_000);
		expect(holding?.roiPct).toBeCloseTo((55_000_000 / 900_000_000) * 100, 6);
		// Ten days of holding is long enough to annualise, and the figure is loud.
		expect(holding?.annualizedRoiPct).toBeCloseTo(
			((1 + 55_000_000 / 900_000_000) ** (365 / 10) - 1) * 100,
			6,
		);
		expect(holding?.annualizedNote).toBeUndefined();

		expect(portfolio.totals.invested).toBe(900_000_000);
		expect(portfolio.totals.dividendsValue).toBe(5_000_000);
		expect(portfolio.totals.roiPct).toBeCloseTo(
			(55_000_000 / 900_000_000) * 100,
			6,
		);
		expect(portfolio.totals.pricedRoiPct).toBe(portfolio.totals.roiPct);
		expect(portfolio.totals.unpricedHoldingsCount).toBe(0);
	});

	test("leaves a resource dividend unpriced rather than counting it as zero", () => {
		const rows: StockLogRow[] = [
			log("mb", 5510, 1_750_000_000, {
				stock: 29,
				amount: 350_000,
				worth: 280_000_000,
				price: "800",
			}),
			log("md", 5535, 1_750_000_000 + 7 * DAY, {
				stock: 29,
				energy_increased: 100,
			}),
		];
		const portfolio = computeStockPortfolio(
			input({
				holdings: [
					{
						stockId: 29,
						shares: 350_000,
						transactions: [
							{ shares: 350_000, price: 800, timestamp: 1_750_000_000 },
						],
						bonus: {
							available: false,
							increment: 1,
							progress: 2,
							frequency: 7,
						},
						updatedAt: null,
					},
				],
				events: eventsOf(rows),
				recordedDividendValues: new Map(),
			}),
		);

		const holding = portfolio.holdings[0];
		expect(holding?.benefit.valuation.kind).toBe("resource");
		expect(holding?.benefit.valuation.priced).toBe(false);
		expect(holding?.benefit.valuation.valuePerCycle).toBe(0);
		expect(holding?.term.dividendsValue).toBe(0);
		expect(holding?.term.dividendsUnpriced).toBe(1);
		expect(holding?.warnings.some((w) => w.includes("no energy rate"))).toBe(
			true,
		);
		expect(portfolio.totals.unpricedHoldingsCount).toBe(1);
		expect(portfolio.warnings.some((w) => w.includes("no dollar value"))).toBe(
			true,
		);
		expect(portfolio.totals.forwardAnnualIncome).toBe(0);
	});

	test("prices a resource dividend once a rate is supplied", () => {
		const rows: StockLogRow[] = [
			log("mb", 5510, 1_750_000_000, {
				stock: 29,
				amount: 350_000,
				worth: 280_000_000,
				price: "800",
			}),
			log("md", 5535, 1_750_000_000 + 7 * DAY, {
				stock: 29,
				energy_increased: 100,
			}),
		];
		const portfolio = computeStockPortfolio(
			input({
				holdings: [
					{
						stockId: 29,
						shares: 350_000,
						transactions: [
							{ shares: 350_000, price: 800, timestamp: 1_750_000_000 },
						],
						bonus: {
							available: false,
							increment: 1,
							progress: 2,
							frequency: 7,
						},
						updatedAt: null,
					},
				],
				events: eventsOf(rows),
				recordedDividendValues: new Map(),
				rates: { energy: 4_000, nerve: 0, happy: 0, points: 0 },
			}),
		);

		const holding = portfolio.holdings[0];
		expect(holding?.benefit.valuation.priced).toBe(true);
		// 100 energy at $4,000, paid every 7 days.
		expect(holding?.benefit.valuation.valuePerCycle).toBe(400_000);
		expect(holding?.term.dividendsValue).toBe(400_000);
		expect(portfolio.totals.unpricedHoldingsCount).toBe(0);
		// One block a week, annualised against a $280M position.
		expect(portfolio.totals.forwardAnnualIncome).toBeCloseTo(
			400_000 * (365 / 7),
			3,
		);
	});

	test("falls back to Torn's purchase list when the log cannot explain the position", () => {
		const portfolio = computeStockPortfolio(
			input({
				holdings: [
					{
						stockId: 15,
						shares: 1_000_000,
						transactions: [
							{ shares: 1_000_000, price: 100, timestamp: 1_600_000_000 },
							{ shares: 1_000_000, price: 200, timestamp: 1_700_000_000 },
						],
						bonus: null,
						updatedAt: null,
					},
				],
				events: [],
			}),
		);

		const holding = portfolio.holdings[0];
		expect(holding?.reconciliation.source).toBe("transactions");
		expect(holding?.term.invested).toBe(200_000_000);
		expect(holding?.term.realized).toBe(0);
		expect(holding?.term.start).toBe(1_700_000_000);
		expect(holding?.roiPct).toBeCloseTo(
			((950_000_000 - 200_000_000) / 200_000_000) * 100,
			6,
		);
	});

	test("reports a position it cannot explain at all without inventing a basis", () => {
		const portfolio = computeStockPortfolio(
			input({
				holdings: [
					{
						stockId: 15,
						shares: 1_000_000,
						transactions: null,
						bonus: null,
						updatedAt: null,
					},
				],
				events: [],
			}),
		);

		const holding = portfolio.holdings[0];
		expect(holding?.reconciliation.source).toBe("none");
		expect(holding?.roiPct).toBeNull();
		expect(holding?.profit).toBe(0);
		expect(
			holding?.warnings.some((w) => w.includes("No purchase history")),
		).toBe(true);
		expect(
			portfolio.warnings.some((w) => w.includes("could not be reconciled")),
		).toBe(true);
	});

	test("lists every catalogued stock with the doubling cost of the next increment", () => {
		const portfolio = computeStockPortfolio(input());
		expect(portfolio.catalog).toHaveLength(STOCK_CATALOG.length);

		// A price row for MCS exists, so the next block can be costed — but with no
		// energy rate its payout still cannot be valued, so no yield is claimed.
		const mcs = portfolio.catalog.find((c) => c.acronym === "MCS");
		expect(mcs?.nextIncrementShares).toBe(350_000);
		expect(mcs?.nextIncrementCost).toBe(350_000 * 800);
		expect(mcs?.firstIncrementYieldPct).toBeNull();
		expect(portfolio.catalog.find((c) => c.acronym === "TSB")?.owned).toBe(
			false,
		);

		// With a price row, the yield arithmetic runs end to end.
		const priced = computeStockPortfolio({
			...input(),
			stocks: [
				...referenceStocks,
				{
					stockId: 1,
					name: "Torn & Shanghai Banking",
					acronym: "TSB",
					price: 1166.86,
					requirementShares: 3_000_000,
					passive: false,
					frequencyDays: 31,
					description: "$50,000,000",
				},
			],
		});
		const pricedTsb = priced.catalog.find((c) => c.acronym === "TSB");
		expect(pricedTsb?.nextIncrementCost).toBeCloseTo(3_000_000 * 1166.86, 3);
		expect(pricedTsb?.firstIncrementYieldPct).toBeCloseTo(
			((50_000_000 * (365 / 31)) / (3_000_000 * 1166.86)) * 100,
			6,
		);
	});

	test("halves the yield of a second increment, because its cost doubles", () => {
		const portfolio = computeStockPortfolio({
			...input(),
			holdings: [
				{
					stockId: 1,
					shares: 3_000_000,
					transactions: [
						{ shares: 3_000_000, price: 1_000, timestamp: 1_750_000_000 },
					],
					bonus: { available: false, increment: 1, progress: 4, frequency: 31 },
					updatedAt: null,
				},
			],
			stocks: [
				{
					stockId: 1,
					name: "Torn & Shanghai Banking",
					acronym: "TSB",
					price: 1_000,
					requirementShares: 3_000_000,
					passive: false,
					frequencyDays: 31,
					description: "$50,000,000",
				},
			],
		});

		const tsb = portfolio.catalog.find((c) => c.acronym === "TSB");
		expect(tsb?.nextIncrementShares).toBe(6_000_000);
		expect(tsb?.firstIncrementYieldPct).toBeCloseTo(
			((50_000_000 * (365 / 31)) / (3_000_000 * 1_000)) * 100,
			6,
		);
		expect(tsb?.nextIncrementYieldPct).toBeCloseTo(
			(tsb?.firstIncrementYieldPct ?? 0) / 2,
			6,
		);
	});
});

describe("buildBenefitProgress", () => {
	const fhg = resolveStockBenefit(
		15,
		{
			stockId: 15,
			name: "Feathery Hotels Group",
			acronym: "FHG",
			price: 950,
			requirementShares: 2_000_000,
			passive: false,
			frequencyDays: 7,
			description: "1x Feathery Hotel Coupon",
		},
		{
			rates: { energy: 0, nerve: 0, happy: 0, points: 0 },
			itemPricesById: new Map(),
			itemPricesByName: new Map(),
		},
	);

	test("counts down to the next dividend from Torn's progress", () => {
		const progress = buildBenefitProgress({
			bonus: { available: false, increment: 1, progress: 3, frequency: 7 },
			benefit: { ...fhg, increments: 1 },
			shares: 2_000_000,
			daysHeld: 3,
			lastDividendAt: null,
			asOfSeconds: 0,
		});

		expect(progress?.daysUntil).toBe(4);
		expect(progress?.available).toBe(false);
		expect(progress?.passiveActive).toBeNull();
	});

	test("flags a dividend that is ready to collect, with the collect window", () => {
		const progress = buildBenefitProgress({
			bonus: { available: true, increment: 1, progress: 7, frequency: 7 },
			benefit: { ...fhg, increments: 1 },
			shares: 2_000_000,
			daysHeld: 7,
			lastDividendAt: null,
			asOfSeconds: 0,
		});

		expect(progress?.available).toBe(true);
		expect(progress?.daysUntil).toBe(0);
		expect(progress?.note).toContain("midnight cron");
	});

	test("reports a passive benefit as active once its week has passed", () => {
		const tcp = resolveStockBenefit(
			13,
			{
				stockId: 13,
				name: "TC Media Productions",
				acronym: "TCP",
				price: 556.64,
				requirementShares: 1_000_000,
				passive: true,
				frequencyDays: 7,
				description: "a Company sales boost",
			},
			{
				rates: { energy: 0, nerve: 0, happy: 0, points: 0 },
				itemPricesById: new Map(),
				itemPricesByName: new Map(),
			},
		);

		const active = buildBenefitProgress({
			bonus: { available: true, increment: 1, progress: 7, frequency: 7 },
			benefit: { ...tcp, increments: 1 },
			shares: 1_000_000,
			daysHeld: 30,
			lastDividendAt: null,
			asOfSeconds: 0,
		});
		expect(active?.passiveActive).toBe(true);
		expect(active?.daysUntil).toBeNull();

		const pending = buildBenefitProgress({
			bonus: { available: false, increment: 1, progress: 2, frequency: 7 },
			benefit: { ...tcp, increments: 1 },
			shares: 1_000_000,
			daysHeld: 2,
			lastDividendAt: null,
			asOfSeconds: 0,
		});
		expect(pending?.passiveActive).toBe(false);
		expect(pending?.daysUntil).toBe(5);
	});

	test("says so when the holding is below one block", () => {
		const progress = buildBenefitProgress({
			bonus: { available: false, increment: 0, progress: 0, frequency: 0 },
			benefit: { ...fhg, increments: 0 },
			shares: 1_360_854,
			daysHeld: 40,
			lastDividendAt: null,
			asOfSeconds: 0,
		});

		expect(progress?.note).toContain("Below the block size");
		expect(progress?.daysUntil).toBe(7);
	});
});

describe("catalogue integrity", () => {
	test("every entry has a block size, a description and a valuation", () => {
		expect(STOCK_CATALOG).toHaveLength(35);
		const ids = new Set(STOCK_CATALOG.map((s) => s.stockId));
		expect(ids.size).toBe(35);
		for (const stock of STOCK_CATALOG) {
			expect(stock.requirementShares).toBeGreaterThan(0);
			expect(stock.description.length).toBeGreaterThan(0);
			expect(stock.valuation).toBeDefined();
			expect(stock.frequencyDays).toBeGreaterThan(0);
		}
	});

	test("passive stocks are the only ones with no dividend cycle", () => {
		for (const stock of STOCK_CATALOG) {
			if (stock.valuation.kind === "passive") {
				expect(stock.passive).toBe(true);
			}
		}
		expect(catalogStock(29)?.maxIncrements).toBe(10);
	});
});
