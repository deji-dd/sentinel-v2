import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { db } from "@sentinel/database";
import { tornApi } from "@sentinel/torn-api";
import { schedulerEvents } from "../src/lib/events";
import {
	type OilRigApiResponse,
	recordOilRigSnapshot,
	startOilRigCollector,
} from "../src/workers/personal/oil-rig";

describe("Oil Rig Collector Worker", () => {
	let getPersonalSpy: ReturnType<typeof spyOn>;
	let dbInsertSpy: ReturnType<typeof spyOn>;
	let insertedData: unknown = null;

	const mockCompanyResponse: OilRigApiResponse = {
		profile: {
			id: 90288,
			name: "Succession Oil",
			rating: 4,
			funds: 370000000,
			popularity: 32,
			efficiency: 92,
			environment: 94,
			trains: 12,
			advertisement_budget: 3000000,
			income: { daily: 55000000, weekly: 370000000 },
			customers: { daily: 2, weekly: 14 },
			employees: { hired: 17, capacity: 21 },
			upgrades: {
				storage_capacity: 750000,
			},
		},
		employees: [
			{
				id: 1,
				name: "Alice",
				position: { id: 366, name: "Sales Executive" },
				days_in_company: 100,
				wage: 100000,
				stats: { manual_labor: 1000, intelligence: 50000, endurance: 20000 },
				effectiveness: {
					working_stats: 100,
					settled_in: 10,
					director_education: 12,
					addiction: -4, // Flat number penalty
					inactivity: 0,
					total: 118,
				},
			},
			{
				id: 2,
				name: "Bob",
				position: { id: 367, name: "Driller" },
				days_in_company: 3,
				wage: 50000,
				stats: { manual_labor: 40000, intelligence: 1000, endurance: 30000 },
				effectiveness: {
					working_stats: 80,
					settled_in: 3, // Still settling in (< 10)
					director_education: 12,
					addiction: 0,
					inactivity: 0,
					total: 95,
				},
			},
		],
		stock: [
			{
				id: 173,
				name: "Oil (Barrel)",
				price: 181,
				in_stock: 200000,
				sold_amount: 300000,
				sold_worth: 54300000,
			},
		],
	};

	beforeEach(() => {
		insertedData = null;
		dbInsertSpy = spyOn(db, "insert").mockImplementation((() => ({
			values: (val: unknown) => {
				insertedData = val;
				return {
					onConflictDoUpdate: async () => [val],
				};
			},
		})) as unknown as typeof db.insert);

		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation(
			(async () =>
				mockCompanyResponse) as unknown as typeof tornApi.getPersonal,
		);
	});

	afterEach(() => {
		dbInsertSpy.mockRestore();
		getPersonalSpy.mockRestore();
	});

	test("records snapshot with accurate flat addiction penalties and stock", async () => {
		const result = await recordOilRigSnapshot();
		expect(result).not.toBeNull();
		if (!result) return;

		expect(result.companyId).toBe(90288);
		expect(result.name).toBe("Succession Oil");
		expect(result.stars).toBe(4);
		expect(result.stock.inStock).toBe(200000);
		expect(result.stock.barrelPrice).toBe(181);
		expect(result.metrics.emptyEmployeeSlots).toBe(4); // 21 - 17
		expect(result.metrics.employeesWithAddiction).toBe(1);
		expect(result.metrics.totalAddictionPenalty).toBe(4); // Flat absolute deduction
		expect(result.metrics.unsettledEmployees).toBe(1); // Bob is 3/10

		// Verify database persistence
		expect(insertedData).not.toBeNull();
		expect((insertedData as { companyId: number }).companyId).toBe(90288);
		expect((insertedData as { barrelsSold: number }).barrelsSold).toBe(300000);
	});

	test("startOilRigCollector listens to company_pay_received event", async () => {
		let fired = false;
		getPersonalSpy.mockImplementation((async () => {
			fired = true;
			return mockCompanyResponse;
		}) as unknown as typeof tornApi.getPersonal);

		startOilRigCollector();
		schedulerEvents.emit("company_pay_received");

		// Wait briefly for the async callback
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fired).toBe(true);
	});
});
