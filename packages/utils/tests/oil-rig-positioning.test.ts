import { describe, expect, it } from "bun:test";

import { analyzeOilRig } from "../src/oil-rig-analysis";
import {
	buildEmployeePositionRows,
	renderDeterministicBriefing,
	renderEmployeePositioning,
} from "../src/oil-rig-render";
import type {
	CompanySnapshot,
	EmployeeSnapshot,
} from "../src/oil-rig-snapshot";

const FIXED_NOW = 1_790_705_443;

function employee(
	overrides: Partial<EmployeeSnapshot> & Pick<EmployeeSnapshot, "name">,
): EmployeeSnapshot {
	return {
		id: 1,
		days_in_company: 50,
		wage: 1_000_000,
		position: { name: "Sales Executive" },
		stats: { manual_labor: 100_000, intelligence: 100_000, endurance: 100_000 },
		effectiveness: {
			working_stats: 80,
			settled_in: 10,
			director_education: 0,
			addiction: 0,
			inactivity: 0,
			total: 90,
		},
		...overrides,
	};
}

function snapshot(
	employees: EmployeeSnapshot[],
	capacity = 12,
): CompanySnapshot {
	return {
		profile: {
			id: 90288,
			name: "Succession Oil",
			rating: 4,
			funds: 50_000_000,
			efficiency: 92,
			environment: 100,
			popularity: 30,
			income: { daily: 50_000_000, weekly: 350_000_000 },
			customers: { daily: 40, weekly: 280 },
			employees: { hired: employees.length, capacity },
			upgrades: { storage_capacity: 750_000 },
			advertisement_budget: 4_500_000,
		},
		stock: [
			{
				name: "Crude Oil",
				price: 180,
				in_stock: 300_000,
				sold_amount: 280_000,
				sold_worth: 50_400_000,
			},
		],
		employees,
	};
}

const staff = [
	employee({
		id: 1,
		name: "Ramirez",
		wage: 1_500_000,
		position: { name: "Sales Executive" },
		stats: {
			manual_labor: 378_000,
			intelligence: 163_000,
			endurance: 197_000,
		},
	}),
	employee({
		id: 2,
		name: "HT-IngCognito",
		wage: 1_500_000,
		position: { name: "Sales Executive" },
		stats: {
			manual_labor: 100_000,
			intelligence: 539_000,
			endurance: 266_000,
		},
	}),
	employee({
		id: 3,
		name: "Hog",
		wage: 200_000,
		position: { name: "Derrick Hand" },
		stats: { manual_labor: 75_000, intelligence: 10_000, endurance: 45_000 },
		effectiveness: {
			working_stats: 79,
			settled_in: 4,
			director_education: 0,
			addiction: -12,
			inactivity: 0,
			total: 71,
		},
	}),
];

function analyse(employees: EmployeeSnapshot[]) {
	const company = snapshot(employees);
	const analysis = analyzeOilRig({
		snapshot: company,
		history: [],
		dataBasis: "recorded",
		asOfSeconds: FIXED_NOW,
	});
	return { analysis, company };
}

describe("Employee positioning report", () => {
	it("lists every employee by raw stat total descending", () => {
		const { analysis, company } = analyse(staff);
		const rows = buildEmployeePositionRows(analysis, company);

		expect(rows.map((row) => row.name)).toEqual([
			"HT-IngCognito",
			"Ramirez",
			"Hog",
		]);
		expect(rows[0]?.stats.total).toBe(905_000);
		expect(rows[0]?.stats.manualLabor).toBe(100_000);
		expect(rows[0]?.wage).toBe(1_500_000);
		expect(rows[0]?.currentRole).toBe("Sales Executive");
	});

	it("carries the solver's role recommendation and its fit change", () => {
		const { analysis, company } = analyse(staff);
		const rows = buildEmployeePositionRows(analysis, company);
		const ramirez = rows.find((row) => row.name === "Ramirez");

		expect(ramirez?.currentRole).toBe("Sales Executive");
		expect(ramirez?.recommendedRole).toBe("Driller");
		expect(ramirez?.recommendedFit).toBeGreaterThan(ramirez?.currentFit ?? 0);
	});

	it("renders moves, the stat/pay table, the summary and health flags", () => {
		const { analysis, company } = analyse(staff);
		const report = renderEmployeePositioning(analysis, company);

		expect(report).toContain("### Recommended Moves");
		expect(report).toContain("Ramirez");
		expect(report).toContain("Driller");
		expect(report).toContain("### Employees (by stat total, high to low)");
		expect(report).toContain("MAN");
		expect(report).toContain("Total");
		expect(report).toContain("Pay/day");
		expect(report).toContain("### Roster Summary");
		expect(report).toContain("### Staff Health");
		expect(report).toContain("Rehab now");
		expect(report).not.toContain("Rehab next");
		expect(report).not.toContain("Rehab watch");
		const tableStart = report.indexOf("### Employees");
		expect(report.indexOf("HT-IngCognito", tableStart)).toBeLessThan(
			report.indexOf("Ramirez", tableStart),
		);
	});

	it("only renders the now-rehab tier", () => {
		const rehab = (name: string, addiction: number) =>
			employee({
				name,
				effectiveness: {
					working_stats: 80,
					settled_in: 10,
					director_education: 0,
					addiction,
					inactivity: 0,
					total: 90,
				},
			});
		const { analysis, company } = analyse([
			rehab("Urgent", -12),
			rehab("Soon", -7),
			rehab("Watch", -3),
		]);

		// The engine still classifies all three tiers; only tier 1 is advice now.
		expect(analysis.roster.rehabTiers.tier1.map((e) => e.name)).toEqual([
			"Urgent",
		]);
		expect(analysis.roster.rehabTiers.tier2.map((e) => e.name)).toEqual([
			"Soon",
		]);
		expect(analysis.roster.rehabTiers.tier3.map((e) => e.name)).toEqual([
			"Watch",
		]);

		const report = renderEmployeePositioning(analysis, company);
		expect(report).toContain("Rehab now");
		expect(report).not.toContain("Rehab next");
		expect(report).not.toContain("Rehab watch");

		const advice = renderDeterministicBriefing(analysis).advice;
		expect(advice).toContain("Rehab now");
		expect(advice).not.toContain("Rehab next");
		expect(advice).not.toContain("Rehab watch");
	});

	it("says so when no employee needs moving", () => {
		const driller = employee({
			name: "OnlyDriller",
			position: { name: "Driller" },
			stats: {
				manual_labor: 300_000,
				intelligence: 100_000,
				endurance: 100_000,
			},
		});
		const { analysis, company } = analyse([driller]);

		expect(analysis.roster.activeTransfers).toHaveLength(0);
		expect(renderEmployeePositioning(analysis, company)).toContain(
			"None — every employee is already in the seat the engine would choose.",
		);
	});

	it("generates a deliverable report without touching the database or DMs", async () => {
		const { generateEmployeePositioning } =
			await import("../src/oil-rig-briefing");
		const company = snapshot(staff);
		const result = await generateEmployeePositioning({
			customSnapshot: company,
			fetchHistory: async () => [],
			isolateFromDatabase: true,
			skipDelivery: true,
			asOfSeconds: FIXED_NOW,
		});

		expect(result.text).toContain("### Recommended Moves");
		expect(result.discordMessages.join("\n")).toContain("Employee Positioning");
		expect(result.discordMessages.join("\n")).toContain("HT-IngCognito");
	});
});
