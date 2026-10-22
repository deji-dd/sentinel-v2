import { describe, expect, it } from "bun:test";

import type { OilRigHistoryRecord } from "../src/oil-rig";
import { analyzeOilRig } from "../src/oil-rig-analysis";
import { renderDeterministicBriefing } from "../src/oil-rig-render";
import type { CompanySnapshot } from "../src/oil-rig-snapshot";
import {
	analyzeUpgrades,
	OIL_RIG_COMPANY_SIZE_TIERS,
	type OilRigUpgradeInput,
} from "../src/oil-rig-upgrades";

const FIXED_NOW = 1_790_705_443;
const DAY = 86_400;

/** Inputs for the upgrade engine alone, with the prod rig as the default shape. */
function upgradeInput(
	over: Partial<OilRigUpgradeInput> = {},
): OilRigUpgradeInput {
	return {
		profile: {
			environment: 85,
			employees: { hired: 21, capacity: 21 },
			upgrades: {
				staff_room: "Small staff room",
				storage: "Large room",
				storage_capacity: 750_000,
			},
		},
		staffCount: 21,
		openSeats: 0,
		stock: {
			fillPct: 76.6,
			netFillPerDay: 32_829,
			warehouseCritical: false,
			isFillingUp: true,
		},
		discarded: { barrelsPerDay: 0, valuePerDay: 0, evidenceThin: false },
		extractionBound: false,
		capacityPlanState: "balanced",
		barrelPrice: 179,
		...over,
	};
}

describe("Company upgrade advice", () => {
	it("puts the staff room on the list when the headcount has outgrown it", () => {
		const advice = analyzeUpgrades(upgradeInput());

		expect(advice.recommendations).toHaveLength(1);
		const [room] = advice.recommendations;
		expect(room?.category).toBe("staff_room");
		expect(room?.currentTier).toBe("Small staff room");
		expect(room?.nextTier).toBe("Standard staff room");
		expect(room?.targetTier).toBe("Large staff room");
		// The room is two sizes short, so both purchases are in the chain.
		expect(room?.steps.map((step) => step.tier)).toEqual([
			"Standard staff room",
			"Large staff room",
		]);
		expect(room?.totalCostToTarget).toBe(1_312_500_000);
		// Environment 85 is already paying for it.
		expect(room?.priority).toBe("critical");
		expect(room?.reason).toContain("21 staff");
		expect(room?.reason).toContain("85%");
	});

	it("does not recommend a staff room the headcount does not need", () => {
		const advice = analyzeUpgrades(
			upgradeInput({
				profile: {
					environment: 100,
					employees: { hired: 21, capacity: 21 },
					upgrades: {
						staff_room: "Large staff room",
						storage: "Large room",
					},
				},
			}),
		);
		expect(
			advice.recommendations.some((r) => r.category === "staff_room"),
		).toBe(false);
	});

	it("asks for a bigger company once the rig is full, sequencing it after a rebalance", () => {
		const holding = analyzeUpgrades(
			upgradeInput({
				extractionBound: true,
				capacityPlanState: "holding",
			}),
		);
		const size = holding.recommendations.find(
			(r) => r.category === "company_size",
		);
		expect(size?.currentTier).toBe("21 employees");
		expect(size?.nextTier).toBe("24 employees");
		expect(size?.nextCost).toBe(4_200_000_000);
		expect(size?.priority).toBe("high");
		expect(size?.reason).toContain("3 more seats");
		// The undersized staff room is named as the prerequisite.
		expect(size?.reason).toContain("staff room first");

		// A rebalance is still outstanding: the upgrade is listed so it can be
		// planned, but the free seat move comes first and the priority says so.
		const actionRequired = analyzeUpgrades(
			upgradeInput({
				extractionBound: true,
				capacityPlanState: "action_required",
			}),
		);
		const sequenced = actionRequired.recommendations.find(
			(r) => r.category === "company_size",
		);
		expect(sequenced?.priority).toBe("medium");
		expect(sequenced?.reason).toContain("do that first");

		// An unfilled seat is different: hire into it first, at no upgrade cost.
		const openSeat = analyzeUpgrades(
			upgradeInput({
				openSeats: 2,
				extractionBound: true,
				capacityPlanState: "action_required",
			}),
		);
		expect(
			openSeat.recommendations.some((r) => r.category === "company_size"),
		).toBe(false);
	});

	it("does not escalate the size upgrade while a free seat step is still being measured", () => {
		const advice = analyzeUpgrades(
			upgradeInput({
				extractionBound: true,
				capacityPlanState: "holding",
				capacityPlanDeferral: "step_in_flight",
			}),
		);
		const size = advice.recommendations.find(
			(r) => r.category === "company_size",
		);
		expect(size).toBeDefined();
		// A deferred second seat is still a free seat, so the multi-billion
		// upgrade must not jump ahead of it.
		expect(size?.priority).toBe("medium");
		expect(size?.reason).toContain(
			"One sell-through seat is still being measured",
		);
		expect(size?.reason).not.toContain("No seat is left");
	});

	it("does not escalate the size upgrade while sales already outpace extraction", () => {
		const advice = analyzeUpgrades(
			upgradeInput({
				extractionBound: true,
				capacityPlanState: "holding",
				capacityPlanDeferral: "already_draining",
			}),
		);
		const size = advice.recommendations.find(
			(r) => r.category === "company_size",
		);
		expect(size?.priority).toBe("medium");
		expect(size?.reason).toContain("Sales already outpace extraction");
	});

	it("does not ask for a bigger company when extraction is not the constraint", () => {
		const advice = analyzeUpgrades(
			upgradeInput({
				extractionBound: false,
				capacityPlanState: "balanced",
			}),
		);
		expect(
			advice.recommendations.some((r) => r.category === "company_size"),
		).toBe(false);
	});

	it("caps the company size at 30 employees", () => {
		const advice = analyzeUpgrades(
			upgradeInput({
				profile: {
					environment: 100,
					employees: { hired: 30, capacity: 30 },
					upgrades: {
						staff_room: "Colossal staff room",
						storage: "Large room",
					},
				},
				staffCount: 30,
				extractionBound: true,
				capacityPlanState: "holding",
			}),
		);
		expect(
			advice.recommendations.some((r) => r.category === "company_size"),
		).toBe(false);
	});

	it("offers storage only at max size, at the cap, with no seat move left", () => {
		const maxed = upgradeInput({
			profile: {
				environment: 100,
				employees: { hired: 30, capacity: 30 },
				upgrades: {
					staff_room: "Colossal staff room",
					storage: "Large room",
				},
			},
			staffCount: 30,
			stock: {
				fillPct: 99,
				netFillPerDay: 30_000,
				warehouseCritical: true,
				isFillingUp: true,
			},
			discarded: {
				barrelsPerDay: 40_000,
				valuePerDay: 7_160_000,
				evidenceThin: false,
			},
			extractionBound: true,
			capacityPlanState: "holding",
		});
		const advice = analyzeUpgrades(maxed);
		const warehouse = advice.recommendations.find(
			(r) => r.category === "warehouse",
		);
		expect(warehouse?.nextTier).toBe("Huge room");
		expect(warehouse?.nextCost).toBe(1_575_000_000);
		expect(warehouse?.reason).toContain("only postpones the cap");

		// Below max size the better lever is a seat, not a bigger warehouse.
		const notMaxed = analyzeUpgrades(
			upgradeInput({
				stock: {
					fillPct: 99,
					netFillPerDay: 30_000,
					warehouseCritical: true,
					isFillingUp: true,
				},
				extractionBound: true,
				capacityPlanState: "holding",
			}),
		);
		expect(
			notMaxed.recommendations.some((r) => r.category === "warehouse"),
		).toBe(false);
	});

	it("says nothing when the tier data is missing rather than guessing", () => {
		const advice = analyzeUpgrades(
			upgradeInput({
				profile: {
					environment: 85,
					employees: { hired: 21, capacity: 21 },
					upgrades: {},
				},
			}),
		);
		expect(advice.recommendations).toEqual([]);
		expect(advice.allMaxed).toBe(false);
		expect(advice.summary).toContain("No company upgrade is due");
	});

	it("reports every upgrade as maxed when all three are at the final tier", () => {
		const advice = analyzeUpgrades(
			upgradeInput({
				profile: {
					environment: 100,
					employees: { hired: 30, capacity: 30 },
					upgrades: {
						staff_room: "Colossal staff room",
						storage: "Huge warehouse",
					},
				},
				staffCount: 30,
			}),
		);
		expect(advice.recommendations).toEqual([]);
		expect(advice.allMaxed).toBe(true);
		expect(advice.summary).toContain("final tier");
	});

	it("prices every tier from the Torn oil-rig table", () => {
		expect(OIL_RIG_COMPANY_SIZE_TIERS.map((t) => t.employees)).toEqual([
			12, 15, 18, 21, 24, 27, 30,
		]);
		expect(OIL_RIG_COMPANY_SIZE_TIERS[6]?.cost).toBe(6_300_000_000);
	});
});

/** A full 21-person roster, so `staffCount` matches the profile's headcount. */
function prodEmployees(): CompanySnapshot["employees"] {
	const roles = [
		...Array.from({ length: 6 }, () => "Driller"),
		...Array.from({ length: 5 }, () => "Sales Executive"),
		...Array.from({ length: 4 }, () => "Roughneck"),
		...Array.from({ length: 3 }, () => "Derrick Hand"),
		...Array.from({ length: 2 }, () => "Motor Hand"),
		...Array.from({ length: 1 }, () => "Secretary"),
	];
	return roles.map((role, index) => ({
		id: index + 1,
		name: `Emp${index + 1}`,
		position: { id: index + 1, name: role },
		days_in_company: 40,
		wage: 1_500_000,
		stats: {
			manual_labor: 150_000,
			intelligence: 120_000,
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
	}));
}

/** The prod rig: 5★, 21/21 staff, Small staff room, Large room, filling. */
function prodSnapshot(): CompanySnapshot {
	return {
		profile: {
			id: 90288,
			name: "Succession Oil",
			rating: 5,
			funds: 400_000_000,
			efficiency: 84,
			environment: 85,
			popularity: 39,
			income: { daily: 61_622_719, weekly: 450_476_412 },
			customers: { daily: 6, weekly: 42 },
			employees: { hired: 21, capacity: 21 },
			upgrades: {
				staff_room: "Small staff room",
				storage: "Large room",
				storage_capacity: 750_000,
			},
			advertisement_budget: 5_000_000,
		},
		stock: [
			{
				name: "Crude Oil",
				price: 179,
				in_stock: 637_500,
				sold_amount: 344_261,
				sold_worth: 61_622_719,
			},
		],
		employees: prodEmployees(),
	};
}

function fillingHistory(): OilRigHistoryRecord[] {
	const rows = [
		{ fill: 76.6, sold: 331_154, produced: 400_000 },
		{ fill: 80.4, sold: 344_261, produced: 377_090 },
		{ fill: 84.3, sold: 344_261, produced: 373_000 },
	];
	return rows.map((row, index) => ({
		timestamp: FIXED_NOW - (rows.length - index) * DAY,
		isoDate: new Date((FIXED_NOW - (rows.length - index) * DAY) * 1000)
			.toISOString()
			.slice(0, 10),
		stars: 5,
		dailyIncome: 61_622_719,
		weeklyIncome: 450_476_412,
		dailyWages: 20_000_000,
		dailyProfit: 36_622_719,
		adBudget: 5_000_000,
		dailyProduced: row.produced,
		producedMeasured: true,
		dailyCustomers: 6,
		efficiency: 84,
		environment: 85,
		popularity: 39,
		stock: {
			barrelPrice: 179,
			inStock: Math.round((row.fill / 100) * 750_000),
			soldAmount: row.sold,
			fillPct: row.fill,
		},
		metrics: {
			totalAddictionPenalty: 0,
			employeesWithAddiction: 0,
			unsettledEmployees: 0,
			emptyEmployeeSlots: 0,
		},
	}));
}

describe("Upgrades in the shared analysis", () => {
	it("surfaces the staff room on the prod rig and renders it in the brief", () => {
		const analysis = analyzeOilRig({
			snapshot: prodSnapshot(),
			history: fillingHistory(),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});

		const room = analysis.directives.upgrades.recommendations.find(
			(r) => r.category === "staff_room",
		);
		expect(room).toBeDefined();
		expect(room?.priority).toBe("critical");
		const size = analysis.directives.upgrades.recommendations.find(
			(r) => r.category === "company_size",
		);
		expect(size).toBeDefined();
		expect(size?.nextTier).toBe("24 employees");
		expect(analysis.directives.allOptimal).toBe(false);

		const advice = renderDeterministicBriefing(analysis).advice;
		expect(advice).toContain("### Upgrades");
		expect(advice).toContain("Staff room (critical)");
		expect(advice).toContain("Standard staff room");
		expect(advice).toContain("Large staff room");
		expect(advice).toContain("$1,312,500,000 total");
		expect(advice).toContain("Company size (medium)");
		expect(advice).toContain("24 employees $4,200,000,000");
	});

	it("changes the advice signature when an upgrade tier changes", () => {
		const small = analyzeOilRig({
			snapshot: prodSnapshot(),
			history: fillingHistory(),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});
		const large = analyzeOilRig({
			snapshot: {
				...prodSnapshot(),
				profile: {
					...prodSnapshot().profile,
					environment: 100,
					upgrades: {
						staff_room: "Large staff room",
						storage: "Large room",
						storage_capacity: 750_000,
					},
				},
			},
			history: fillingHistory(),
			dataBasis: "recorded",
			asOfSeconds: FIXED_NOW,
		});

		expect(renderDeterministicBriefing(small).signature).not.toBe(
			renderDeterministicBriefing(large).signature,
		);
	});
});
