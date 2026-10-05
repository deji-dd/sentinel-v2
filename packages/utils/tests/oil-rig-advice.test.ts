import { describe, expect, it } from "bun:test";
import type { CompanyDirectives } from "../../schemas/src/company";
import {
	assessCapacityRegime,
	deriveRosterBaseline,
	type OilRigHistoryRecord,
	quotaFromBaseline,
} from "../src/oil-rig";
import {
	adBonusPctForRank,
	buildAdRankModel,
	estimateAdResponse,
	rankForAdBonusPct,
	recommendAdBudget,
} from "../src/oil-rig-advertising";
import { analyzeOilRig } from "../src/oil-rig-analysis";
import {
	attributeBriefOutcome,
	type PreviousBriefState,
} from "../src/oil-rig-brief-store";
import { fitBarrelDemand } from "../src/oil-rig-demand";
import { OIL_RIG_POLICY } from "../src/oil-rig-policy";
import {
	adviceSignature,
	buildAnalystPrompt,
	renderDeterministicBriefing,
	validateAnalystNotes,
} from "../src/oil-rig-render";
import type { CompanySnapshot } from "../src/oil-rig-snapshot";

const FIXED_NOW = 1_790_705_443;

/** A history record with sensible defaults, so tests only state what matters. */
function record(over: Partial<OilRigHistoryRecord> & { timestamp: number }) {
	return {
		isoDate: new Date(over.timestamp * 1000).toISOString().slice(0, 10),
		stars: 4,
		dailyIncome: 40_000_000,
		weeklyIncome: 280_000_000,
		dailyWages: 20_000_000,
		dailyProfit: 18_000_000,
		adBudget: 3_000_000,
		efficiency: 92,
		environment: 100,
		popularity: 30,
		stock: {
			barrelPrice: 183,
			inStock: 400_000,
			soldAmount: 200_000,
			fillPct: 53,
		},
		metrics: { totalAddictionPenalty: 0, employeesWithAddiction: 0 },
		...over,
	} satisfies OilRigHistoryRecord;
}

const DAY = 86_400;

/**
 * Advertising: the wiki states the base effect is capped at 40% and awarded by
 * RANK, so a budget increase that does not overtake another advertiser buys
 * nothing. These tests pin that curve, because the whole ad strategy is derived
 * from it.
 */
describe("Advertising rank model (wiki curve)", () => {
	it("awards 40% to the top spender and steps down by 0.5% per rank in an 80-company field", () => {
		expect(adBonusPctForRank(1, 80)).toBe(40);
		expect(adBonusPctForRank(2, 80)).toBe(39.5);
		expect(adBonusPctForRank(3, 80)).toBe(39);
		expect(adBonusPctForRank(80, 80)).toBe(0.5);
		// Past the advertiser field there is no bonus at all.
		expect(adBonusPctForRank(81, 80)).toBe(0);
		expect(adBonusPctForRank(1_000, 80)).toBe(0);
	});

	it("inverts the curve", () => {
		expect(rankForAdBonusPct(40, 80)).toBe(1);
		expect(rankForAdBonusPct(39.5, 80)).toBe(2);
		expect(rankForAdBonusPct(0.5, 80)).toBe(80);
	});

	it("prices one rank step and caps spend at what the whole band is worth", () => {
		const model = buildAdRankModel({ referenceDailyRevenue: 50_000_000 });
		// 0.5% of $50M/day is $250k/day: what a single rank is worth.
		expect(model.revenuePerRankStepPerDay).toBe(250_000);
		// The whole 40% band is worth at most $20M/day, so no recommendation may
		// exceed the tighter operational cap.
		expect(model.maxJustifiedSpendPerDay).toBe(20_000_000);
		expect(model.operationalCapPerDay).toBeLessThanOrEqual(
			model.maxJustifiedSpendPerDay,
		);
		expect(model.rationale).toContain("pays by rank");
	});
});

/**
 * What our OWN past budget changes actually bought. Competitors' budgets are not
 * observable, so this measurement is the only basis for an ad decision.
 */
describe("Advertising response measurement", () => {
	const probe = (
		fromAd: number,
		toAd: number,
		customersBefore: number,
		customersAfter: number,
		recordsAfter = 2,
		revenuePerCustomer = 100_000,
	) => {
		const days: OilRigHistoryRecord[] = [
			record({
				timestamp: FIXED_NOW - 4 * DAY,
				adBudget: fromAd,
				dailyCustomers: customersBefore,
				dailyIncome: customersBefore * revenuePerCustomer,
			}),
			record({
				timestamp: FIXED_NOW - 3 * DAY,
				adBudget: fromAd,
				dailyCustomers: customersBefore,
				dailyIncome: customersBefore * revenuePerCustomer,
			}),
			record({
				timestamp: FIXED_NOW - 2 * DAY,
				adBudget: toAd,
				dailyCustomers: customersBefore,
				dailyIncome: customersBefore * revenuePerCustomer,
			}),
		];
		for (let i = 0; i < recordsAfter; i++) {
			days.push(
				record({
					timestamp: FIXED_NOW - (1 - i) * DAY,
					adBudget: toAd,
					dailyCustomers: customersAfter,
					dailyIncome: customersAfter * revenuePerCustomer,
				}),
			);
		}
		return days;
	};

	it("does not judge a probe until enough days have followed it", () => {
		const estimate = estimateAdResponse(
			probe(1_000_000, 2_000_000, 40, 60, 1),
			{ currentAdBudget: 2_000_000 },
		);
		expect(estimate.latest?.verdict).toBe("probe_pending");
		expect(estimate.latest?.summary).toContain("2 are needed");
	});

	it("reports an increase that paid for itself", () => {
		const estimate = estimateAdResponse(probe(1_000_000, 2_000_000, 40, 60), {
			currentAdBudget: 2_000_000,
		});
		expect(estimate.signal).toBe("daily_customers");
		expect(estimate.latest?.verdict).toBe("positive");
		// $1M/day bought 20 customers/day worth $100k each, so $2 of revenue per $1.
		expect(estimate.latest?.marginalRevenuePerAdDollar).toBeGreaterThan(1);
	});

	it("reports an increase that did not pay for itself", () => {
		const estimate = estimateAdResponse(probe(1_000_000, 2_000_000, 40, 48), {
			currentAdBudget: 2_000_000,
		});
		expect(estimate.latest?.verdict).toBe("negative");
	});

	it("calls a change that moved nothing an unmeasured effect, not a success", () => {
		const estimate = estimateAdResponse(probe(1_000_000, 2_000_000, 40, 40), {
			currentAdBudget: 2_000_000,
		});
		expect(estimate.latest?.verdict).toBe("unmeasured_effect");
		expect(estimate.latest?.summary).toContain("no measurable traffic change");
	});

	it("does not treat a budget with no recorded history as a pending change", () => {
		// With nothing recorded there is nothing to disagree with, and treating a
		// non-zero budget as an un-recorded change made the engine hold forever.
		const estimate = estimateAdResponse([], { currentAdBudget: 5_000_000 });
		expect(estimate.pendingSettingChange).toBe(false);
	});

	it("detects a live setting that has run ahead of the recorded tick", () => {
		const history = probe(1_000_000, 2_000_000, 40, 60);
		expect(
			estimateAdResponse(history, { currentAdBudget: 9_000_000 })
				.pendingSettingChange,
		).toBe(true);
	});

	it("never compounds spend on a probe that bought nothing", () => {
		const history = probe(3_000_000, 3_000_000 + 200_000, 40, 40);
		const advice = recommendAdBudget({
			currentAdBudget: 3_200_000,
			referenceDailyRevenue: 50_000_000,
			state: "surplus",
			extractionBound: true,
			history,
			asOfSeconds: FIXED_NOW,
		});
		expect(advice.action).toBe("maintain");
		expect(advice.changeNeeded).toBe(false);
		expect(advice.basis).toBe("measured_no_effect");
		expect(advice.rationale).toContain("do not increase");
	});

	it("keeps a measured probe in flight rather than asking for another", () => {
		const history = probe(3_000_000, 3_200_000, 40, 45, 1);
		const advice = recommendAdBudget({
			currentAdBudget: 3_200_000,
			referenceDailyRevenue: 50_000_000,
			state: "surplus",
			extractionBound: true,
			history,
			asOfSeconds: FIXED_NOW,
		});
		expect(advice.action).toBe("maintain");
		expect(advice.basis).toBe("probe_pending");
	});

	it("brings an over-ceiling budget back inside the cap, rounding down", () => {
		const advice = recommendAdBudget({
			currentAdBudget: 12_000_000,
			referenceDailyRevenue: 50_000_000,
			state: "surplus",
			extractionBound: true,
			history: [],
			asOfSeconds: FIXED_NOW,
		});
		expect(advice.action).toBe("decrease");
		expect(advice.amount).toBeLessThanOrEqual(7_500_000);
		// A hard ceiling means rounding may never step over it.
		expect(advice.amount).toBeLessThanOrEqual(
			advice.rankModel.operationalCapPerDay,
		);
	});

	it("freezes advertising while the warehouse cannot serve more customers", () => {
		const advice = recommendAdBudget({
			currentAdBudget: 2_000_000,
			referenceDailyRevenue: 50_000_000,
			state: "deficit",
			extractionBound: false,
			history: [],
			asOfSeconds: FIXED_NOW,
		});
		expect(advice.action).toBe("freeze");
		expect(advice.changeNeeded).toBe(false);
	});
});

/**
 * Price is not observable from any public source, so it is fitted from this rig's
 * own recorded days. These pin the fit and its refusal to guess.
 */
describe("Barrel demand fit", () => {
	/** sold = 366,000 - 1000 * price, so the revenue-max price is exactly $183. */
	const linearDemand = (prices: number[]) =>
		prices.map((price, index) =>
			record({
				timestamp: FIXED_NOW - (prices.length - index) * DAY,
				stock: {
					barrelPrice: price,
					inStock: 400_000,
					soldAmount: 366_000 - 1000 * price,
					fillPct: 53,
				},
			}),
		);

	it("fits a demand curve and finds the revenue-maximising price", () => {
		const fit = fitBarrelDemand(
			linearDemand([178, 179, 180, 181, 182, 183, 184]),
		);
		expect(fit.usable).toBe(true);
		expect(fit.samples).toBe(7);
		expect(fit.slope).toBeCloseTo(-1000, 0);
		expect(fit.r2).toBeGreaterThan(0.99);
		expect(fit.revenueMaxPrice).toBe(183);
		expect(fit.predictedSoldAt(183)).toBe(183_000);
		expect(fit.sensitivityAt(183)).toBeCloseTo(1, 1);
	});

	it("refuses to fit when every recorded day used the same price", () => {
		const fit = fitBarrelDemand(linearDemand([183, 183, 183, 183, 183, 183]));
		expect(fit.usable).toBe(false);
		expect(fit.reason).toContain("same barrel price");
	});

	it("refuses to fit when sales rose as the price rose", () => {
		const fit = fitBarrelDemand(
			[178, 180, 182, 184, 186, 188].map((price, index) =>
				record({
					timestamp: FIXED_NOW - (6 - index) * DAY,
					stock: {
						barrelPrice: price,
						inStock: 400_000,
						soldAmount: 100_000 + 5_000 * index,
						fillPct: 53,
					},
				}),
			),
		);
		expect(fit.usable).toBe(false);
		expect(fit.reason).toContain("no revenue-maximising price");
	});

	it("says plainly when there is too little data", () => {
		const fit = fitBarrelDemand(linearDemand([180, 182]));
		expect(fit.usable).toBe(false);
		expect(fit.reason).toContain("5 required");
	});

	it("excludes days the warehouse was too empty to express demand", () => {
		// On a nearly empty rig, sales are capped by what extraction delivered, not
		// by what customers wanted, so those days say nothing about price.
		const fit = fitBarrelDemand(
			[178, 180, 182, 184, 186].map((price, index) =>
				record({
					timestamp: FIXED_NOW - (5 - index) * DAY,
					stock: {
						barrelPrice: price,
						inStock: 20_000,
						soldAmount: 366_000 - 1000 * price,
						fillPct: 2,
					},
				}),
			),
		);
		expect(fit.usable).toBe(false);
		expect(fit.samples).toBe(0);
	});
});

/**
 * The capacity regime is the fix for the limit cycle: the condition "extraction
 * outruns sales" is removed by the remedy for it, so entry and exit must use
 * different rules or the advice alternates forever.
 */
describe("Capacity regime hysteresis", () => {
	const filling = (
		days: number,
		fillPct: number,
		produced: number,
		sold: number,
	) =>
		Array.from({ length: days }, (_, index) =>
			record({
				timestamp: FIXED_NOW - (days - index) * DAY,
				producedMeasured: true,
				dailyProduced: produced,
				stock: {
					barrelPrice: 180,
					inStock: Math.round((fillPct / 100) * 750_000),
					soldAmount: sold,
					fillPct,
				},
			}),
		);

	it("enters only after two consecutive measured days of net fill", () => {
		const oneDay = assessCapacityRegime({
			history: filling(1, 90, 290_000, 280_000),
			fillPct: 90,
			isFillingUp: true,
			warehouseCritical: false,
			asOfSeconds: FIXED_NOW,
		});
		expect(oneDay.regime).toBe("balanced");

		const twoDays = assessCapacityRegime({
			history: filling(3, 90, 290_000, 280_000),
			fillPct: 90,
			isFillingUp: true,
			warehouseCritical: false,
			asOfSeconds: FIXED_NOW,
		});
		expect(twoDays.regime).toBe("extraction_bound");
		expect(twoDays.reason).toContain("entered");
	});

	it("enters immediately when storage is at the critical fill", () => {
		const regime = assessCapacityRegime({
			history: [],
			fillPct: 98,
			isFillingUp: false,
			warehouseCritical: true,
			asOfSeconds: FIXED_NOW,
		});
		expect(regime.regime).toBe("extraction_bound");
		expect(regime.reason).toContain("clamped");
	});

	it("does not release the regime on a single draining day", () => {
		// This is the exact shape of the reproduced limit cycle: the rebalance
		// works, sell-through rises, extraction no longer outruns sales, and the
		// old engine immediately demanded the seats back.
		const regime = assessCapacityRegime({
			history: filling(3, 79, 293_942, 318_000),
			fillPct: 79,
			isFillingUp: false,
			warehouseCritical: false,
			previousRegime: "extraction_bound",
			previousSince: FIXED_NOW - 10 * DAY,
			asOfSeconds: FIXED_NOW,
		});
		expect(regime.regime).toBe("extraction_bound");
		expect(regime.held).toBe(true);
		expect(regime.since).toBe(FIXED_NOW - 10 * DAY);
		expect(regime.reason).toContain("held");
	});

	it("does not release the regime while storage is still above the exit fill", () => {
		const regime = assessCapacityRegime({
			history: filling(5, 70, 240_000, 318_000),
			fillPct: 70,
			isFillingUp: false,
			warehouseCritical: false,
			previousRegime: "extraction_bound",
			asOfSeconds: FIXED_NOW,
		});
		expect(regime.regime).toBe("extraction_bound");
		expect(regime.held).toBe(true);
	});

	it("releases the regime once drain is sustained and storage is back in range", () => {
		const regime = assessCapacityRegime({
			history: filling(5, 55, 240_000, 318_000),
			fillPct: 55,
			isFillingUp: false,
			warehouseCritical: false,
			previousRegime: "extraction_bound",
			previousSince: FIXED_NOW - 20 * DAY,
			asOfSeconds: FIXED_NOW,
		});
		expect(regime.regime).toBe("balanced");
		expect(regime.held).toBe(false);
		expect(regime.since).toBe(FIXED_NOW);
		expect(regime.reason).toContain("released");
	});

	it("does not enter the regime while stock is below the pressure threshold", () => {
		// Extraction outrunning sales below the healthy buffer is DESIRABLE: the rig
		// is short of stock and wants it to accumulate. Entering on net fill alone
		// demanded sell-through capacity for a warehouse that was running dry.
		const regime = assessCapacityRegime({
			history: filling(5, 46, 293_942, 283_942),
			fillPct: 46,
			isFillingUp: true,
			warehouseCritical: false,
			asOfSeconds: FIXED_NOW,
		});
		expect(regime.regime).toBe("balanced");
		expect(regime.reason).toContain("pressure threshold");
	});

	it("enters once the same trend is under storage pressure", () => {
		const regime = assessCapacityRegime({
			history: filling(5, 82, 293_942, 283_942),
			fillPct: 82,
			isFillingUp: true,
			warehouseCritical: false,
			asOfSeconds: FIXED_NOW,
		});
		expect(regime.regime).toBe("extraction_bound");
	});

	it("ignores days whose production was never measured", () => {
		const unmeasured = Array.from({ length: 6 }, (_, index) =>
			record({
				timestamp: FIXED_NOW - (6 - index) * DAY,
				producedMeasured: false,
				dailyProduced: 290_000,
				stock: {
					barrelPrice: 180,
					inStock: 600_000,
					soldAmount: 280_000,
					fillPct: 80,
				},
			}),
		);
		const regime = assessCapacityRegime({
			history: unmeasured,
			fillPct: 80,
			isFillingUp: false,
			warehouseCritical: false,
			asOfSeconds: FIXED_NOW,
		});
		expect(regime.regime).toBe("balanced");
		expect(regime.fillingDays).toBe(0);
	});
});

/** The roster baseline is the one lever that IS publicly observable. */
/** Fails loudly rather than asserting, because the repo forbids `!`. */
function requireBaseline(
	...args: Parameters<typeof deriveRosterBaseline>
): NonNullable<ReturnType<typeof deriveRosterBaseline>> {
	const baseline = deriveRosterBaseline(...args);
	if (!baseline) throw new Error("expected a usable roster baseline");
	return baseline;
}

describe("Measured roster baseline", () => {
	const row = {
		capturedAt: new Date(FIXED_NOW * 1000),
		rating: 10,
		fieldSize: 80,
		sampleSize: 8,
		roleShares: { Driller: 0.4, "Sales Executive": 0.3, Roughneck: 0.3 },
	};

	it("scales measured shares to an exact headcount", () => {
		const baseline = requireBaseline(row, { asOfSeconds: FIXED_NOW });
		const quotas = quotaFromBaseline(21, baseline);
		expect(Object.values(quotas).reduce((a, b) => a + b, 0)).toBe(21);
		// Largest remainder: 0.4/0.3/0.3 of 21 is 8.4/6.3/6.3, so the two leftover
		// seats go to the largest fractional parts. Driller takes the larger share.
		expect(quotas.Driller).toBe(9);
		expect(quotas["Sales Executive"]).toBe(6);
		expect(quotas.Roughneck).toBe(6);
	});

	it("renormalises shares that do not sum to one", () => {
		const baseline = requireBaseline(
			{ ...row, roleShares: { Driller: 2, Roughneck: 2 } },
			{ asOfSeconds: FIXED_NOW },
		);
		const quotas = quotaFromBaseline(10, baseline);
		expect(quotas.Driller).toBe(5);
		expect(quotas.Roughneck).toBe(5);
	});

	it("rejects a stale capture rather than silently switching blueprints", () => {
		const stale = deriveRosterBaseline(
			{ ...row, capturedAt: new Date((FIXED_NOW - 90 * DAY) * 1000) },
			{ asOfSeconds: FIXED_NOW, maxAgeDays: 45 },
		);
		expect(stale).toBeUndefined();
	});

	it("rejects a capture with no usable roles", () => {
		expect(
			deriveRosterBaseline(
				{ ...row, roleShares: { Wrench: 0.5, Sprocket: 0.5 } },
				{ asOfSeconds: FIXED_NOW },
			),
		).toBeUndefined();
	});

	it("always fills every seat, even when roles outnumber staff", () => {
		const baseline = requireBaseline(row, { asOfSeconds: FIXED_NOW });
		const quotas = quotaFromBaseline(2, baseline);
		expect(Object.values(quotas).reduce((a, b) => a + b, 0)).toBe(2);
	});
});

/**
 * The analyst model is fenced: it may not assert a change the engines did not ask
 * for, and it may not cite a figure it was never shown.
 */
describe("Analyst notes validation", () => {
	const snapshot = (
		over: Partial<CompanySnapshot["profile"]> = {},
	): CompanySnapshot => ({
		profile: {
			id: 90288,
			name: "Succession Oil",
			rating: 4,
			funds: 50_000_000,
			efficiency: 92,
			environment: 100,
			popularity: 30,
			income: { daily: 50_000_000, weekly: 350_000_000 },
			customers: { daily: 2, weekly: 14 },
			employees: { hired: 4, capacity: 21 },
			upgrades: { storage_capacity: 750_000 },
			advertisement_budget: 3_000_000,
			...over,
		},
		stock: [
			{
				name: "Crude Oil",
				price: 183,
				in_stock: 400_000,
				sold_amount: 200_000,
				sold_worth: 36_600_000,
			},
		],
		employees: [],
	});

	const balancedHistory = Array.from({ length: 4 }, (_, index) =>
		record({
			timestamp: FIXED_NOW - (4 - index) * DAY,
			producedMeasured: index !== 0,
			dailyProduced: 180_000,
			stock: {
				barrelPrice: 183,
				inStock: 400_000,
				soldAmount: 200_000,
				fillPct: 53,
			},
		}),
	);

	const analyse = () =>
		analyzeOilRig({
			snapshot: snapshot(),
			history: balancedHistory,
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});

	it("accepts analysis that stays inside the engines' conclusions", () => {
		const analysis = analyse();
		const { prompt, allowedNumbers } = buildAnalystPrompt({
			analysis,
			history: balancedHistory,
			actionText: "no actions",
		});
		const result = validateAnalystNotes({
			notes:
				"• Stock is inside the healthy buffer at 53.3% full.\n• Sell-through is steady across 4 recorded days.",
			allowedNumbers,
			directives: analysis.directives,
		});
		expect(result.rejected).toEqual([]);
		expect(result.accepted.length).toBe(2);
		expect(prompt).toContain("do not contradict them");
	});

	it("rejects a price change the pricing engine did not ask for", () => {
		const analysis = analyse();
		expect(analysis.directives.pricing.isChanged).toBe(false);
		const result = validateAnalystNotes({
			notes: "• Raise the barrel price to $190 to capture more margin.",
			allowedNumbers: new Set<string>(),
			directives: analysis.directives,
		});
		expect(result.accepted).toEqual([]);
		expect(result.rejected[0]?.reason).toContain("price change");
	});

	it("rejects an advertising increase the ad engine did not authorise", () => {
		const analysis = analyse();
		const result = validateAnalystNotes({
			notes: "• Increase the advertising budget to fill the warehouse.",
			allowedNumbers: new Set<string>(),
			directives: analysis.directives,
		});
		expect(result.accepted).toEqual([]);
		expect(result.rejected[0]?.reason).toContain("advertising");
	});

	it("rejects a roster move the solver did not issue", () => {
		const analysis = analyse();
		const result = validateAnalystNotes({
			notes: "• Move Emp1 into Driller to raise extraction.",
			allowedNumbers: new Set<string>(),
			directives: analysis.directives,
		});
		expect(result.accepted).toEqual([]);
		expect(result.rejected[0]?.reason).toContain("role move");
	});

	it("rejects a rebalance the capacity plan is not asking for", () => {
		const analysis = analyse();
		const result = validateAnalystNotes({
			notes: "• The rig needs a roster rebalance to clear the surplus.",
			allowedNumbers: new Set<string>(),
			directives: analysis.directives,
		});
		expect(result.accepted).toEqual([]);
		expect(result.rejected[0]?.reason).toContain("rebalance");
	});

	it("rejects a currency figure that appears nowhere in the data", () => {
		const analysis = analyse();
		const result = validateAnalystNotes({
			notes: "• The rig is leaving $9,750,000 per day on the table.",
			allowedNumbers: new Set(["400000"]),
			directives: analysis.directives,
		});
		expect(result.accepted).toEqual([]);
		expect(result.rejected[0]?.reason).toContain("does not appear");
	});

	it("accepts a figure the model was actually shown", () => {
		const analysis = analyse();
		const result = validateAnalystNotes({
			notes: "• Storage stands at 400,000 barrels.",
			allowedNumbers: new Set(["400000"]),
			directives: analysis.directives,
		});
		expect(result.rejected).toEqual([]);
		expect(result.accepted.length).toBe(1);
	});

	it("keeps the good bullets and drops only the bad one", () => {
		const analysis = analyse();
		const result = validateAnalystNotes({
			notes:
				"• Sell-through is steady.\n• Raise the barrel price to $190.\n• Storage is inside the buffer.",
			allowedNumbers: new Set<string>(),
			directives: analysis.directives,
		});
		expect(result.accepted.length).toBe(2);
		expect(result.rejected.length).toBe(1);
	});
});

/** A stable signature is what lets the brief say "no change" instead of rephrasing. */
describe("Advice signature and no-change detection", () => {
	const snapshot = (price: number): CompanySnapshot => ({
		profile: {
			id: 90288,
			name: "Succession Oil",
			rating: 4,
			funds: 50_000_000,
			efficiency: 92,
			environment: 100,
			popularity: 30,
			income: { daily: 50_000_000, weekly: 350_000_000 },
			customers: { daily: 2, weekly: 14 },
			employees: { hired: 4, capacity: 21 },
			upgrades: { storage_capacity: 750_000 },
			advertisement_budget: 3_000_000,
		},
		stock: [
			{
				name: "Crude Oil",
				price,
				in_stock: 400_000,
				sold_amount: 200_000,
				sold_worth: 36_600_000,
			},
		],
		employees: [],
	});

	const history = Array.from({ length: 4 }, (_, index) =>
		record({
			timestamp: FIXED_NOW - (4 - index) * DAY,
			producedMeasured: index !== 0,
			dailyProduced: 180_000,
			stock: {
				barrelPrice: 183,
				inStock: 400_000,
				soldAmount: 200_000,
				fillPct: 53,
			},
		}),
	);

	const brief = (price: number) =>
		renderDeterministicBriefing(
			analyzeOilRig({
				snapshot: snapshot(price),
				history,
				dataBasis: "recorded",
				asOfSeconds: FIXED_NOW,
			}),
		);

	it("is stable for identical advice", () => {
		const first = brief(183);
		const second = brief(183);
		expect(second.signature).toBe(first.signature);
		expect(second.changed).toBe(true);
	});

	it("changes when the advice changes", () => {
		expect(brief(190).signature).not.toBe(brief(183).signature);
	});

	it("reports no change and reissues the standing instructions when the advice is identical", () => {
		const first = brief(183);
		const second = renderDeterministicBriefing(
			analyzeOilRig({
				snapshot: snapshot(183),
				history,
				dataBasis: "recorded",
				asOfSeconds: FIXED_NOW,
			}),
			{
				previousSignature: first.signature,
				previousAsOfIso: "2026-10-05 12:00",
			},
		);
		expect(second.changed).toBe(false);
		expect(second.advice).toContain("No change since 2026-10-05 12:00");
	});

	it("prints the revert condition that the policy actually applies", () => {
		const directives: CompanyDirectives = analyzeOilRig({
			snapshot: {
				...snapshot(176),
				stock: [
					{
						name: "Crude Oil",
						price: 176,
						in_stock: 750_000,
						sold_amount: 283_942,
						sold_worth: 49_973_792,
					},
				],
			},
			history: Array.from({ length: 4 }, (_, index) =>
				record({
					timestamp: FIXED_NOW - (4 - index) * DAY,
					producedMeasured: index !== 0,
					dailyProduced: 293_942,
					stock: {
						barrelPrice: 176,
						inStock: 750_000,
						soldAmount: 283_942,
						fillPct: 100,
					},
				}),
			),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		}).directives;

		const capacity = directives.capacityRebalance;
		expect(capacity.revertCondition).toContain(
			String(OIL_RIG_POLICY.capacity.exitConsecutiveDrainDays),
		);
		expect(capacity.revertCondition).toContain(
			String(OIL_RIG_POLICY.capacity.exitMaxFillPct),
		);
		// The stated condition and the enforced one must be the same numbers.
		expect(adviceSignature(directives)).toBeTruthy();
	});
});

/**
 * Closing the prediction loop: without this there is no way to tell whether
 * following a brief beat ignoring it, and no way to tune the policy on evidence.
 */
describe("Brief outcome attribution", () => {
	const history = Array.from({ length: 4 }, (_, index) =>
		record({
			timestamp: FIXED_NOW - (4 - index) * DAY,
			producedMeasured: index !== 0,
			dailyProduced: 180_000,
			stock: {
				barrelPrice: 183,
				inStock: 400_000,
				soldAmount: 200_000,
				fillPct: 53,
			},
		}),
	);

	const analysis = () =>
		analyzeOilRig({
			snapshot: {
				profile: {
					id: 90288,
					name: "Succession Oil",
					rating: 4,
					funds: 50_000_000,
					efficiency: 92,
					environment: 100,
					popularity: 30,
					income: { daily: 50_000_000, weekly: 350_000_000 },
					customers: { daily: 2, weekly: 14 },
					employees: { hired: 4, capacity: 21 },
					upgrades: { storage_capacity: 750_000 },
					advertisement_budget: 3_000_000,
				},
				stock: [
					{
						name: "Crude Oil",
						price: 183,
						in_stock: 400_000,
						sold_amount: 200_000,
						sold_worth: 36_600_000,
					},
				],
				employees: [],
			},
			history,
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});

	it("records what moved and whether each instruction was applied", () => {
		const previous: PreviousBriefState = {
			id: "brief-1",
			asOf: new Date((FIXED_NOW - 5 * DAY) * 1000),
			adviceSignature: "previous",
			outcomeEvaluated: false,
			decision: {
				fillPct: 90,
				inStock: 675_000,
				dailySold: 283_942,
				recordedDailyRevenue: 50_000_000,
				recordedDailyProfit: 10_000_000,
				currentPrice: 176,
				currentAdBudget: 3_000_000,
				salesHeadcount: 4,
				asOfSeconds: FIXED_NOW - 5 * DAY,
			},
		};

		const outcome = attributeBriefOutcome(previous, analysis());
		expect(outcome.daysElapsed).toBe(5);
		expect(outcome.fillPctBefore).toBe(90);
		// Storage drained, which the summary must state rather than merely implying.
		expect(outcome.fillPctChange).toBeLessThan(0);
		expect(outcome.summary).toContain("Storage drained");
		// The price was moved, so compliance is recorded as applied.
		expect(outcome.compliance.priceApplied).toBe(true);
		expect(outcome.compliance.adApplied).toBe(false);
		// This fixture's current roster carries no Sales Executives while the
		// previous brief recorded four, so the sell-through lever is reported as
		// having gone the wrong way rather than being silently ignored.
		expect(outcome.compliance.salesHeadcountChange).toBe(-4);
	});

	it("handles a first brief with no recorded basis on the previous row", () => {
		const previous: PreviousBriefState = {
			id: "brief-0",
			asOf: new Date((FIXED_NOW - DAY) * 1000),
			adviceSignature: "previous",
			outcomeEvaluated: false,
		};
		const outcome = attributeBriefOutcome(previous, analysis());
		expect(Number.isFinite(outcome.fillPctChange)).toBe(true);
		expect(outcome.summary.length).toBeGreaterThan(0);
	});
});
