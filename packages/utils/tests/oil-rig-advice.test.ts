import { describe, expect, it } from "bun:test";
import type { CompanyDirectives } from "../../schemas/src/company";
import {
	assessCapacityRegime,
	type CapacityRegime,
	deriveRosterBaseline,
	INFINITE_DAYS_OF_SALES,
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
	clipNotes,
	DISCORD_MESSAGE_LIMIT,
	renderCompanyDetails,
	renderDeterministicBriefing,
	splitDiscordMessages,
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

	it("uses a measured field size when the benchmark has supplied one", () => {
		// Succession Oil's industry lists 100 rigs. Only the ones advertising
		// compete for rank, so the total is an upper bound on the advertiser count
		// and 40%/100 is a LOWER bound on what a rank is worth. Erring small
		// under-funds the probe, and over-spending is the riskier mistake.
		const measured = buildAdRankModel({
			referenceDailyRevenue: 50_000_000,
			fieldSize: 100,
		});
		expect(measured.fieldSize).toBe(100);
		expect(measured.stepPct).toBe(0.4);
		expect(measured.revenuePerRankStepPerDay).toBe(200_000);
		expect(measured.rationale).toContain("measured industry listing");

		// Without a benchmark the assumption is used, and says so.
		const assumed = buildAdRankModel({ referenceDailyRevenue: 50_000_000 });
		expect(assumed.fieldSize).toBe(OIL_RIG_POLICY.advertising.assumedFieldSize);
		expect(assumed.rationale).toContain("assumption, not a measurement");
		// A smaller field means a bigger step, so the assumption funds a larger
		// probe than the measurement does - which is why the measurement is safer.
		expect(assumed.revenuePerRankStepPerDay).toBeGreaterThan(
			measured.revenuePerRankStepPerDay,
		);
	});

	it("prices one rank step and caps spend at what the whole band is worth", () => {
		const model = buildAdRankModel({
			referenceDailyRevenue: 50_000_000,
			fieldSize: 80,
		});
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
			asOfSeconds: FIXED_NOW,
		});
		expect(oneDay.regime).toBe("balanced");

		const twoDays = assessCapacityRegime({
			history: filling(3, 90, 290_000, 280_000),
			fillPct: 90,
			asOfSeconds: FIXED_NOW,
		});
		expect(twoDays.regime).toBe("extraction_bound");
		expect(twoDays.reason).toContain("entered");
	});

	it("enters immediately when storage is at the critical fill", () => {
		const regime = assessCapacityRegime({
			history: [],
			fillPct: 98,
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
			asOfSeconds: FIXED_NOW,
		});
		expect(regime.regime).toBe("balanced");
		expect(regime.reason).toContain("pressure threshold");
	});

	it("enters once the same trend is under storage pressure", () => {
		const regime = assessCapacityRegime({
			history: filling(5, 82, 293_942, 283_942),
			fillPct: 82,
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
			asOfSeconds: FIXED_NOW,
		});
		expect(regime.regime).toBe("balanced");
		expect(regime.fillingDays).toBe(0);
	});

	it("cannot be entered by one day's reading, which is why it takes no single-day flag", () => {
		// `assessCapacityRegime` accepts no `isFillingUp`: entry is decided from
		// consecutive measured days in the history, and a single day's flag could only
		// ever be a weaker signal than the rule it would bypass. This pins the rule
		// from the outside - a run of draining days followed by ONE filling day does
		// not enter, however emphatic that day is.
		const popped = [
			...filling(5, 90, 240_000, 300_000),
			record({
				timestamp: FIXED_NOW,
				producedMeasured: true,
				dailyProduced: 400_000,
				stock: {
					barrelPrice: 180,
					inStock: Math.round(0.9 * 750_000),
					soldAmount: 300_000,
					fillPct: 90,
				},
			}),
		];
		const regime = assessCapacityRegime({
			history: popped,
			fillPct: 90,
			asOfSeconds: FIXED_NOW,
		});
		// Storage IS above the pressure threshold and the newest day fills, yet one
		// day is not a trend.
		expect(regime.regime).toBe("balanced");
		expect(regime.fillingDays).toBeGreaterThan(0);
	});

	it("still enters once the same fill is sustained, with no flag supplied", () => {
		const sustained = assessCapacityRegime({
			history: filling(3, 90, 340_000, 300_000),
			fillPct: 90,
			asOfSeconds: FIXED_NOW,
		});
		expect(sustained.regime).toBe("extraction_bound");
		expect(sustained.reason).toContain("entered");
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
		// The storage move must be stated outright, not merely implied by a number.
		expect(outcome.fillPctChange).toBeLessThan(0);
		expect(outcome.summary).toContain("storage 90% → 53.3%");
		// Age is in hours or days, never a bare "Over 0 days".
		expect(outcome.summary).toContain("Since the last brief (5.0 days ago)");
		// Only what changed: the ad budget and the storage-lever are unchanged here,
		// and listing them as "x -> x" is noise the director has to filter out.
		expect(outcome.summary).not.toContain("ads ");
		expect(outcome.summary).not.toContain("461,431 → 461,431");
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

/**
 * Delivery must never lose content. The brief used to be sliced at 4,000
 * characters for an embed description, which cut the advice off mid-sentence and
 * silently dropped the rest of the analysis.
 */
describe("Discord message chunking", () => {
	it("keeps every message inside the platform limit", () => {
		const text = Array.from(
			{ length: 120 },
			(_, i) => `• Line ${i} with some padding to make it a realistic length.`,
		).join("\n");
		const messages = splitDiscordMessages(text);
		expect(messages.length).toBeGreaterThan(1);
		for (const message of messages) {
			expect(message.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
		}
	});

	it("loses nothing across the split", () => {
		const lines = Array.from(
			{ length: 200 },
			(_, i) => `• Directive number ${i} must survive delivery.`,
		);
		const messages = splitDiscordMessages(lines.join("\n"));
		const rejoined = messages.join("\n");
		for (const line of lines) {
			expect(rejoined).toContain(line);
		}
	});

	it("closes and reopens a code fence rather than corrupting the table", () => {
		const table = `\`\`\`\n${Array.from({ length: 200 }, (_, i) => `2026-10-${(i % 28) + 1}  Mon  $${i},000  row ${i}`).join("\n")}\n\`\`\``;
		const messages = splitDiscordMessages(table);
		expect(messages.length).toBeGreaterThan(1);
		for (const message of messages) {
			// Every chunk must have balanced fences, or Discord renders the rest of
			// the brief as code.
			const fences = (message.match(/^```/gm) ?? []).length;
			expect(fences % 2).toBe(0);
			expect(message.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
		}
		expect(messages.join("\n")).toContain("row 199");
	});

	it("hard-splits a single line that cannot fit", () => {
		const monster = "x".repeat(5000);
		const messages = splitDiscordMessages(monster);
		expect(messages.length).toBeGreaterThan(2);
		for (const message of messages) {
			expect(message.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
		}
		expect(messages.join("").length).toBe(5000);
	});

	it("returns a single message when everything fits", () => {
		expect(splitDiscordMessages("short brief")).toEqual(["short brief"]);
	});
});

/**
 * The brief is read on a phone. Stating the same fact once per section is what
 * made it unreadable, not the length of any individual line.
 */
describe("Briefing is compact and non-repetitive", () => {
	const snapshot: CompanySnapshot = {
		profile: {
			id: 90288,
			name: "Succession Oil",
			rating: 4,
			funds: 400_000_000,
			efficiency: 96,
			environment: 100,
			popularity: 30,
			income: { daily: 49_973_792, weekly: 349_816_544 },
			customers: { daily: 2, weekly: 14 },
			employees: { hired: 4, capacity: 21 },
			upgrades: { storage_capacity: 750_000 },
			advertisement_budget: 5_000_000,
		},
		stock: [
			{
				name: "Crude Oil",
				price: 173,
				in_stock: 750_000,
				sold_amount: 283_942,
				sold_worth: 49_121_966,
			},
		],
		employees: [],
	};

	/**
	 * Six recorded days mirroring production: storage fills from 74% to the cap,
	 * so the earlier days can be sized and the last two only prove a lower bound.
	 */
	const fullWarehouse = Array.from({ length: 6 }, (_, i) => {
		const sold = 269_102 + i * 2_968;
		const fillPct = [74, 86.5, 94.5, 100, 100, 100][i] ?? 100;
		return record({
			timestamp: FIXED_NOW - (6 - i) * DAY,
			producedMeasured: i !== 0,
			dailyProduced: sold + 94_517,
			dailyIncome: 49_973_792,
			dailyWages: 42_014_500,
			dailyProfit: 49_973_792 - 42_014_500 - 5_000_000,
			adBudget: 5_000_000,
			stock: {
				barrelPrice: 173,
				inStock: Math.round((fillPct / 100) * 750_000),
				soldAmount: sold,
				fillPct,
			},
		});
	});

	const brief = renderDeterministicBriefing(
		analyzeOilRig({
			snapshot,
			history: fullWarehouse,
			dataBasis: "live",
			tickAgeMinutes: 22 * 60,
			asOfSeconds: FIXED_NOW,
		}),
	);

	it("states the discarded volume exactly once", () => {
		const occurrences = (brief.advice.match(/94,517/g) ?? []).length;
		expect(occurrences).toBe(1);
	});

	it("states the storage level once per section that needs it", () => {
		// "100%" may appear in the capacity line; it must not be repeated by a
		// separate structural-constraint sentence.
		const occurrences = (brief.advice.match(/100% full/g) ?? []).length;
		expect(occurrences).toBeLessThanOrEqual(1);
		expect(brief.advice).not.toContain("Storage Status");
		expect(brief.advice).not.toContain("Rebalance Holding");
	});

	it("collapses singleton roles onto one lineup line", () => {
		// Four lines carry what six verbose ones did.
		const lineup = brief.advice.split("### Target Lineup")[1] ?? "";
		const bulletLines = lineup.split("\n").filter((l) => l.startsWith("• "));
		expect(bulletLines.length).toBeLessThanOrEqual(4);
	});

	it("keeps the whole advice well inside one Discord message on real data", () => {
		// The production state that was truncated: full warehouse, one transfer.
		expect(brief.advice.length).toBeLessThan(1900);
	});
});

/**
 * The analyst model is fenced, but the fence must not reject honest reasoning:
 * a validator that drops genuine analysis is as wrong as one that accepts
 * invented statistics.
 */
describe("Analyst fences tolerate legitimate analysis", () => {
	it("accepts a difference derived from two supplied figures", () => {
		const analysis = analyzeOilRig({
			snapshot: {
				profile: {
					id: 90288,
					name: "Succession Oil",
					rating: 4,
					funds: 400_000_000,
					efficiency: 96,
					environment: 100,
					popularity: 30,
					income: { daily: 49_973_792, weekly: 349_816_544 },
					customers: { daily: 2, weekly: 14 },
					employees: { hired: 4, capacity: 21 },
					upgrades: { storage_capacity: 750_000 },
					advertisement_budget: 5_000_000,
				},
				stock: [
					{
						name: "Crude Oil",
						price: 173,
						in_stock: 750_000,
						sold_amount: 283_942,
						sold_worth: 49_121_966,
					},
				],
				employees: [],
			},
			history: Array.from({ length: 4 }, (_, i) =>
				record({
					timestamp: FIXED_NOW - (4 - i) * DAY,
					producedMeasured: i !== 0,
					dailyProduced: 310_655,
					stock: {
						barrelPrice: 173,
						inStock: 750_000,
						soldAmount: 283_942,
						fillPct: 100,
					},
				}),
			),
			dataBasis: "live",
			asOfSeconds: FIXED_NOW,
		});

		const { allowedNumbers } = buildAnalystPrompt({
			analysis,
			history: [],
			actionText: "none",
		});
		// 310,655 - 283,942 = 26,713, a derivation from supplied figures.
		const result = validateAnalystNotes({
			notes: "• Extraction exceeds sales by roughly 26,700 bbl/day.",
			allowedNumbers,
			directives: analysis.directives,
		});
		expect(result.rejected).toEqual([]);
		expect(result.accepted.length).toBe(1);
	});

	it("still rejects an invented external reference figure", () => {
		const analysis = analyzeOilRig({
			snapshot: {
				profile: {
					id: 90288,
					name: "Succession Oil",
					rating: 4,
					funds: 400_000_000,
					efficiency: 96,
					environment: 100,
					popularity: 30,
					income: { daily: 49_973_792, weekly: 349_816_544 },
					customers: { daily: 2, weekly: 14 },
					employees: { hired: 4, capacity: 21 },
					upgrades: { storage_capacity: 750_000 },
					advertisement_budget: 5_000_000,
				},
				stock: [
					{
						name: "Crude Oil",
						price: 173,
						in_stock: 750_000,
						sold_amount: 283_942,
						sold_worth: 49_121_966,
					},
				],
				employees: [],
			},
			history: [],
			dataBasis: "live",
			asOfSeconds: FIXED_NOW,
		});
		const { allowedNumbers } = buildAnalystPrompt({
			analysis,
			history: [],
			actionText: "none",
		});
		const result = validateAnalystNotes({
			notes: "• Top rigs average $1,163,000,000 per week.",
			allowedNumbers,
			directives: analysis.directives,
		});
		expect(result.accepted).toEqual([]);
		expect(result.rejected[0]?.reason).toContain("does not appear");
	});

	it("catches a rebalance proposal phrased as 'rebalancing'", () => {
		const analysis = analyzeOilRig({
			snapshot: {
				profile: {
					id: 90288,
					name: "Succession Oil",
					rating: 4,
					funds: 400_000_000,
					efficiency: 96,
					environment: 100,
					popularity: 30,
					income: { daily: 49_973_792, weekly: 349_816_544 },
					customers: { daily: 2, weekly: 14 },
					employees: { hired: 4, capacity: 21 },
					upgrades: { storage_capacity: 750_000 },
					advertisement_budget: 5_000_000,
				},
				stock: [
					{
						name: "Crude Oil",
						price: 173,
						in_stock: 400_000,
						sold_amount: 200_000,
						sold_worth: 34_600_000,
					},
				],
				employees: [],
			},
			history: [],
			dataBasis: "live",
			asOfSeconds: FIXED_NOW,
		});
		// The plan is balanced here, so a rebalance proposal is unauthorised.
		expect(analysis.directives.capacityRebalance.state).toBe("balanced");
		const result = validateAnalystNotes({
			notes: "• Further rebalancing of the extraction side is warranted.",
			allowedNumbers: new Set<string>(),
			directives: analysis.directives,
		});
		expect(result.accepted).toEqual([]);
		expect(result.rejected[0]?.reason).toContain("rebalance");
	});
});

/**
 * The analyst model must understand the rig's accounting, or it invents meaning
 * for empty figures. It reported a "$0" week-to-date as a "reset or specific
 * accounting period" instead of recognising a week with no recorded days.
 */
describe("Analyst prompt explains the accounting", () => {
	const snapshot: CompanySnapshot = {
		profile: {
			id: 90288,
			name: "Succession Oil",
			rating: 4,
			funds: 400_000_000,
			efficiency: 96,
			environment: 100,
			popularity: 30,
			income: { daily: 49_973_792, weekly: 359_900_391 },
			customers: { daily: 2, weekly: 14 },
			employees: { hired: 4, capacity: 21 },
			upgrades: { storage_capacity: 750_000 },
			advertisement_budget: 5_000_000,
		},
		stock: [
			{
				name: "Crude Oil",
				price: 173,
				in_stock: 750_000,
				sold_amount: 283_942,
				sold_worth: 49_121_966,
			},
		],
		employees: [],
	};

	/** Recorded days in a PREVIOUS accounting week, so this week is empty. */
	const lastWeek = Array.from({ length: 4 }, (_, i) => {
		const ts = FIXED_NOW - (12 - i) * DAY;
		return record({
			timestamp: ts,
			producedMeasured: i !== 0,
			dailyProduced: 310_655,
			dailyIncome: 49_973_792,
			// The record's own weekly figure. Daily x 7 would be 349,816,544, so this
			// also proves the prompt quotes the record rather than multiplying.
			weeklyIncome: 359_900_391,
			dailyWages: 42_014_500,
			dailyProfit: 3_459_292,
			adBudget: 4_500_000,
			stock: {
				barrelPrice: 176,
				inStock: 750_000,
				soldAmount: 283_942,
				fillPct: 100,
			},
		});
	});

	const build = () => {
		const analysis = analyzeOilRig({
			snapshot,
			history: lastWeek,
			dataBasis: "live",
			tickAgeMinutes: 22 * 60,
			asOfSeconds: FIXED_NOW,
		});
		return buildAnalystPrompt({
			analysis,
			history: lastWeek,
			actionText: "none",
		}).prompt;
	};

	it("states that an empty week is unknown rather than zero", () => {
		const prompt = build();
		expect(prompt).toContain("NO DAYS RECORDED IN THIS WINDOW YET");
		expect(prompt).toContain("unknown, not zero");
		// The speculative reading of an empty week must be ruled out explicitly.
		expect(prompt).toContain("do not describe it as a reset");
	});

	it("defines daily as the last recorded day, not today", () => {
		const prompt = build();
		expect(prompt).toContain("most recent RECORDED day");
		expect(prompt).toContain("It is NOT today");
	});

	it("never fabricates a weekly revenue figure from the daily one", () => {
		const prompt = build();
		// The record reports $359,900,391. Daily x 7 would be $349,816,544.
		expect(prompt).toContain("359,900,391");
		expect(prompt).not.toContain("349,816,544");
	});

	it("quotes the recorded barrel price, not the live setting, beside recorded sales", () => {
		const prompt = build();
		expect(prompt).toContain("283,942 at $176/barrel");
		expect(prompt).toContain("barrel price $173");
	});

	it("accepts k/M/B shorthand for a figure it was shown", () => {
		const analysis = analyzeOilRig({
			snapshot,
			history: lastWeek,
			dataBasis: "live",
			asOfSeconds: FIXED_NOW,
		});
		const { allowedNumbers } = buildAnalystPrompt({
			analysis,
			history: lastWeek,
			actionText: "none",
		});
		// $3.46M is how a model writes the supplied $3,459,292.
		const result = validateAnalystNotes({
			notes: "• Daily profit was about $3.46M for the last recorded day.",
			allowedNumbers,
			directives: analysis.directives,
		});
		expect(result.rejected).toEqual([]);
		expect(result.accepted.length).toBe(1);
	});
});

/** A partial figure reads as a measurement, so a clip must never leave one. */
describe("Analyst notes are clipped at a boundary", () => {
	it("drops a trailing incomplete line instead of keeping a fragment", () => {
		// This is the production truncation: "...increasing daily revenue by +1".
		const notes = [
			"• Price reduction to $173 raised volume by +24.8%.",
			"• Daily revenue rose to $79,827,563, increasing daily revenue by +1",
		].join("\n");
		const clipped = clipNotes(notes, 60);
		expect(clipped).toBe("• Price reduction to $173 raised volume by +24.8%.");
		expect(clipped).not.toContain("+1");
		expect(clipped.endsWith(".")).toBe(true);
	});

	it("leaves text inside the budget untouched", () => {
		const notes = "• Short and complete.";
		expect(clipNotes(notes, 900)).toBe(notes);
	});

	it("falls back to the last complete sentence for a single long line", () => {
		const clipped = clipNotes(
			"First sentence is complete. Second sentence is also complete. Third is cut off here",
			62,
		);
		expect(clipped).toBe(
			"First sentence is complete. Second sentence is also complete.",
		);
	});

	it("returns nothing when no complete unit fits the budget", () => {
		// Better to show no notes than a fragment of a figure.
		expect(
			clipNotes("• An extremely long unfinished clause that will not fit", 10),
		).toBe("");
	});
});

/**
 * The regime is hysteretic, so it can be HELD while the constraint has already
 * eased. The brief must describe the current flow, not the regime flag: it was
 * claiming "Cannot drain" and "Losing ~94,517 bbl/day" on a rig that was draining
 * 177,489 bbl/day.
 */
describe("Capacity section describes the current flow, not the held regime", () => {
	const ROSTER: Array<[string, string]> = [
		...Array(6)
			.fill(null)
			.map((_, i) => [`Driller${i}`, "Driller"] as [string, string]),
		...Array(6)
			.fill(null)
			.map((_, i) => [`Sales${i}`, "Sales Executive"] as [string, string]),
		...Array(4)
			.fill(null)
			.map((_, i) => [`Rough${i}`, "Roughneck"] as [string, string]),
		...Array(2)
			.fill(null)
			.map((_, i) => [`Derrick${i}`, "Derrick Hand"] as [string, string]),
		...Array(2)
			.fill(null)
			.map((_, i) => [`Motor${i}`, "Motor Hand"] as [string, string]),
		["Secretary0", "Secretary"] as [string, string],
	];

	const snapshot = (fillPct: number, price: number): CompanySnapshot => ({
		profile: {
			id: 90288,
			name: "Succession Oil",
			rating: 4,
			funds: 400_000_000,
			efficiency: 89,
			environment: 91,
			popularity: 35,
			income: { daily: 71_873_472, weekly: 503_000_000 },
			customers: { daily: 6, weekly: 42 },
			employees: { hired: ROSTER.length, capacity: 21 },
			upgrades: { storage_capacity: 750_000 },
			advertisement_budget: 5_000_000,
		},
		stock: [
			{
				name: "Crude Oil",
				price,
				in_stock: Math.round((fillPct / 100) * 750_000),
				sold_amount: 461_431,
				sold_worth: 461_431 * price,
			},
		],
		employees: ROSTER.map(([name, role], i) => ({
			id: i + 1,
			name,
			position: { id: 1, name: role },
			days_in_company: 40 + i,
			wage: 2_500_000,
			stats: {
				manual_labor: 150_000 + i * 8_000,
				intelligence: 120_000 + i * 9_000,
				endurance: 100_000 + i * 6_000,
			},
			effectiveness: {
				working_stats: 100,
				settled_in: 14,
				director_education: 0,
				addiction: 0,
				inactivity: 0,
				total: 114,
			},
		})),
	});

	/**
	 * Storage filled first (so a historical discard median exists), and the LAST
	 * recorded day is the one the rates come from: sales far above extraction,
	 * which is the production shape this test is about.
	 */
	const fillingHistory = [
		...[38, 45.8, 58.6, 73.9, 86.5].map((fillPct, i) =>
			record({
				timestamp: FIXED_NOW - (8 - i) * DAY,
				producedMeasured: true,
				// Uncapped days show the TRUE extraction, which is what the historical
				// surplus median measures.
				dailyProduced: 270_000 + i * 3_000 + 94_517,
				stock: {
					barrelPrice: 176,
					inStock: Math.round((fillPct / 100) * 750_000),
					soldAmount: 270_000 + i * 3_000,
					fillPct,
				},
			}),
		),
		// Two days at the cap, where the clamped delta makes production look equal to
		// sales - the source of the misleading figure.
		record({
			timestamp: FIXED_NOW - 2 * DAY,
			producedMeasured: true,
			dailyProduced: 269_102,
			stock: {
				barrelPrice: 176,
				inStock: 750_000,
				soldAmount: 269_102,
				fillPct: 100,
			},
		}),
		record({
			timestamp: FIXED_NOW - 1 * DAY,
			producedMeasured: true,
			dailyProduced: 283_942,
			stock: {
				barrelPrice: 176,
				inStock: 750_000,
				soldAmount: 283_942,
				fillPct: 100,
			},
		}),
		// The day the rates are taken from: sell-through well above extraction.
		record({
			timestamp: FIXED_NOW,
			producedMeasured: true,
			dailyProduced: 302_266,
			stock: {
				barrelPrice: 176,
				inStock: Math.round(0.788 * 750_000),
				soldAmount: 461_431,
				fillPct: 78.8,
			},
		}),
	];

	/** The regime held over from the last brief, as production had it. */
	const heldRegime = {
		regime: "extraction_bound" as const,
		held: true,
		transition: "held" as const,
		dwellDays: 2,
		fillingDays: 4,
		drainingDays: 0,
		since: FIXED_NOW - 3 * DAY,
		reason: "restored from the previous brief",
		shortReason: "restored from the previous brief",
	};

	it("says the rig is draining when sales outpace extraction, and claims no loss", () => {
		const analysis = analyzeOilRig({
			snapshot: snapshot(66.4, 176),
			history: fillingHistory,
			dataBasis: "live",
			asOfSeconds: FIXED_NOW,
			previousRegime: heldRegime,
			previousState: "surplus",
			previousCritical: true,
		});

		// The regime is genuinely held: storage has not drained to the release point.
		expect(analysis.regime.regime).toBe("extraction_bound");
		expect(analysis.regime.held).toBe(true);

		const advice = renderDeterministicBriefing(analysis).advice;
		expect(advice).toContain("**Draining**");
		expect(advice).not.toContain("Cannot drain");
		// 94,517 is a historical median from days storage was filling; nothing is
		// being discarded while the rig drains, so it must not be reported as a loss.
		expect(advice).not.toContain("Losing");
		expect(advice).not.toContain("94,517");
		expect(analysis.directives.capacityRebalance.discardedBarrelsPerDay).toBe(
			0,
		);
		// The historical figure is still available as context for other surfaces.
		expect(
			analysis.directives.capacityRebalance.discardedHistoricPerDay,
		).toBeGreaterThan(0);
	});

	it("states what the hold is actually waiting for", () => {
		const analysis = analyzeOilRig({
			snapshot: snapshot(66.4, 176),
			history: fillingHistory,
			dataBasis: "live",
			asOfSeconds: FIXED_NOW,
			previousRegime: heldRegime,
			previousState: "surplus",
			previousCritical: true,
		});
		const advice = renderDeterministicBriefing(analysis).advice;
		// The binding condition is the storage level, not "sales outpacing
		// extraction", which has already happened.
		expect(advice).toContain("Releases when");
		expect(advice).toContain("storage falls to 60%");
		expect(advice).toContain("now 66.4%");
	});

	it("still reports a loss when the warehouse is genuinely at its cap", () => {
		const atCap = Array.from({ length: 6 }, (_, i) => {
			const sold = 270_000 + i * 3_000;
			return record({
				timestamp: FIXED_NOW - (6 - i) * DAY,
				producedMeasured: i !== 0,
				// Extraction above sales, and storage already full.
				dailyProduced: sold + 94_517,
				stock: {
					barrelPrice: 176,
					inStock: 750_000,
					soldAmount: sold,
					fillPct: 100,
				},
			});
		});
		const analysis = analyzeOilRig({
			snapshot: {
				...snapshot(100, 176),
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
			history: atCap,
			dataBasis: "live",
			asOfSeconds: FIXED_NOW,
		});

		const advice = renderDeterministicBriefing(analysis).advice;
		expect(advice).toContain("Cannot drain");
		expect(advice).toContain("Losing");
		expect(analysis.directives.capacityRebalance.currentlyDiscarding).toBe(
			true,
		);
	});

	it("does not claim a cause for the hold that did not happen", () => {
		const analysis = analyzeOilRig({
			snapshot: snapshot(66.4, 176),
			history: fillingHistory,
			dataBasis: "live",
			asOfSeconds: FIXED_NOW,
			previousRegime: heldRegime,
			previousState: "surplus",
			previousCritical: true,
		});
		// Production printed "continues: 0 consecutive measured days showed
		// extraction matching or beating sales", which is a false claim.
		expect(analysis.regime.reason).not.toContain("0 consecutive");
		expect(analysis.regime.reason).toContain("held");
		expect(analysis.regime.reason).toContain("66.4%");
	});

	/**
	 * A held extraction-bound regime on a rig that is FILLING with room left: the
	 * newest measured day extracts 62,138 bbl more than it sells, at 65% fill.
	 *
	 * This is the shape that produced the false cause. The regime is held (so the
	 * capacity section renders its cost line), nothing is being discarded (the
	 * warehouse is nowhere near its cap), and the old renderer read "no sized
	 * discard" as "storage is pinned at the cap" and asserted a present loss at
	 * 65% fill.
	 */
	const fillingWithRoom = (cappedEvidence: boolean) => {
		const days = [45, 52, 58, 62, 64].map((fillPct, i) =>
			record({
				timestamp: FIXED_NOW - (7 - i) * DAY,
				producedMeasured: i !== 0,
				dailyProduced: 323_942,
				stock: {
					barrelPrice: 176,
					inStock: Math.round((fillPct / 100) * 750_000),
					soldAmount: 283_942,
					fillPct,
				},
			}),
		);
		if (cappedEvidence) {
			// A day that WAS at the cap and still out-produced sales, which is the only
			// way `discardedCappedLowerBound` becomes non-zero.
			days.push(
				record({
					timestamp: FIXED_NOW - 2 * DAY,
					producedMeasured: true,
					dailyProduced: 363_942,
					stock: {
						barrelPrice: 176,
						inStock: 750_000,
						soldAmount: 283_942,
						fillPct: 100,
					},
				}),
			);
		}
		// The newest measured day: extraction beats sales, so storage FILLS.
		days.push(
			record({
				timestamp: FIXED_NOW,
				producedMeasured: true,
				dailyProduced: 346_080,
				stock: {
					barrelPrice: 176,
					inStock: Math.round(0.65 * 750_000),
					soldAmount: 283_942,
					fillPct: 65,
				},
			}),
		);
		return days;
	};

	const fillingWithRoomAnalysis = (cappedEvidence: boolean) =>
		analyzeOilRig({
			snapshot: snapshot(65, 176),
			history: fillingWithRoom(cappedEvidence),
			dataBasis: "live",
			asOfSeconds: FIXED_NOW,
			previousRegime: heldRegime,
			previousState: "surplus",
		});

	it("does not claim the cap is binding when the warehouse is at 65% and filling", () => {
		const analysis = fillingWithRoomAnalysis(false);
		const advice = renderDeterministicBriefing(analysis).advice;

		// The preconditions that make the cost line render at all.
		expect(analysis.regime.regime).toBe("extraction_bound");
		expect(analysis.stock.isFillingUp).toBe(true);
		expect(analysis.stock.warehouseCritical).toBe(false);
		expect(analysis.directives.capacityRebalance.extractionBound).toBe(true);

		expect(advice).toContain("Cannot drain");
		// The defect: this said "storage is pinned at the cap" at 65% fill.
		expect(advice).not.toContain("pinned at the cap");
		expect(advice).not.toContain("Losing");
		expect(advice).toContain("Nothing lost yet");
	});

	it("does not report a historical capped-day surplus as a present loss", () => {
		const analysis = fillingWithRoomAnalysis(true);
		const plan = analysis.directives.capacityRebalance;
		const advice = renderDeterministicBriefing(analysis).advice;

		// The evidence exists - days at the cap really did out-produce sales - but the
		// cap is not binding now, so it is context, not a current loss.
		expect(plan.discardedCappedLowerBound).toBeGreaterThan(0);
		expect(plan.discardedBarrelsPerDay).toBe(0);
		expect(analysis.stock.warehouseCritical).toBe(false);

		expect(advice).not.toContain("Losing");
		expect(advice).toContain("Nothing lost yet");
	});

	it("still says the loss cannot be sized when the cap really is binding", () => {
		// Every recorded day at the cap with the delta clamped to zero: extraction
		// matches sales, so nothing is measurable AND nothing is sized.
		const allCapped = Array.from({ length: 6 }, (_, i) =>
			record({
				timestamp: FIXED_NOW - (6 - i) * DAY,
				producedMeasured: i !== 0,
				dailyProduced: 283_942,
				stock: {
					barrelPrice: 176,
					inStock: 750_000,
					soldAmount: 283_942,
					fillPct: 100,
				},
			}),
		);
		const analysis = analyzeOilRig({
			snapshot: {
				...snapshot(100, 176),
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
			history: allCapped,
			dataBasis: "live",
			asOfSeconds: FIXED_NOW,
		});
		const advice = renderDeterministicBriefing(analysis).advice;

		expect(analysis.stock.warehouseCritical).toBe(true);
		expect(analysis.directives.capacityRebalance.discardedBarrelsPerDay).toBe(
			0,
		);
		expect(advice).toContain("pinned at the cap");
		expect(advice).not.toContain("Nothing lost yet");
	});
});

/**
 * A median is a RATE, not a direction.
 *
 * REGRESSION, reproduced from production on 2026-10-08. The last three measured
 * days of extraction were 315,177 / 321,560 / 395,024 bbl/day against sales of
 * 408,372 / 393,305 / 332,886, so storage drained, drained, then GAINED 62,138
 * bbl. The median of that window is 321,560, which is below the latest day's
 * sales of 332,886 - so the drain model read the reversal backwards and the
 * brief reported "draining 11,326 bbl/day, 43.1 days of sales left" from the very
 * tick that measured the warehouse filling.
 *
 * The numbers below are the real ones, so the test fails if the smoothing window
 * is ever allowed to set the direction again.
 */
describe("Extraction direction comes from the newest measured day", () => {
	const PROD_SNAPSHOT: CompanySnapshot = {
		profile: {
			id: 90288,
			name: "Succession Oil",
			rating: 7,
			funds: 400_000_000,
			efficiency: 92,
			environment: 90,
			popularity: 38,
			income: { daily: 59_586_594, weekly: 500_000_000 },
			customers: { daily: 6, weekly: 42 },
			employees: { hired: 19, capacity: 21 },
			upgrades: { storage_capacity: 750_000 },
			advertisement_budget: 5_000_000,
		},
		stock: [
			{
				name: "Crude Oil",
				price: 179,
				in_stock: 488_033,
				sold_amount: 332_886,
				sold_worth: 59_586_594,
			},
		],
		employees: [],
	};

	/** The three recorded days before the reversal, plus the reversal day itself. */
	const drainingDay = record({
		timestamp: FIXED_NOW - 3 * DAY,
		producedMeasured: true,
		dailyProduced: 315_177,
		stock: {
			barrelPrice: 179,
			inStock: 497_640,
			soldAmount: 408_372,
			fillPct: 66.4,
		},
	});
	const lastDrainingDay = record({
		timestamp: FIXED_NOW - 2 * DAY,
		producedMeasured: true,
		dailyProduced: 321_560,
		stock: {
			barrelPrice: 179,
			inStock: 425_895,
			soldAmount: 393_305,
			fillPct: 56.8,
		},
	});
	/** The day storage reversed: 332,886 sold but the warehouse GAINED 62,138. */
	const reversalDay = record({
		timestamp: FIXED_NOW - DAY,
		producedMeasured: true,
		dailyProduced: 395_024,
		stock: {
			barrelPrice: 179,
			inStock: 488_033,
			soldAmount: 332_886,
			fillPct: 65.1,
		},
	});
	const history: OilRigHistoryRecord[] = [
		drainingDay,
		lastDrainingDay,
		reversalDay,
	];

	const analyze = () =>
		analyzeOilRig({
			snapshot: PROD_SNAPSHOT,
			history,
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});

	it("reads the reversal as filling, from the latest day's own delta", () => {
		const analysis = analyze();

		// The median is still reported - it is the extraction RATE, and it is what
		// the discard and roster engines size against.
		expect(analysis.stock.production.dailyProduced).toBe(321_560);
		expect(analysis.stock.production.samples).toBe(3);
		expect(analysis.stock.production.confidence).toBe("high");
		// The newest measured day is carried separately, and it is the one the
		// direction verdict is taken from.
		expect(analysis.stock.production.latestMeasured).toBe(395_024);

		expect(analysis.stock.isFillingUp).toBe(true);
		expect(analysis.stock.netFillPerDay).toBe(62_138);
		expect(analysis.stock.netDrainPerDay).toBeUndefined();
		// 43.1 "days of sales left" was the old, backwards reading.
		expect(analysis.stock.daysOfSales).toBe(INFINITE_DAYS_OF_SALES);
	});

	it("does not print a falling net beside its own rising stock figure", () => {
		const analysis = analyze();
		const briefing = renderDeterministicBriefing(analysis);
		const details = renderCompanyDetails(analysis);

		// Any net the brief states must have the sign of the measured stock change.
		for (const text of [briefing.advice, briefing.actionText, details]) {
			expect(text).not.toContain("storage is falling");
			expect(text).not.toContain("draining");
		}
		// The day the direction was taken from is named in the details block.
		expect(details).toContain("latest day 395,024");
	});

	it("quotes the same day in the flow sentence as in the net it reports", () => {
		// Holding an extraction-bound regime makes the capacity flow sentence
		// render. It used to quote the median there beside a net taken from the
		// newest day: "sales 332,886 vs extraction 321,560 bbl/day, so storage is
		// falling 11,326 bbl/day" - two different days in one sentence, and the
		// wrong sign for the day it was describing.
		const heldRegime: CapacityRegime = {
			regime: "extraction_bound",
			held: true,
			transition: "held",
			dwellDays: 2,
			fillingDays: 2,
			drainingDays: 1,
			since: FIXED_NOW - 2 * DAY,
			reason: "held",
			shortReason: "held",
		};
		const analysis = analyzeOilRig({
			snapshot: PROD_SNAPSHOT,
			history,
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
			previousRegime: heldRegime,
			previousState: "surplus",
		});
		const advice = renderDeterministicBriefing(analysis).advice;

		expect(analysis.stock.production.dailyProduced).toBe(321_560);
		expect(advice).toContain("extraction 395,024 vs sales 332,886");
		expect(advice).not.toContain("321,560 vs sales");
		expect(advice).not.toContain("Draining");
	});

	it("states each telemetry metric as its own labelled field", () => {
		const details = renderCompanyDetails(analyze(), {
			efficiency: 92,
			environment: 90,
			popularity: 38,
			employees: { hired: 19, capacity: 21 },
		});
		const lines = details.split("\n");

		// The old format packed four metrics into one line behind "·" separators -
		// "Daily: revenue A · wages B · ads C · profit D" - so a figure could only
		// be found by counting separators. One metric per labelled field now.
		expect(lines.every((line) => /^• \*\*[^*]+:\*\* .+$/.test(line))).toBe(
			true,
		);
		expect(lines.length).toBe(13);

		expect(details).toContain("• **Daily revenue:** $40,000,000");
		expect(details).toContain("• **Daily wages:** $20,000,000");
		expect(details).toContain("• **Daily ads:** $3,000,000");
		expect(details).toContain("• **Daily profit:** +$18,000,000");
		expect(details).toContain("• **Stock:** 488,033/750,000 (65.1%)");
		expect(details).toContain("• **Barrels sold:** 332,886 bbl/day");
		expect(details).toContain("• **Barrel price:** $179/barrel");
		expect(details).toContain("• **Ad budget:** $5,000,000/day");
		expect(details).toContain("• **Efficiency:** 92%");
		expect(details).toContain("• **Environment:** 90%");
		expect(details).toContain("• **Popularity:** 38%");
		expect(details).toContain("• **Staff:** 19/21");

		// The recorded ad spend and the live ad setting are equal here but come from
		// different sources, so they must stay separately named.
		expect(details).toContain("Daily ads");
		expect(details).toContain("Ad budget");
	});

	it("labels the smoothed figure so it cannot pass for the day's extraction", () => {
		const analysis = analyze();
		const details = renderCompanyDetails(analysis);

		// The old line read "produced 321,560 bbl/day (high confidence)", which
		// looks like today's measurement and contradicts the stock level beside it.
		expect(details).toContain(
			"• **Barrels produced:** 321,560 bbl/day (3-day median, high confidence · latest day 395,024)",
		);

		// The analyst prompt puts the day's own figure under the day's own header.
		const prompt = buildAnalystPrompt({
			analysis,
			history,
			actionText: "",
		}).prompt;
		const dayLine = prompt
			.split("\n")
			.find((line) => line.includes("Barrels sold"));
		expect(dayLine).toBeDefined();
		expect(dayLine).toContain("extraction on this day 395,024 bbl/day");
		expect(dayLine).toContain("3-day median 321,560 bbl/day");
		// And the authoritative summary states both, so the model cannot cite the
		// median as the day's output.
		expect(analysis.stock.production.summary).toContain(
			"The most recent measured day was 395,024 bbl/day.",
		);
	});

	it("still reads a genuine drain as draining", () => {
		// The day before the reversal: sales 393,305 against extraction 321,560.
		const draining = analyzeOilRig({
			snapshot: {
				...PROD_SNAPSHOT,
				stock: [
					{
						name: "Crude Oil",
						price: 179,
						in_stock: 425_895,
						sold_amount: 393_305,
						sold_worth: 70_401_595,
					},
				],
			},
			history: [drainingDay, lastDrainingDay],
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});
		expect(draining.stock.isFillingUp).toBe(false);
		expect(draining.stock.netDrainPerDay).toBe(71_745);
		expect(renderCompanyDetails(draining)).toContain("latest day 321,560");
	});

	it("falls back to sales-days when extraction is unmeasured", () => {
		// One record is not a pair, so nothing is measured and no direction may be
		// asserted - the fix must not turn "unknown" into "filling". The loader
		// flags such a row explicitly, exactly as this does.
		const unmeasured = analyzeOilRig({
			snapshot: PROD_SNAPSHOT,
			history: [{ ...reversalDay, producedMeasured: false }],
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});
		expect(unmeasured.stock.production.latestMeasured).toBeUndefined();
		expect(unmeasured.stock.production.dailyProduced).toBeUndefined();
		expect(unmeasured.stock.isFillingUp).toBe(false);
		expect(unmeasured.stock.netFillPerDay).toBeUndefined();
		expect(unmeasured.stock.daysOfSales).toBe(1.5);
		expect(renderCompanyDetails(unmeasured)).toContain(
			"• **Barrels produced:** unmeasurable",
		);
	});
});
