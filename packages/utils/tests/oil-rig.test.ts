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
