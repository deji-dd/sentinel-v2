import { describe, expect, it } from "bun:test";
import type { EmployeeData } from "../src/oil-rig";
import {
	analyzeHiringPriorities,
	analyzeSellThroughResponse,
	analyzeStarProgression,
	analyzeStockAndPricing,
	assessCapacityRegime,
	buildBottleneckQuotas,
	type CapacityRegime,
	calcRoleFit,
	calcStatScore,
	deriveRosterBaseline,
	estimateDailyProduced,
	estimateDiscardedBarrels,
	formatHistoryTable,
	getOptimalRoleQuotas,
	INFINITE_DAYS_OF_SALES,
	latestMeasuredProduction,
	OIL_RIG_CAPACITY_POLICY,
	OIL_RIG_POLICY,
	OIL_RIG_ROLES,
	planCapacityRebalance,
	solveOptimalRoster,
} from "../src/oil-rig";
import { analyzeOilRig } from "../src/oil-rig-analysis";
import { adviceSignature } from "../src/oil-rig-render";
import type {
	CompanySnapshot,
	EmployeeSnapshot,
} from "../src/oil-rig-snapshot";

describe("Oil Rig Domain & Solver Engine", () => {
	it("correctly calculates Torn working stats using linear and logarithmic scaling", () => {
		// Linear part below requirement
		const subReq = calcStatScore(75_000, 150_000);
		expect(subReq).toBeCloseTo(22.5, 1);

		// Exactly at requirement
		const exactReq = calcStatScore(150_000, 150_000);
		expect(exactReq).toBe(45);

		// Double requirement gives +5 bonus points
		const doubleReq = calcStatScore(300_000, 150_000);
		expect(doubleReq).toBe(50);
	});

	it("calculates role fit for Driller", () => {
		// Ramirez stats: ~378k MAN, ~163k INT
		const score = calcRoleFit(
			{ manual_labor: 378_000, intelligence: 163_000, endurance: 197_000 },
			OIL_RIG_ROLES.Driller,
		);
		expect(score).toBeGreaterThanOrEqual(100);
	});

	it("calculates target quotas for 17 and 21 seats", () => {
		const q17 = getOptimalRoleQuotas(17);
		expect(q17.Driller).toBe(5);
		expect(q17["Sales Executive"]).toBe(4);
		expect(q17.Roughneck).toBe(3);
		expect(q17["Derrick Hand"]).toBe(2);
		expect(q17["Motor Hand"]).toBe(2);
		expect(q17.Secretary).toBe(1);

		const q21 = getOptimalRoleQuotas(21);
		expect(q21.Driller).toBe(6);
		expect(q21["Sales Executive"]).toBe(5);
		expect(q21.Roughneck).toBe(4);
	});

	it("solves optimal roster assignments and identifies addiction tiers", () => {
		const result = solveOptimalRoster([
			{
				name: "Ramirez",
				position: { name: "Sales Executive" },
				stats: {
					manual_labor: 380_000,
					intelligence: 160_000,
					endurance: 190_000,
				},
				effectiveness: { addiction: 0, settled_in: 10, working_stats: 99 },
			},
			{
				name: "HT-IngCognito",
				position: { name: "Sales Executive" },
				stats: {
					manual_labor: 100_000,
					intelligence: 540_000,
					endurance: 260_000,
				},
				effectiveness: { addiction: 0, settled_in: 10, working_stats: 110 },
			},
			{
				name: "Hog",
				position: { name: "Derrick Hand" },
				stats: {
					manual_labor: 75_000,
					intelligence: 10_000,
					endurance: 45_000,
				},
				effectiveness: { addiction: -12, settled_in: 10, working_stats: 79 },
			},
		]);

		expect(result.rehabTiers.tier1.length).toBe(1);
		expect(result.rehabTiers.tier1[0]?.name).toBe("Hog");
		expect(result.rehabTiers.tier1[0]?.penalty).toBe(-12);
	});

	it("diagnoses deficit, equilibrium, and surplus stock states", () => {
		// Deficit: 28% full, ~17h of sales
		const deficit = analyzeStockAndPricing({
			inStock: 200_000,
			storageCap: 750_000,
			dailySold: 300_000,
			currentPrice: 181,
			adBudget: 3_000_000,
			dailyIncome: 54_300_000,
		});
		expect(deficit.state).toBe("deficit");
		expect(deficit.recommendedPrice.action).toBe("increase");
		expect(deficit.recommendedPrice.min).toBeGreaterThan(181);
		expect(deficit.recommendedAdSpend.action).toBe("freeze");

		// Equilibrium: 50% full, 36h of sales
		const eq = analyzeStockAndPricing({
			inStock: 450_000,
			storageCap: 750_000,
			dailySold: 300_000,
			currentPrice: 184,
			adBudget: 3_000_000,
			dailyIncome: 55_200_000,
		});
		expect(eq.state).toBe("equilibrium");
		expect(eq.recommendedPrice.action).toBe("maintain");

		// Surplus: 80% full
		const surplus = analyzeStockAndPricing({
			inStock: 600_000,
			storageCap: 750_000,
			dailySold: 200_000,
			currentPrice: 186,
			adBudget: 3_000_000,
			dailyIncome: 37_200_000,
		});
		expect(surplus.state).toBe("surplus");
		expect(surplus.recommendedPrice.action).toBe("decrease");
		// A surplus with no measured advertising response justifies exactly ONE
		// bounded probe, sized to what a single advertising rank step is worth
		// (0.5% of daily revenue in the wiki's 80-company field). The old engine
		// added a flat $500k against the *current* budget on every fetch, which is
		// what made the advice loop; a fixed target cannot ratchet.
		expect(surplus.recommendedAdSpend.action).toBe("increase");
		expect(surplus.recommendedAdSpend.amount).toBeGreaterThan(3_000_000);
		expect(surplus.recommendedAdSpend.amount - 3_000_000).toBeLessThanOrEqual(
			OIL_RIG_POLICY.advertising.rounding + 37_200_000 * 0.005,
		);
		expect(surplus.recommendedAdSpend.rationale).toContain("probe");

		// With the probe now in flight - the live setting differs from the recorded
		// tick - the next fetch must ask for nothing and must not compound the spend.
		const whileProbeInFlight = analyzeStockAndPricing({
			inStock: 600_000,
			storageCap: 750_000,
			dailySold: 200_000,
			currentPrice: 186,
			adBudget: surplus.recommendedAdSpend.amount,
			dailyIncome: 37_200_000,
			pendingSettingChange: true,
		});
		expect(whileProbeInFlight.recommendedAdSpend.changeNeeded).toBe(false);
		expect(whileProbeInFlight.recommendedAdSpend.action).toBe("maintain");
	});

	it("recommends hiring priorities based on role deficits", () => {
		const hiring = analyzeHiringPriorities(17, 21, {
			Driller: ["A", "B", "C", "D", "E"],
			"Sales Executive": ["F", "G", "H", "I"],
			Roughneck: ["J", "K", "L"],
			"Derrick Hand": ["M", "N"],
			"Motor Hand": ["O", "P"],
			Secretary: ["Q"],
		});

		expect(hiring.openSeats).toBe(4);
		expect(hiring.priorities.length).toBeGreaterThan(0);
		// Cleaner (Roughneck) should be prioritized
		expect(hiring.priorities[0]?.role).toBe("Roughneck");
	});

	it("analyzes star progression milestones and popularity against top rigs", () => {
		const progression = analyzeStarProgression({
			currentStars: 4,
			weeklyIncome: 373_800_000,
			topCompetitorWeeklyIncome: 1_163_000_000,
			efficiency: 92,
			environment: 94,
			unsettledCount: 1,
			addictedCount: 10,
		});

		expect(progression.currentStars).toBe(4);
		expect(progression.nextStar).toBe(5);
		expect(progression.popularityPct).toBeCloseTo(32.1, 1);
		expect(progression.recommendation).toContain("4★ ➔ 5★");
	});

	it("formats historical markdown table cleanly", () => {
		const table = formatHistoryTable([
			{
				timestamp: 1700000000,
				isoDate: "2026-09-26",
				stars: 4,
				dailyIncome: 55_000_000,
				weeklyIncome: 370_000_000,
				efficiency: 92,
				environment: 94,
				adBudget: 3_000_000,
				stock: {
					barrelPrice: 181,
					inStock: 200_000,
					soldAmount: 300_000,
					fillPct: 26.7,
				},
				metrics: {
					totalAddictionPenalty: 12,
					employeesWithAddiction: 2,
				},
			},
		]);

		expect(table).toContain("2026-09-26");
		expect(table).toContain("$55.0M");
		expect(table).toContain("-12 pts");
	});

	it("accurately calculates Monday of week strictly Monday - Sunday", async () => {
		const { getMondayOfWeek } = await import("../src/oil-rig");

		// 2026-09-28 is Monday
		const mon = new Date("2026-09-28T14:30:00Z");
		expect(getMondayOfWeek(mon).toISOString().slice(0, 10)).toBe("2026-09-28");

		// 2026-09-30 is Wednesday -> Monday was 2026-09-28
		const wed = new Date("2026-09-30T10:00:00Z");
		expect(getMondayOfWeek(wed).toISOString().slice(0, 10)).toBe("2026-09-28");

		// 2026-10-04 is Sunday -> Monday was 2026-09-28
		const sun = new Date("2026-10-04T23:59:59Z");
		expect(getMondayOfWeek(sun).toISOString().slice(0, 10)).toBe("2026-09-28");

		// 2026-10-05 is next Monday -> Monday is 2026-10-05
		const nextMon = new Date("2026-10-05T01:00:00Z");
		expect(getMondayOfWeek(nextMon).toISOString().slice(0, 10)).toBe(
			"2026-10-05",
		);
	});

	it("builds strictly Monday - Sunday week-to-date daily logs and profit (income - wages - ad)", async () => {
		const { buildWeekToDateLogEntries, formatWeekToDateTable } = await import(
			"../src/oil-rig"
		);

		// Reference date: Wednesday 2026-09-30
		const refDate = new Date("2026-09-30T12:00:00Z");

		const history = [
			// Previous week (Sunday 2026-09-27) - MUST BE EXCLUDED
			{
				timestamp: 1700000000,
				isoDate: "2026-09-27",
				stars: 4,
				dailyIncome: 50_000_000,
				weeklyIncome: 350_000_000,
				dailyWages: 3_000_000,
				dailyProfit: 44_000_000,
				adBudget: 3_000_000,
				efficiency: 92,
				environment: 94,
				stock: {
					barrelPrice: 181,
					inStock: 300_000,
					soldAmount: 250_000,
					fillPct: 40,
				},
				metrics: { totalAddictionPenalty: 0, employeesWithAddiction: 0 },
			},
			// Current week Monday 2026-09-28
			{
				timestamp: 1700086400,
				isoDate: "2026-09-28",
				stars: 4,
				dailyIncome: 54_000_000,
				weeklyIncome: 370_000_000,
				dailyWages: 3_500_000,
				dailyProfit: 47_500_000, // 54M - 3.5M - 3M
				adBudget: 3_000_000,
				dailyProduced: 320_000,
				efficiency: 92,
				environment: 94,
				stock: {
					barrelPrice: 181,
					inStock: 320_000,
					soldAmount: 300_000,
					fillPct: 42.7,
				},
				metrics: { totalAddictionPenalty: 0, employeesWithAddiction: 0 },
			},
			// Current week Tuesday 2026-09-29
			{
				timestamp: 1700172800,
				isoDate: "2026-09-29",
				stars: 4,
				dailyIncome: 55_000_000,
				weeklyIncome: 375_000_000,
				dailyWages: 3_500_000,
				dailyProfit: 48_500_000, // 55M - 3.5M - 3M
				adBudget: 3_000_000,
				dailyProduced: 310_000,
				efficiency: 93,
				environment: 95,
				stock: {
					barrelPrice: 181,
					inStock: 330_000,
					soldAmount: 300_000,
					fillPct: 44.0,
				},
				metrics: { totalAddictionPenalty: 0, employeesWithAddiction: 0 },
			},
			// Current week Wednesday 2026-09-30
			{
				timestamp: 1700259200,
				isoDate: "2026-09-30",
				stars: 4,
				dailyIncome: 56_000_000,
				weeklyIncome: 380_000_000,
				dailyWages: 3_500_000,
				dailyProfit: 49_500_000, // 56M - 3.5M - 3M
				adBudget: 3_000_000,
				dailyProduced: 315_000,
				efficiency: 93,
				environment: 95,
				stock: {
					barrelPrice: 181,
					inStock: 340_000,
					soldAmount: 305_000,
					fillPct: 45.3,
				},
				metrics: { totalAddictionPenalty: 0, employeesWithAddiction: 0 },
			},
		];

		const summary = buildWeekToDateLogEntries({
			history,
			referenceDate: refDate,
		});

		// Sunday from previous week was excluded
		expect(summary.entries.length).toBe(3);
		expect(summary.entries[0]?.isoDate).toBe("2026-09-28");
		expect(summary.entries[0]?.dayOfWeek).toBe("Mon");
		expect(summary.entries[1]?.isoDate).toBe("2026-09-29");
		expect(summary.entries[1]?.dayOfWeek).toBe("Tue");
		expect(summary.entries[2]?.isoDate).toBe("2026-09-30");
		expect(summary.entries[2]?.dayOfWeek).toBe("Wed");

		// Today's profit: 56M - 3.5M - 3M = 49.5M
		expect(summary.entries[2]?.profit).toBe(49_500_000);

		// WTD total profit: 47.5M + 48.5M + 49.5M = 145.5M
		expect(summary.totalProfit).toBe(145_500_000);
		expect(summary.totalRevenue).toBe(165_000_000);

		const table = formatWeekToDateTable(summary);
		expect(table).toContain("09-28  Mon");
		expect(table).toContain("09-29  Tue");
		expect(table).toContain("09-30  Wed");
		expect(table).toContain("WTD    Tot");
		expect(table).toContain("+$145.5M");
	});

	it("omits role transfers, target lineups, pricing, ad budget, and 10* roadmap when no changes needed", async () => {
		const { generateAndSendDirectorBriefing } = await import(
			"../src/oil-rig-briefing"
		);

		// Rig where employees are already in target positions, price 181 is maintained, ad budget maintained
		const briefing = await generateAndSendDirectorBriefing({
			isolateFromDatabase: true,
			customSnapshot: {
				profile: {
					name: "Succession Oil",
					rating: 4,
					funds: 50_000_000,
					efficiency: 95,
					environment: 98,
					popularity: 85,
					income: { daily: 55_000_000, weekly: 385_000_000 },
					customers: { daily: 120, weekly: 840 },
					employees: { hired: 4, capacity: 4 },
					upgrades: { storage_capacity: 750_000 },
					advertisement_budget: 3_000_000,
				},
				stock: [
					{
						name: "Crude Oil",
						price: 181,
						in_stock: 450_000, // 60% full (equilibrium)
						sold_amount: 300_000,
						sold_worth: 54_300_000,
					},
				],
				// 4 employees already in target positions for 4 seats
				employees: [
					{
						id: 1,
						name: "Emp1",
						position: { id: 1, name: "Driller" },
						days_in_company: 50,
						wage: 1_000_000,
						stats: {
							manual_labor: 300_000,
							intelligence: 100_000,
							endurance: 100_000,
						},
						effectiveness: {
							working_stats: 100,
							settled_in: 10,
							director_education: 0,
							addiction: 0,
							inactivity: 0,
							total: 110,
						},
					},
					{
						id: 2,
						name: "Emp2",
						position: { id: 2, name: "Sales Executive" },
						days_in_company: 50,
						wage: 1_000_000,
						stats: {
							manual_labor: 100_000,
							intelligence: 400_000,
							endurance: 100_000,
						},
						effectiveness: {
							working_stats: 100,
							settled_in: 10,
							director_education: 0,
							addiction: 0,
							inactivity: 0,
							total: 110,
						},
					},
					{
						id: 3,
						name: "Emp3",
						position: { id: 3, name: "Roughneck" },
						days_in_company: 50,
						wage: 800_000,
						stats: {
							manual_labor: 150_000,
							intelligence: 50_000,
							endurance: 80_000,
						},
						effectiveness: {
							working_stats: 100,
							settled_in: 10,
							director_education: 0,
							addiction: 0,
							inactivity: 0,
							total: 110,
						},
					},
					{
						id: 4,
						name: "Emp4",
						position: { id: 4, name: "Secretary" },
						days_in_company: 50,
						wage: 700_000,
						stats: {
							manual_labor: 50_000,
							intelligence: 100_000,
							endurance: 200_000,
						},
						effectiveness: {
							working_stats: 100,
							settled_in: 10,
							director_education: 0,
							addiction: 0,
							inactivity: 0,
							total: 110,
						},
					},
				],
			},
			fetchHistory: async () => [],
		});

		// 10* Progression Roadmap must be completely gone
		expect(briefing).not.toContain("10★ Progression Roadmap");
		expect(briefing).not.toContain("10* Progression Roadmap");

		// If no transfers needed, Role Transfers & Target Lineup must be omitted
		expect(briefing).not.toContain("**Role Transfers:**");
		expect(briefing).not.toContain("**Target Lineup:**");

		// If equilibrium and no price/ad change, pricing and ad budget must be omitted
		expect(briefing).not.toContain("**Pricing:**");
		expect(briefing).not.toContain("**Ad Budget:**");
	});

	it("verifies profit calculations are taken from DB snapshots and immune to live wage changes", async () => {
		const { generateAndSendDirectorBriefing } = await import(
			"../src/oil-rig-briefing"
		);

		// DB snapshot has dailyIncome: 55M, dailyWages: 3.5M, adBudget: 3M -> Profit: 48.5M
		const history = [
			{
				timestamp: 1700086400,
				isoDate: "2026-09-28",
				stars: 4,
				dailyIncome: 55_000_000,
				weeklyIncome: 375_000_000,
				dailyWages: 3_500_000,
				dailyProfit: 48_500_000,
				adBudget: 3_000_000,
				dailyProduced: 320_000,
				efficiency: 95,
				environment: 98,
				stock: {
					barrelPrice: 181,
					inStock: 400_000,
					soldAmount: 300_000,
					fillPct: 53.3,
				},
				metrics: { totalAddictionPenalty: 0, employeesWithAddiction: 0 },
			},
		];

		// Live data has employee wages changed to 10M, but profit should still show DB snapshot profit (+48.5M)!
		const briefing = await generateAndSendDirectorBriefing({
			isolateFromDatabase: true,
			customSnapshot: {
				profile: {
					name: "Succession Oil",
					rating: 4,
					funds: 50_000_000,
					efficiency: 95,
					environment: 98,
					popularity: 85,
					income: { daily: 55_000_000, weekly: 385_000_000 },
					customers: { daily: 120, weekly: 840 },
					employees: { hired: 1, capacity: 4 },
					upgrades: { storage_capacity: 750_000 },
					advertisement_budget: 3_000_000,
				},
				stock: [
					{
						name: "Crude Oil",
						price: 181,
						in_stock: 400_000,
						sold_amount: 300_000,
						sold_worth: 54_300_000,
					},
				],
				employees: [
					{
						id: 1,
						name: "Emp1",
						position: { id: 1, name: "Driller" },
						days_in_company: 50,
						wage: 10_000_000, // LIVE WAGE ALTERED MID-DAY
						stats: {
							manual_labor: 300_000,
							intelligence: 100_000,
							endurance: 100_000,
						},
						effectiveness: {
							working_stats: 100,
							settled_in: 10,
							director_education: 0,
							addiction: 0,
							inactivity: 0,
							total: 110,
						},
					},
				],
			},
			fetchHistory: async () => history,
		});

		// Profit must be +$48,500,000 from the DB snapshot, NOT 55M - 10M - 3M = 42M
		expect(briefing).toContain("+$48,500,000");
		expect(briefing).not.toContain("+$42,000,000");
	});
});

describe("Oil Rig stock & pricing advice is idempotent", () => {
	// Real production telemetry (2026-10-04): storage pinned at 100% while
	// extraction matched sales, which is the case that used to loop forever.
	const FULL_RIG = {
		inStock: 750_000,
		storageCap: 750_000,
		dailySold: 283_942,
		dailyProduced: 283_942,
		dailyIncome: 49_973_792,
	};

	it("converges after one application instead of demanding the same change forever", () => {
		let price = 185;
		let adBudget = 3_000_000;
		let changesApplied = 0;
		let firstSettledFetch = -1;

		for (let fetch = 0; fetch < 24; fetch++) {
			// Once the ad budget has been applied, the live setting is ahead of the
			// recorded tick: a probe is in flight and must not be repeated.
			const advice = analyzeStockAndPricing({
				...FULL_RIG,
				currentPrice: price,
				adBudget,
				pendingSettingChange: changesApplied > 0,
			});
			const asksForSomething =
				advice.recommendedPrice.changeNeeded ||
				advice.recommendedAdSpend.changeNeeded;
			if (advice.recommendedPrice.changeNeeded) {
				price = advice.recommendedPrice.exact;
				changesApplied++;
			}
			if (advice.recommendedAdSpend.changeNeeded) {
				adBudget = advice.recommendedAdSpend.amount;
				changesApplied++;
			}
			if (!asksForSomething && firstSettledFetch === -1) {
				firstSettledFetch = fetch;
			}
		}

		// It stops. The advice reaches a fixpoint early and then asks for nothing on
		// every subsequent fetch, however many times it is asked - the failure this
		// test exists for is advice that never settles.
		expect(firstSettledFetch).toBeGreaterThan(0);
		expect(firstSettledFetch).toBeLessThan(6);
		expect(changesApplied).toBeLessThanOrEqual(4);

		// The price walks to the band floor in bounded steps rather than jumping or
		// ratcheting; the ad budget moves once, by one rank step.
		expect(price).toBe(OIL_RIG_POLICY.price.floor);
		expect(adBudget).toBe(3_200_000);

		const settled = analyzeStockAndPricing({
			...FULL_RIG,
			currentPrice: price,
			adBudget,
			pendingSettingChange: true,
		});
		expect(settled.recommendedPrice.changeNeeded).toBe(false);
		expect(settled.recommendedAdSpend.changeNeeded).toBe(false);
	});

	it("never recommends an ad increase beyond the revenue ceiling", () => {
		// Even from an implausibly low budget the target stays bounded, and the step
		// is capped at what one advertising rank is worth.
		const low = analyzeStockAndPricing({
			...FULL_RIG,
			currentPrice: 180,
			adBudget: 0,
		});
		expect(low.recommendedAdSpend.action).toBe("increase");
		expect(low.recommendedAdSpend.amount).toBeLessThanOrEqual(
			FULL_RIG.dailyIncome * 0.15,
		);
		expect(low.recommendedAdSpend.amount).toBeLessThanOrEqual(
			low.adRankModel.revenuePerRankStepPerDay +
				OIL_RIG_POLICY.advertising.rounding,
		);

		// A budget already above the ceiling is actively brought back down, which
		// the old revenue-share model never did.
		const over = analyzeStockAndPricing({
			...FULL_RIG,
			currentPrice: 180,
			adBudget: 20_000_000,
		});
		expect(over.recommendedAdSpend.action).toBe("decrease");
		expect(over.recommendedAdSpend.changeNeeded).toBe(true);
		expect(over.recommendedAdSpend.amount).toBeLessThanOrEqual(
			over.adRankModel.operationalCapPerDay,
		);
		expect(over.recommendedAdSpend.rationale).toContain("rank");
	});

	it("still raises an ad budget that sits below the revenue-bounded target", () => {
		const advice = analyzeStockAndPricing({
			...FULL_RIG,
			currentPrice: 180,
			adBudget: 1_000_000,
		});
		expect(advice.recommendedAdSpend.action).toBe("increase");
		expect(advice.recommendedAdSpend.changeNeeded).toBe(true);
		expect(advice.recommendedAdSpend.basis).toBe("probe");

		// One bounded step, not a leap to a share of revenue.
		expect(advice.recommendedAdSpend.amount).toBe(
			1_000_000 +
				Math.round(advice.adRankModel.revenuePerRankStepPerDay / 100_000) *
					100_000,
		);

		// Applying it once is sufficient: the next fetch, with that change in
		// flight, asks for nothing.
		const next = analyzeStockAndPricing({
			...FULL_RIG,
			currentPrice: 180,
			adBudget: advice.recommendedAdSpend.amount,
			pendingSettingChange: true,
		});
		expect(next.recommendedAdSpend.changeNeeded).toBe(false);
	});

	it("never recommends cutting the price below the competitive band floor", () => {
		const advice = analyzeStockAndPricing({
			...FULL_RIG,
			currentPrice: 176,
			adBudget: 4_900_000,
		});
		expect(advice.recommendedPrice.action).toBe("maintain");
		expect(advice.recommendedPrice.exact).toBe(176);
		expect(advice.recommendedPrice.changeNeeded).toBe(false);
	});

	it("does not ask for a price cut it has measured to be ineffective", () => {
		// The stock engines and the sell-through analysis used to disagree in the
		// same briefing: this computed "price cuts are NOT working" while the price
		// engine recommended another cut. The verdict is now wired in.
		const unheard = analyzeStockAndPricing({
			...FULL_RIG,
			currentPrice: 186,
			adBudget: 4_900_000,
			priceLever: "does_not_work",
		});
		expect(unheard.state).toBe("surplus");
		expect(unheard.recommendedPrice.changeNeeded).toBe(false);
		expect(unheard.recommendedPrice.basis).toBe("measured_unresponsive");
		expect(unheard.recommendedPrice.rationale).toContain(
			"sell-through capacity",
		);
	});

	it("reports the structural constraint when a full warehouse still outruns sales", () => {
		const advice = analyzeStockAndPricing({
			...FULL_RIG,
			currentPrice: 176,
			adBudget: 4_900_000,
			priceLever: "works",
		});
		expect(advice.isFillingUp).toBe(true);
		expect(advice.warehouseCritical).toBe(true);
		expect(advice.daysOfSales).toBe(INFINITE_DAYS_OF_SALES);
		expect(advice.structuralAdvice).toContain("sell-through capacity");
		expect(advice.structuralAdvice).toContain("no price removes a cap");
	});

	it("holds an inventory state across the deadband instead of chattering", () => {
		// One hard threshold meant 77.9% and 78.1% gave opposite advice. Entering
		// and leaving on different thresholds removes the boundary entirely.
		const justUnder = analyzeStockAndPricing({
			inStock: 0.77 * 750_000,
			storageCap: 750_000,
			dailySold: 200_000,
			currentPrice: 181,
			adBudget: 3_000_000,
			dailyIncome: 37_200_000,
		});
		expect(justUnder.state).toBe("equilibrium");

		const justOver = analyzeStockAndPricing({
			inStock: 0.79 * 750_000,
			storageCap: 750_000,
			dailySold: 200_000,
			currentPrice: 181,
			adBudget: 3_000_000,
			dailyIncome: 37_200_000,
		});
		expect(justOver.state).toBe("surplus");

		// Sitting between the enter and the exit threshold, the state is whatever it
		// already was - which is the whole point of the hysteresis.
		const held = analyzeStockAndPricing({
			inStock: 0.75 * 750_000,
			storageCap: 750_000,
			dailySold: 200_000,
			currentPrice: 181,
			adBudget: 3_000_000,
			dailyIncome: 37_200_000,
			previousState: "surplus",
		});
		expect(held.state).toBe("surplus");
		expect(held.stateHeld).toBe(true);

		const released = analyzeStockAndPricing({
			inStock: 0.75 * 750_000,
			storageCap: 750_000,
			dailySold: 200_000,
			currentPrice: 181,
			adBudget: 3_000_000,
			dailyIncome: 37_200_000,
			previousState: "equilibrium",
		});
		expect(released.state).toBe("equilibrium");
	});

	it("asks for no ad change in a deficit and keeps the price target absolute", () => {
		const deficit = analyzeStockAndPricing({
			inStock: 200_000,
			storageCap: 750_000,
			dailySold: 300_000,
			currentPrice: 181,
			adBudget: 3_000_000,
			dailyIncome: 54_300_000,
		});
		expect(deficit.recommendedPrice.action).toBe("increase");
		expect(deficit.recommendedAdSpend.changeNeeded).toBe(false);

		const atTarget = analyzeStockAndPricing({
			inStock: 200_000,
			storageCap: 750_000,
			dailySold: 300_000,
			currentPrice: deficit.recommendedPrice.exact,
			adBudget: 3_000_000,
			dailyIncome: 54_300_000,
		});
		expect(atTarget.recommendedPrice.changeNeeded).toBe(false);
	});

	it("amortises extraction across multi-day snapshot gaps", () => {
		// A 3-day gap with stock up only 150k and 100k sold on the final day is
		// ~150k/day, not the 250k/day the un-amortised delta + sold form implied.
		const estimate = estimateDailyProduced({
			current: { inStock: 750_000, sold: 100_000, timestamp: 400_000_000 },
			previous: { inStock: 600_000, timestamp: 400_000_000 - 3 * 86_400 },
		});
		expect(estimate).toBe(150_000);

		// A consecutive-day gap collapses to the original delta + sold form.
		const consecutive = estimateDailyProduced({
			current: { inStock: 750_000, sold: 283_942, timestamp: 400_000_000 },
			previous: { inStock: 740_000, timestamp: 400_000_000 - 86_400 },
		});
		expect(consecutive).toBe(293_942);
	});
});

describe("Director briefing loops regression", () => {
	const FULL_WAREHOUSE_HISTORY = [
		{
			timestamp: 1_759_000_000,
			isoDate: "2026-10-03",
			stars: 4,
			dailyIncome: 49_973_792,
			weeklyIncome: 349_816_544,
			dailyWages: 3_500_000,
			dailyProfit: 42_073_792,
			adBudget: 3_000_000,
			dailyProduced: 283_942,
			efficiency: 90,
			environment: 97,
			stock: {
				barrelPrice: 179,
				inStock: 740_000,
				soldAmount: 269_102,
				fillPct: 98.7,
			},
			metrics: { totalAddictionPenalty: 0, employeesWithAddiction: 0 },
		},
		{
			timestamp: 1_759_086_400,
			isoDate: "2026-10-04",
			stars: 4,
			dailyIncome: 49_973_792,
			weeklyIncome: 349_816_544,
			dailyWages: 3_500_000,
			dailyProfit: 42_073_792,
			adBudget: 3_000_000, // recorded tick: stale relative to the live setting
			dailyProduced: 293_942,
			efficiency: 92,
			environment: 100,
			stock: {
				barrelPrice: 180,
				inStock: 750_000,
				soldAmount: 283_942,
				fillPct: 100,
			},
			metrics: { totalAddictionPenalty: 0, employeesWithAddiction: 0 },
		},
	];

	const fullWarehouseSnapshot = {
		profile: {
			name: "Succession Oil",
			rating: 4,
			funds: 50_000_000,
			efficiency: 92,
			environment: 100,
			popularity: 30,
			income: { daily: 49_973_792, weekly: 349_816_544 },
			customers: { daily: 2, weekly: 14 },
			employees: { hired: 4, capacity: 4 },
			upgrades: { storage_capacity: 750_000 },
			// Live setting already at the revenue-bounded target.
			advertisement_budget: 4_900_000,
		},
		stock: [
			{
				name: "Crude Oil",
				price: 180,
				in_stock: 750_000,
				sold_amount: 283_942,
				sold_worth: 51_109_560,
			},
		],
		employees: [
			{
				id: 1,
				name: "Emp1",
				position: { id: 1, name: "Driller" },
				days_in_company: 50,
				wage: 1_000_000,
				stats: {
					manual_labor: 300_000,
					intelligence: 100_000,
					endurance: 100_000,
				},
				effectiveness: {
					working_stats: 100,
					settled_in: 10,
					director_education: 0,
					addiction: 0,
					inactivity: 0,
					total: 110,
				},
			},
		],
	};

	it("does not repeat the ad-budget demand when the live setting already matches the target", async () => {
		const { generateAndSendDirectorBriefing } = await import(
			"../src/oil-rig-briefing"
		);

		const briefing = await generateAndSendDirectorBriefing({
			isolateFromDatabase: true,
			customSnapshot: fullWarehouseSnapshot,
			fetchHistory: async () => FULL_WAREHOUSE_HISTORY,
		});

		// The recorded tick spent $3M but the live setting is $4.9M, which is the
		// target, so no ad or price bullet may be emitted...
		expect(briefing).not.toContain("**Ad Budget:**");
		expect(briefing).not.toContain("**Pricing:**");
		// ...but the real blocker must be stated.
		expect(briefing).toContain("Cannot drain");
		expect(briefing).toContain("sell-through capacity");
	});

	it("delivers advice plus details only, and keeps the model out of the action list", async () => {
		const { generateAndSendDirectorBriefing } = await import(
			"../src/oil-rig-briefing"
		);

		const realFetch = globalThis.fetch;
		const savedEnv = {
			DISCORD_TOKEN: process.env.DISCORD_TOKEN,
			DISCORD_USER_ID: process.env.DISCORD_USER_ID,
			GEMINI_API_KEY: process.env.GEMINI_API_KEY,
		};
		const payloads: Array<{ content?: string }> = [];
		let prompt = "";

		process.env.DISCORD_TOKEN = "test-token";
		process.env.DISCORD_USER_ID = "1";
		process.env.GEMINI_API_KEY = "test-key";

		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			const target = String(url);
			if (target.includes("generativelanguage")) {
				const body = JSON.parse(String(init?.body)) as {
					contents: Array<{ parts: Array<{ text: string }> }>;
				};
				prompt = body.contents[0]?.parts[0]?.text ?? "";
				return new Response(
					JSON.stringify({
						candidates: [
							{ content: { parts: [{ text: "• Analyst bullet." }] } },
						],
					}),
					{ status: 200 },
				);
			}
			if (target.endsWith("/channels")) {
				return new Response(JSON.stringify({ id: "channel-1" }), {
					status: 200,
				});
			}
			payloads.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ id: "message-1" }), {
				status: 200,
			});
		}) as typeof fetch;

		try {
			const briefing = await generateAndSendDirectorBriefing({
				isolateFromDatabase: true,
				customSnapshot: fullWarehouseSnapshot,
				fetchHistory: async () => FULL_WAREHOUSE_HISTORY,
			});

			// Plain markdown messages, chunked so nothing is truncated. The previous
			// delivery sliced the advice at 4,000 characters for an embed description,
			// which silently cut the brief off mid-sentence.
			expect(payloads.length).toBeGreaterThanOrEqual(1);
			const delivered = payloads.map((p) => p.content ?? "");
			for (const message of delivered) {
				expect(message.length).toBeLessThanOrEqual(2000);
				expect(message.length).toBeGreaterThan(0);
			}
			const wholeDelivery = delivered.join("\n");
			expect(wholeDelivery).toContain("Operations Brief");
			expect(wholeDelivery).toContain("• Analyst bullet.");

			// The model's output is additive analysis, never the authoritative list.
			expect(briefing).toContain("### Analyst Notes");
			expect(briefing).toContain("• Analyst bullet.");
			expect(briefing.indexOf("### Do This")).toBeLessThan(
				briefing.indexOf("### Analyst Notes"),
			);

			// The prompt carries computed facts only, and no invented benchmark.
			expect(prompt).toContain("Do NOT repeat or reformat the action list");
			expect(prompt).toContain("COMPUTED ANALYSIS");
			expect(prompt).not.toContain("COMPETITOR & MARKET BENCHMARK");
			expect(prompt).not.toContain("10★ Oil Rigs Industry Benchmark");
		} finally {
			globalThis.fetch = realFetch;
			for (const [key, value] of Object.entries(savedEnv)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	});
});

describe("Capacity rebalance (smart employee re-arrangement)", () => {
	// 19 staff, mirroring the real rig: quotas are 6 Driller, 4 Sales, 4
	// Roughneck, 2 Derrick, 2 Motor, 1 Secretary.
	const build19 = (): EmployeeData[] => {
		// Role names are the canonical Torn position names. The fixture used to use
		// abbreviations ("Rough", "Derrick"), which no longer round-trips: an
		// unrecognised role name matches no quota, so the roster would look entirely
		// off-target and the plan would demand a full reshuffle.
		const roster: Array<[string, string, number, number, number]> = [];
		for (let i = 0; i < 6; i++)
			roster.push([`Driller${i}`, "Driller", 300_000, 100_000, 150_000]);
		for (let i = 0; i < 4; i++)
			roster.push([`Sales${i}`, "Sales Executive", 60_000, 400_000, 120_000]);
		for (let i = 0; i < 4; i++)
			roster.push([`Rough${i}`, "Roughneck", 150_000, 60_000, 90_000]);
		for (let i = 0; i < 2; i++)
			roster.push([`Derrick${i}`, "Derrick Hand", 160_000, 70_000, 120_000]);
		for (let i = 0; i < 2; i++)
			roster.push([`Motor${i}`, "Motor Hand", 180_000, 90_000, 110_000]);
		roster.push(["Secretary0", "Secretary", 60_000, 90_000, 220_000]);

		return roster.map(([name, role, man, int, end], idx) => ({
			id: idx + 1,
			name,
			position: { id: idx, name: role },
			days_in_company: 60,
			stats: { manual_labor: man, intelligence: int, endurance: end },
			effectiveness: {
				working_stats: 100,
				settled_in: 10,
				director_education: 0,
				addiction: 0,
				inactivity: 0,
				total: 110,
			},
		}));
	};

	const fullWarehouseStock = analyzeStockAndPricing({
		inStock: 750_000,
		storageCap: 750_000,
		dailySold: 283_942,
		dailyProduced: 283_942,
		currentPrice: 176,
		adBudget: 4_500_000,
		dailyIncome: 49_973_792,
	});

	/**
	 * Regimes the plan is given rather than left to infer. `planCapacityRebalance`
	 * requires one, because its old empty-history fallback could report `balanced`
	 * for a rig that was filling, contradicting the plan's own `extractionBound`.
	 */
	const boundRegime: CapacityRegime = {
		regime: "extraction_bound",
		held: false,
		transition: "entered",
		dwellDays: 2,
		fillingDays: 2,
		drainingDays: 0,
		since: 1_790_705_443,
		reason:
			"storage at 100%, where output above the sales rate cannot be stored",
		shortReason: "storage at 100%",
	};
	const balancedRegime: CapacityRegime = {
		regime: "balanced",
		held: false,
		transition: "none",
		dwellDays: 0,
		fillingDays: 0,
		drainingDays: 0,
		since: 1_790_705_443,
		reason: "extraction and sell-through balanced",
		shortReason: "extraction and sell-through balanced",
	};

	it("moves seats from extraction into sell-through without changing headcount", () => {
		const base = getOptimalRoleQuotas(19);
		expect(base.Driller).toBe(6);
		expect(base["Sales Executive"]).toBe(4);

		const { quotas, shifts } = buildBottleneckQuotas(base, {
			extractionBound: true,
		});

		expect(quotas["Sales Executive"]).toBe(6);
		expect(quotas["Motor Hand"]).toBe(1);
		expect(quotas["Derrick Hand"]).toBe(1);
		expect(quotas.Driller).toBe(6);
		// Seats are moved, never created.
		const sum = (q: Record<string, number>) =>
			Object.values(q).reduce((a, b) => a + b, 0);
		expect(sum(quotas)).toBe(sum(base));
		expect(shifts.length).toBeGreaterThan(0);
	});

	it("leaves the blueprint untouched when extraction is not the bottleneck", () => {
		const base = getOptimalRoleQuotas(19);
		const { quotas, shifts } = buildBottleneckQuotas(base, {
			extractionBound: false,
		});
		expect(quotas).toEqual(base);
		expect(shifts).toEqual([]);
	});

	it("never draws an extraction role below its floor", () => {
		// Only one motor hand and one derrick hand available to give up.
		const { quotas } = buildBottleneckQuotas(
			{ Driller: 6, "Sales Executive": 4, "Motor Hand": 1, "Derrick Hand": 1 },
			{ extractionBound: true },
		);
		expect(quotas["Motor Hand"]).toBe(
			OIL_RIG_CAPACITY_POLICY.minExtractionRoleCount,
		);
		expect(quotas["Derrick Hand"]).toBe(
			OIL_RIG_CAPACITY_POLICY.minExtractionRoleCount,
		);
		expect(quotas.Driller).toBeGreaterThanOrEqual(
			OIL_RIG_CAPACITY_POLICY.minExtractionRoleCount,
		);
	});

	it("produces a coherent plan with a rebalance and a hire action", () => {
		// The regime is a premise of this test, not its subject: the plan takes it as
		// input now rather than inferring one, so the fixture states it outright. The
		// engine's own entry rules are covered by the regime tests.
		const plan = planCapacityRebalance({
			staffCount: 19,
			stock: fullWarehouseStock,
			barrelPrice: 176,
			openSeats: 2,
			discardedBarrelsPerDay: 94_517,
			regime: boundRegime,
		});

		expect(plan.extractionBound).toBe(true);
		expect(plan.discardedBarrelsPerDay).toBe(94_517);
		expect(plan.discardedValuePerDay).toBe(94_517 * 176);
		expect(plan.actions.map((a) => a.kind)).toEqual(["rebalance", "hire"]);
		// Reallocating existing staff is the primary fix and is reversible.
		expect(plan.actions[0]?.temporary).toBe(true);
	});

	it("reports nothing to do when extraction is not bound", () => {
		const healthy = analyzeStockAndPricing({
			inStock: 400_000,
			storageCap: 750_000,
			dailySold: 300_000,
			dailyProduced: 200_000,
			currentPrice: 181,
			adBudget: 3_000_000,
			dailyIncome: 54_300_000,
		});
		const plan = planCapacityRebalance({
			staffCount: 19,
			stock: healthy,
			barrelPrice: 181,
			openSeats: 2,
			regime: balancedRegime,
		});
		expect(plan.extractionBound).toBe(false);
		expect(plan.actions).toEqual([]);
		expect(plan.quotaShifts).toEqual([]);
	});

	it("cannot contradict the regime, which is now its only verdict", () => {
		// THE DEFECT THIS REPLACES: the plan used to infer a regime from EMPTY history
		// (so it could only ever see critical fill) while taking `extractionBound` from
		// the single-day stock flags. A rig that was filling below the cap therefore
		// produced `extractionBound: true` beside `regime: "balanced"`.
		const fillingBelowPressure = analyzeStockAndPricing({
			inStock: 375_000, // 50% full, under the 78% pressure threshold
			storageCap: 750_000,
			dailySold: 283_942,
			dailyProduced: 323_942, // extraction outruns sales, so storage IS filling
			currentPrice: 176,
			adBudget: 4_500_000,
			dailyIncome: 49_973_792,
		});
		// The raw single-day flag really does say "filling" - it is what used to drive
		// the plan, and it is why the two fields could disagree.
		expect(fillingBelowPressure.isFillingUp).toBe(true);
		expect(fillingBelowPressure.warehouseCritical).toBe(false);

		// The regime says balanced: net fill below the healthy buffer is desirable, not
		// a bottleneck, and one day is not a trend.
		const regime = assessCapacityRegime({
			history: [],
			fillPct: fillingBelowPressure.fillPct,
			asOfSeconds: 1_790_705_443,
		});
		expect(regime.regime).toBe("balanced");

		const plan = planCapacityRebalance({
			staffCount: 19,
			stock: fillingBelowPressure,
			barrelPrice: 176,
			openSeats: 0,
			regime,
		});

		// Both fields follow the regime, and it is passed through unrecomputed.
		expect(plan.regime).toBe(regime);
		expect(plan.extractionBound).toBe(false);
		expect(plan.summary).not.toContain("still need to move");
	});

	it("keeps the target lineup and the rebalance advice in agreement", () => {
		// The roster solver must consume the same bottleneck, or the lineup would
		// recommend a different shape from the capacity advice.
		const employees = build19();
		const base = solveOptimalRoster(employees);
		const rebalanced = solveOptimalRoster(employees, {
			bottleneck: { extractionBound: true },
		});

		expect(base.rosterByRole["Sales Executive"]?.length).toBe(4);
		expect(rebalanced.rosterByRole["Sales Executive"]?.length).toBe(6);
		// Every seat still filled: 19 staff across 19 seats.
		const total = Object.values(rebalanced.rosterByRole).reduce(
			(sum, members) => sum + members.length,
			0,
		);
		expect(total).toBe(19);
	});

	it("wires the bottleneck through the briefing so both sections agree", async () => {
		const { generateAndSendDirectorBriefing } = await import(
			"../src/oil-rig-briefing"
		);

		const employees = build19().map((e) => ({
			id: e.id ?? 0,
			name: e.name,
			position: e.position ?? null,
			days_in_company: e.days_in_company ?? 0,
			wage: 1_500_000,
			stats: {
				manual_labor: e.stats.manual_labor ?? 0,
				intelligence: e.stats.intelligence ?? 0,
				endurance: e.stats.endurance ?? 0,
			},
			effectiveness: {
				working_stats: 100,
				settled_in: 10,
				director_education: 0,
				addiction: 0,
				inactivity: 0,
				total: 110,
			},
		}));

		const briefing = await generateAndSendDirectorBriefing({
			isolateFromDatabase: true,
			customSnapshot: {
				profile: {
					name: "Succession Oil",
					rating: 4,
					funds: 50_000_000,
					efficiency: 92,
					environment: 100,
					popularity: 30,
					income: { daily: 49_973_792, weekly: 349_816_544 },
					customers: { daily: 2, weekly: 14 },
					employees: { hired: 19, capacity: 21 },
					upgrades: { storage_capacity: 750_000 },
					advertisement_budget: 4_500_000,
				},
				stock: [
					{
						name: "Crude Oil",
						price: 176,
						in_stock: 750_000,
						sold_amount: 283_942,
						sold_worth: 49_973_792,
					},
				],
				employees,
			},
			fetchHistory: async () => [],
		});

		// The capacity section must appear, with the rebalance as the lead action.
		expect(briefing).toContain("### Capacity");
		expect(briefing).toContain("**Rebalance:**");
		expect(briefing).toContain("2 seats move into Sales Executive (4 ➔ 6)");

		// ...and the target lineup must show exactly the shifted sell-through
		// headcount, not a separate opinion.
		const salesLine = briefing
			.split("\n")
			.find((line) => line.includes("**Sales Executive** ("));
		expect(salesLine).toContain("**Sales Executive** (6)");
	});

	it("does not rebalance a rig whose stock is draining normally", async () => {
		const { generateAndSendDirectorBriefing } = await import(
			"../src/oil-rig-briefing"
		);

		const briefing = await generateAndSendDirectorBriefing({
			isolateFromDatabase: true,
			customSnapshot: {
				profile: {
					name: "Succession Oil",
					rating: 4,
					funds: 50_000_000,
					efficiency: 92,
					environment: 100,
					popularity: 60,
					income: { daily: 40_000_000, weekly: 280_000_000 },
					customers: { daily: 50, weekly: 350 },
					employees: { hired: 4, capacity: 21 },
					upgrades: { storage_capacity: 750_000 },
					advertisement_budget: 3_000_000,
				},
				stock: [
					{
						name: "Crude Oil",
						price: 181,
						in_stock: 400_000,
						sold_amount: 300_000,
						sold_worth: 54_300_000,
					},
				],
				employees: [],
			},
			fetchHistory: async () => [],
		});

		expect(briefing).not.toContain("**Rebalance:**");
	});
});

describe("Sell-through response and discarded output analysis", () => {
	const makeHistory = (
		rows: Array<{
			price: number;
			sold: number;
			produced?: number;
			fill: number;
		}>,
	) =>
		rows.map((r, idx) => ({
			timestamp: 1_759_000_000 + idx * 86_400,
			isoDate: `2026-10-0${idx + 1}`,
			stars: 4,
			dailyIncome: r.sold * r.price,
			weeklyIncome: r.sold * r.price * 7,
			dailyWages: 3_500_000,
			dailyProfit: r.sold * r.price - 3_500_000,
			dailyProduced: r.produced,
			adBudget: 3_000_000,
			efficiency: 90,
			environment: 96,
			stock: {
				barrelPrice: r.price,
				inStock: 400_000,
				soldAmount: r.sold,
				fillPct: r.fill,
			},
			metrics: { totalAddictionPenalty: 0, employeesWithAddiction: 0 },
		}));

	it("concludes price cuts are not working when volume does not follow", () => {
		const analysis = analyzeSellThroughResponse(
			makeHistory([
				{ price: 185, sold: 270_000, fill: 80 },
				{ price: 185, sold: 271_000, fill: 84 },
				{ price: 185, sold: 269_000, fill: 88 },
				{ price: 176, sold: 270_500, fill: 95 },
				{ price: 176, sold: 271_500, fill: 99 },
				{ price: 176, sold: 270_000, fill: 100 },
			]),
		);
		expect(analysis.verdict).toBe("unresponsive");
		expect(analysis.summary).toContain("NOT working");
	});

	it("recognises a genuinely responsive price cut", () => {
		const analysis = analyzeSellThroughResponse(
			makeHistory([
				{ price: 185, sold: 200_000, fill: 80 },
				{ price: 185, sold: 205_000, fill: 82 },
				{ price: 185, sold: 198_000, fill: 84 },
				{ price: 176, sold: 280_000, fill: 60 },
				{ price: 176, sold: 285_000, fill: 55 },
				{ price: 176, sold: 282_000, fill: 52 },
			]),
		);
		expect(analysis.verdict).toBe("responsive");
	});

	it("does not draw a conclusion from too little data", () => {
		const analysis = analyzeSellThroughResponse(
			makeHistory([
				{ price: 185, sold: 270_000, fill: 80 },
				{ price: 176, sold: 280_000, fill: 90 },
			]),
		);
		expect(analysis.verdict).toBe("insufficient_data");
	});

	it("measures discarded output only from days storage was not full", () => {
		const discarded = estimateDiscardedBarrels(
			// `producedMeasured` is stated explicitly: the first record of a window can
			// never be measured from a stock delta, whatever figure it carries.
			makeHistory([
				{ price: 185, sold: 268_930, produced: 383_276, fill: 73.9 },
				{ price: 185, sold: 269_102, produced: 350_000, fill: 90 },
				{ price: 182, sold: 315_823, produced: 375_550, fill: 94.5 },
				// Capped days: production is measured as sales, so they must be
				// excluded or the surplus would average itself away to zero.
				{ price: 179, sold: 269_102, produced: 269_102, fill: 100 },
				{ price: 176, sold: 283_942, produced: 283_942, fill: 100 },
			]).map((record) => ({ ...record, producedMeasured: true })),
		);
		expect(discarded.samples).toBe(3);
		// Median of 114,346 / 80,898 / 59,727
		expect(discarded.medianSurplus).toBe(80_898);
		expect(discarded.peakSurplus).toBe(114_346);
		// The capped days cannot size the loss, and the estimate says so rather than
		// reporting zero as though nothing were being discarded.
		expect(discarded.cappedDays).toBe(2);
		expect(discarded.evidenceThin).toBe(false);
	});

	it("says a fully-capped window cannot size the loss instead of reporting zero", () => {
		const discarded = estimateDiscardedBarrels(
			makeHistory([
				{ price: 179, sold: 269_102, produced: 269_102, fill: 100 },
				{ price: 176, sold: 283_942, produced: 283_942, fill: 100 },
			]).map((record) => ({ ...record, producedMeasured: true })),
		);
		expect(discarded.samples).toBe(0);
		expect(discarded.evidenceThin).toBe(true);
		expect(discarded.summary).toContain("cannot be measured");
	});
});

describe("The single analysis pipeline", () => {
	const FIXED_NOW = 1_790_705_443;

	/** A clean 19-staff rig on the built-in blueprint. */
	const roster19 = (): EmployeeSnapshot[] => {
		const spec: Array<[string, string, number, number, number]> = [];
		for (let i = 0; i < 6; i++)
			spec.push([`Driller${i}`, "Driller", 300_000, 100_000, 150_000]);
		for (let i = 0; i < 4; i++)
			spec.push([`Sales${i}`, "Sales Executive", 60_000, 400_000, 120_000]);
		for (let i = 0; i < 4; i++)
			spec.push([`Rough${i}`, "Roughneck", 150_000, 60_000, 90_000]);
		for (let i = 0; i < 2; i++)
			spec.push([`Derrick${i}`, "Derrick Hand", 160_000, 70_000, 120_000]);
		for (let i = 0; i < 2; i++)
			spec.push([`Motor${i}`, "Motor Hand", 180_000, 90_000, 110_000]);
		spec.push(["Secretary0", "Secretary", 60_000, 90_000, 220_000]);
		return spec.map(([name, role, man, int, end], idx) => ({
			id: idx + 1,
			name,
			position: { id: idx, name: role },
			days_in_company: 60,
			wage: 1_400_000,
			stats: { manual_labor: man, intelligence: int, endurance: end },
			effectiveness: {
				working_stats: 100,
				settled_in: 10,
				director_education: 0,
				addiction: 0,
				inactivity: 0,
				total: 110,
			},
		}));
	};

	const snapshot = (over: {
		inStock: number;
		soldAmount: number;
		price: number;
		adBudget: number;
		dailyIncome: number;
		capacity?: number;
		employees?: EmployeeSnapshot[];
	}): CompanySnapshot => {
		const employees = over.employees ?? roster19();
		return {
			profile: {
				id: 90288,
				name: "Succession Oil",
				rating: 4,
				funds: 50_000_000,
				efficiency: 92,
				environment: 100,
				popularity: 30,
				income: { daily: over.dailyIncome, weekly: over.dailyIncome * 7 },
				customers: { daily: 2, weekly: 14 },
				employees: { hired: employees.length, capacity: over.capacity ?? 21 },
				upgrades: { storage_capacity: 750_000 },
				advertisement_budget: over.adBudget,
			},
			stock: [
				{
					name: "Crude Oil",
					price: over.price,
					in_stock: over.inStock,
					sold_amount: over.soldAmount,
					sold_worth: over.soldAmount * over.price,
				},
			],
			employees,
		};
	};

	/** The nth day of the two-day measured fixture, without a non-null assertion. */
	const measuredDay = (index: number) => {
		const day = filledHistory(293_942, 283_942)[index];
		if (!day) throw new Error(`fixture day ${index} is missing`);
		return day;
	};

	/** Two recorded days that measure extraction, oldest first. */
	const filledHistory = (producedPerDay: number, soldPerDay: number) =>
		[1_790_618_000, 1_790_704_400].map((timestamp, index) => ({
			timestamp,
			isoDate: new Date(timestamp * 1000).toISOString().slice(0, 10),
			stars: 4,
			dailyIncome: soldPerDay * 180,
			weeklyIncome: soldPerDay * 180 * 7,
			dailyWages: 28_500_000,
			dailyProfit: soldPerDay * 180 - 28_500_000 - 4_500_000,
			adBudget: 4_500_000,
			dailyProduced: index === 0 ? undefined : producedPerDay,
			producedMeasured: index !== 0,
			dailyCustomers: 40 + index,
			efficiency: 92,
			environment: 100,
			popularity: 30,
			stock: {
				barrelPrice: 180,
				inStock: 750_000,
				soldAmount: soldPerDay,
				fillPct: 100,
			},
			metrics: { totalAddictionPenalty: 0, employeesWithAddiction: 0 },
		}));

	it("reports a rig as non-optimal while extraction is bound, even with a clean roster", () => {
		// Without this, the dashboard would claim "All Systems Optimal" during a
		// storage crisis, because it only ever checked roles, price, ads and rehab.
		// The roster is already shaped for the bottleneck, so nothing is asked of the
		// roles, the price, the ad budget or rehab - the rig is still not optimal.
		const analysis = analyzeOilRig({
			snapshot: snapshot({
				inStock: 750_000,
				soldAmount: 283_942,
				price: 176,
				adBudget: 4_500_000,
				dailyIncome: 49_973_792,
				capacity: 19,
			}),
			history: filledHistory(283_942, 283_942),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});

		expect(analysis.directives.capacityRebalance.extractionBound).toBe(true);
		expect(analysis.directives.stock.warehouseCritical).toBe(true);
		expect(analysis.directives.stock.structuralAdvice).toBeTruthy();
		expect(analysis.directives.allOptimal).toBe(false);
	});

	it("carries the seat moves the roster solver consumes", () => {
		const analysis = analyzeOilRig({
			snapshot: snapshot({
				inStock: 750_000,
				soldAmount: 283_942,
				price: 176,
				adBudget: 4_500_000,
				dailyIncome: 49_973_792,
			}),
			history: filledHistory(283_942, 283_942),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});

		const salesShift = analysis.directives.capacityRebalance.quotaShifts.find(
			(s) => s.role === "Sales Executive",
		);
		expect(salesShift).toEqual({ role: "Sales Executive", from: 4, to: 6 });
		expect(analysis.directives.capacityRebalance.hires).toBe(2);
		expect(
			analysis.directives.capacityRebalance.actions.map((a) => a.kind),
		).toContain("rebalance");
		// The plan is measured against the actual roster, so it names the seats that
		// genuinely still have to move rather than replaying the blueprint delta.
		expect(analysis.directives.capacityRebalance.countsKnown).toBe(true);
		expect(
			analysis.directives.capacityRebalance.seatDeltas["Sales Executive"],
		).toBe(2);
		expect(analysis.roster.rosterByRole["Sales Executive"]?.length).toBe(6);
	});

	it("reports all-optimal for a healthy rig", () => {
		const analysis = analyzeOilRig({
			snapshot: snapshot({
				inStock: 400_000,
				soldAmount: 300_000,
				price: 181,
				adBudget: 3_000_000,
				dailyIncome: 54_300_000,
				capacity: 19,
			}),
			// Sales outpace extraction, and storage is inside the buffer.
			history: filledHistory(200_000, 300_000),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});

		expect(analysis.regime.regime).toBe("balanced");
		expect(analysis.directives.capacityRebalance.extractionBound).toBe(false);
		expect(analysis.directives.capacityRebalance.actions).toEqual([]);
		expect(analysis.directives.allOptimal).toBe(true);
	});

	it("stops asking once the roster already carries the sell-through weight", () => {
		// The exact loop reported from the field: comply with the brief, ask again,
		// and be told the same thing. The plan compares against the roster now.
		const preCompliance = roster19();
		const first = analyzeOilRig({
			snapshot: snapshot({
				inStock: 750_000,
				soldAmount: 283_942,
				price: 176,
				adBudget: 4_500_000,
				dailyIncome: 49_973_792,
				employees: preCompliance,
			}),
			history: filledHistory(283_942, 283_942),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});
		expect(first.directives.capacityRebalance.state).toBe("action_required");
		expect(first.directives.roleTransfers.length).toBeGreaterThan(0);

		// Apply every transfer, then brief again on the same data.
		const complied = preCompliance.map((employee) => {
			const move = first.directives.roleTransfers.find(
				(t) => t.name === employee.name,
			);
			return move
				? { ...employee, position: { ...employee.position, name: move.toRole } }
				: employee;
		});

		const second = analyzeOilRig({
			snapshot: snapshot({
				inStock: 750_000,
				soldAmount: 283_942,
				price: 176,
				adBudget: 4_500_000,
				dailyIncome: 49_973_792,
				employees: complied,
			}),
			history: filledHistory(283_942, 283_942),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
			previousState: first.stock.state,
			previousCritical: first.stock.warehouseCritical,
			previousRegime: first.regime,
		});

		// No seat move is outstanding, and the plan says so instead of repeating it.
		expect(second.directives.roleTransfers).toEqual([]);
		expect(second.directives.capacityRebalance.state).toBe("holding");
		expect(second.directives.capacityRebalance.summary).toContain(
			"already carries the sell-through weight",
		);
		// The regime is held rather than re-decided, and still reports the truth:
		// the warehouse is full, so it cannot be called optimal.
		expect(second.regime.regime).toBe("extraction_bound");
		expect(second.regime.held).toBe(true);
		expect(second.directives.allOptimal).toBe(false);
	});

	it("does not cycle the roster between adding and removing sell-through capacity", () => {
		// The reproduced limit cycle: add two Sales Executives, sell-through rises,
		// extraction no longer outruns sales, and the next brief demanded three of
		// them back. Exit now needs several draining days AND storage back in range.
		const start = analyzeOilRig({
			snapshot: snapshot({
				inStock: 750_000,
				soldAmount: 283_942,
				price: 176,
				adBudget: 4_500_000,
				dailyIncome: 49_973_792,
			}),
			history: filledHistory(293_942, 283_942),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});
		expect(start.regime.regime).toBe("extraction_bound");

		// The rebalance works: storage falls to 79% and sales now beat extraction on
		// the last recorded day. One draining day must not revoke the regime.
		const draining = [1_790_530_000, 1_790_616_800, 1_790_703_600].map(
			(timestamp, index) => ({
				timestamp,
				isoDate: new Date(timestamp * 1000).toISOString().slice(0, 10),
				stars: 4,
				dailyIncome: 318_000 * 180,
				weeklyIncome: 318_000 * 180 * 7,
				dailyWages: 28_500_000,
				dailyProfit: 318_000 * 180 - 28_500_000 - 4_500_000,
				adBudget: 4_500_000,
				dailyProduced: index === 0 ? undefined : 293_942,
				producedMeasured: index !== 0,
				dailyCustomers: 45,
				efficiency: 92,
				environment: 100,
				popularity: 30,
				stock: {
					barrelPrice: 180,
					inStock: Math.round(0.79 * 750_000),
					soldAmount: 318_000,
					fillPct: 79,
				},
				metrics: { totalAddictionPenalty: 0, employeesWithAddiction: 0 },
			}),
		);

		const next = analyzeOilRig({
			snapshot: snapshot({
				inStock: Math.round(0.79 * 750_000),
				soldAmount: 318_000,
				price: 176,
				adBudget: 4_500_000,
				dailyIncome: 318_000 * 180,
			}),
			history: draining,
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
			previousRegime: start.regime,
		});

		// Two draining days out of three and 79% fill: the regime is held, so the
		// roster is still solved toward sell-through and no seats are moved back out.
		expect(next.regime.regime).toBe("extraction_bound");
		expect(next.regime.held).toBe(true);
		expect(next.regime.reason).toContain("held");
		expect(
			next.directives.roleTransfers.filter(
				(t) => t.fromRole === "Sales Executive",
			),
		).toEqual([]);
	});

	it("is invariant under the order the employees arrive in", () => {
		// The API and the database are free to return employees in any order; two
		// briefs on identical data must not name different people to move.
		const employees = roster19();
		const forward = analyzeOilRig({
			snapshot: snapshot({
				inStock: 750_000,
				soldAmount: 283_942,
				price: 176,
				adBudget: 4_500_000,
				dailyIncome: 49_973_792,
				employees,
			}),
			history: filledHistory(293_942, 283_942),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});
		const reversed = analyzeOilRig({
			snapshot: snapshot({
				inStock: 750_000,
				soldAmount: 283_942,
				price: 176,
				adBudget: 4_500_000,
				dailyIncome: 49_973_792,
				employees: [...employees].reverse(),
			}),
			history: filledHistory(293_942, 283_942),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});

		expect(adviceSignature(reversed.directives)).toBe(
			adviceSignature(forward.directives),
		);
		expect(reversed.directives.roleTransfers).toEqual(
			forward.directives.roleTransfers,
		);
	});

	it("moves only the seats the quota change requires", () => {
		// The old solver maximised total role fit, so a two-seat quota change moved
		// eight people. Churn is now decided before fit is optimised.
		const analysis = analyzeOilRig({
			snapshot: snapshot({
				inStock: 750_000,
				soldAmount: 283_942,
				price: 176,
				adBudget: 4_500_000,
				dailyIncome: 49_973_792,
			}),
			history: filledHistory(293_942, 283_942),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});
		const salesDeltas = analysis.directives.capacityRebalance.seatDeltas;
		const seatsToAdd = salesDeltas["Sales Executive"] ?? 0;
		expect(seatsToAdd).toBe(2);
		// Two seats into sell-through, and the extraction side gives up exactly two.
		expect(analysis.directives.roleTransfers.length).toBeLessThanOrEqual(2);
	});

	it("asks for nothing at all when the roster is already on blueprint", () => {
		// A roster exactly matching the blueprint used to be told to swap two
		// employees, purely because the solver preferred a different equally-good
		// matching that depended on the input order.
		const roster = solveOptimalRoster(roster19());
		expect(roster.activeTransfers).toEqual([]);
		expect(roster.targetQuotas).toEqual(getOptimalRoleQuotas(19));
	});

	it("steers toward a measured top-rig baseline when one exists", () => {
		const baseline = deriveRosterBaseline({
			capturedAt: new Date(FIXED_NOW * 1000),
			rating: 10,
			fieldSize: 80,
			sampleSize: 8,
			roleShares: {
				Driller: 0.3,
				"Sales Executive": 0.3,
				Roughneck: 0.15,
				"Derrick Hand": 0.1,
				"Motor Hand": 0.1,
				Secretary: 0.05,
			},
		});
		expect(baseline).toBeDefined();

		const analysis = analyzeOilRig({
			snapshot: snapshot({
				inStock: 400_000,
				soldAmount: 300_000,
				price: 181,
				adBudget: 3_000_000,
				dailyIncome: 54_300_000,
			}),
			history: filledHistory(200_000, 300_000),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
			baseline,
		});

		// The measured shares are scaled to the roster size by largest remainder, so
		// the counts always sum to the headcount exactly, and the source is reported
		// so the brief can say which blueprint it steered toward.
		expect(analysis.roster.blueprintSource).toContain("benchmark");
		expect(
			Object.values(analysis.roster.targetQuotas).reduce((a, b) => a + b, 0),
		).toBe(19);
		// 0.3 x 19 = 5.7, so sell-through gets 5 seats - one MORE than the hand
		// blueprint's 4, which is exactly the shape the measured baseline implies.
		expect(analysis.roster.targetQuotas["Sales Executive"]).toBe(5);
		expect(analysis.roster.targetQuotas.Driller).toBe(6);
	});

	it("refuses to restructure the roster on a single measured day", () => {
		const analysis = analyzeOilRig({
			snapshot: snapshot({
				inStock: 750_000,
				soldAmount: 283_942,
				price: 176,
				adBudget: 4_500_000,
				dailyIncome: 49_973_792,
			}),
			history: [measuredDay(1)],
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});

		expect(analysis.stock.production.confidence).not.toBe("high");
		expect(analysis.stock.production.summary).toContain("not enough");
		expect(analysis.warnings.some((w) => w.includes("not restructured"))).toBe(
			true,
		);
	});

	it("reports the warehouse as unable to drain without inventing a production figure", () => {
		// A display-only estimate: the loader fills the unmeasurable first record of
		// every window with that day's sales and flags it.
		const history = [{ ...measuredDay(0), producedMeasured: false }];
		const analysis = analyzeOilRig({
			snapshot: snapshot({
				inStock: 750_000,
				soldAmount: 283_942,
				price: 176,
				adBudget: 4_500_000,
				dailyIncome: 49_973_792,
			}),
			history,
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});

		// No predecessor exists, so extraction is unmeasured and no drain conclusion
		// may be drawn from it.
		expect(analysis.stock.production.dailyProduced).toBeUndefined();
		expect(analysis.stock.isFillingUp).toBe(false);
		// The discarded volume is reported as unmeasurable rather than as zero, and
		// the reason is stated.
		expect(analysis.discarded.summary).toMatch(
			/cannot be measured|No recorded days/,
		);
	});
});

describe("Unmeasured extraction must not fake a bottleneck", () => {
	// The rolling loader fills an unmeasurable first day with that day's sales so
	// tables and charts still render. Feeding that estimate into the drain model
	// makes "production equals sales" look measured, which declares the warehouse
	// unable to drain and triggers a full capacity rebalance off a single row.
	const baseSnapshotRecord = {
		timestamp: 1_790_705_443,
		isoDate: "2026-09-29",
		stars: 4,
		dailyIncome: 50_114_835,
		weeklyIncome: 350_000_000,
		dailyWages: 44_010_000,
		dailyProfit: 3_104_835,
		adBudget: 3_000_000,
		// Equal to soldAmount: a display estimate, not a measured delta.
		dailyProduced: 270_891,
		efficiency: 90,
		environment: 93,
		stock: {
			barrelPrice: 185,
			inStock: 439_857,
			soldAmount: 270_891,
			fillPct: 58.6,
		},
		metrics: { totalAddictionPenalty: 0, employeesWithAddiction: 0 },
	};

	const singleSnapshotHistory = [baseSnapshotRecord];

	it("ignores the display estimate when production cannot be measured", () => {
		expect(latestMeasuredProduction(singleSnapshotHistory)).toBeUndefined();

		const stock = analyzeStockAndPricing({
			inStock: 439_857,
			storageCap: 750_000,
			dailySold: 270_891,
			dailyProduced: latestMeasuredProduction(singleSnapshotHistory),
			currentPrice: 185,
			adBudget: 3_000_000,
			dailyIncome: 50_114_835,
		});

		expect(stock.state).toBe("equilibrium");
		expect(stock.isFillingUp).toBe(false);
		expect(stock.warehouseCritical).toBe(false);
		expect(stock.production.confidence).toBe("none");

		// The regime and the plan must both refuse to act on an unmeasured rate.
		const regime = assessCapacityRegime({
			history: singleSnapshotHistory,
			fillPct: stock.fillPct,
			asOfSeconds: 1_790_705_443,
		});
		expect(regime.regime).toBe("balanced");

		const plan = planCapacityRebalance({
			staffCount: 18,
			stock,
			barrelPrice: 185,
			openSeats: 3,
			regime,
			currentCounts: { Driller: 5, "Sales Executive": 4 },
			discardedEvidenceThin: true,
		});
		expect(plan.extractionBound).toBe(false);
		expect(plan.actions).toEqual([]);
		expect(stock.structuralAdvice).toBeUndefined();
	});

	it("still measures production once a second snapshot exists", () => {
		const twoDays = [
			{
				...baseSnapshotRecord,
				timestamp: 1_790_618_000,
				stock: {
					barrelPrice: 185,
					inStock: 400_000,
					soldAmount: 270_000,
					fillPct: 53.3,
				},
			},
			{ ...baseSnapshotRecord, timestamp: 1_790_704_400 },
		];
		expect(twoDays.length).toBe(2);
		expect(latestMeasuredProduction(twoDays)).toBe(270_891);
	});
});
