import { describe, expect, it } from "bun:test";
import {
	analyzeHiringPriorities,
	analyzeStarProgression,
	analyzeStockAndPricing,
	calcRoleFit,
	calcStatScore,
	formatHistoryTable,
	getOptimalRoleQuotas,
	OIL_RIG_ROLES,
	solveOptimalRoster,
} from "../src/oil-rig";

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
		expect(surplus.recommendedAdSpend.action).toBe("increase");
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
});
