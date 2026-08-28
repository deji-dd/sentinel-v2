import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	apiKeys,
	companyDailyProfits,
	db,
	eq,
	ledgerEvents,
	systemStates,
} from "@sentinel/database";
import { tornApi } from "@sentinel/torn-api";
import { schedulerEvents } from "../src/lib/events";
import {
	getCompanySyncState,
	loadCompanySyncState,
	resetCompanySyncState,
	startCompanySync,
	syncCompanyDailyProfit,
} from "../src/workers/personal/company";

describe("Personal Company Sync Worker", () => {
	let getPersonalSpy: ReturnType<typeof spyOn>;
	const TEST_STATE_ID = "personal:company_sync";
	const TEST_KEY_ID = "test_personal_company_sync_key";
	const originalEnvKey = process.env.TORN_API_KEY;

	beforeEach(async () => {
		// Clean up fixtures
		await db.delete(systemStates).where(eq(systemStates.id, TEST_STATE_ID));
		await db.delete(apiKeys).where(eq(apiKeys.id, TEST_KEY_ID));
		await db.delete(companyDailyProfits).run();
		await db
			.delete(ledgerEvents)
			.where(eq(ledgerEvents.transactionName, "Daily Company Profit/Loss"))
			.run();

		// Insert personal API key fixture
		await db.insert(apiKeys).values({
			id: TEST_KEY_ID,
			userId: 99999,
			keyType: "personal",
			apiKeyEncrypted: "test_personal_key_company_sync_123",
			apiKeyHash: "hash_personal_key_company_sync_123",
			isValid: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		resetCompanySyncState();
	});

	afterEach(async () => {
		process.env.TORN_API_KEY = originalEnvKey;
		if (getPersonalSpy) {
			getPersonalSpy.mockRestore();
		}
		await db.delete(systemStates).where(eq(systemStates.id, TEST_STATE_ID));
		await db.delete(apiKeys).where(eq(apiKeys.id, TEST_KEY_ID));
		await db.delete(companyDailyProfits).run();
		await db
			.delete(ledgerEvents)
			.where(eq(ledgerEvents.transactionName, "Daily Company Profit/Loss"))
			.run();
	});

	test("initializes default state and loads state from database", async () => {
		const initialState = getCompanySyncState();
		expect(initialState.status).toBe("idle");
		expect(initialState.lastProfit).toBe(0);

		await db.insert(systemStates).values({
			id: TEST_STATE_ID,
			init: true,
			data: {
				status: "completed",
				lastInflow: 5000000,
				lastOutflow: 1200000,
				lastProfit: 3800000,
				lastSyncTimestamp: 1700000000,
				lastError: null,
				updatedAt: new Date().toISOString(),
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const loaded = await loadCompanySyncState();
		expect(loaded.status).toBe("completed");
		expect(loaded.lastInflow).toBe(5000000);
		expect(loaded.lastOutflow).toBe(1200000);
		expect(loaded.lastProfit).toBe(3800000);
	});

	test("syncs daily company profit and inserts records into companyDailyProfits & ledgerEvents", async () => {
		const mockResponse = {
			profile: {
				id: 1234,
				name: "Cyber Security Firm",
				income: {
					daily: 10000000,
				},
				advertisement_budget: 500000,
			},
			employees: [
				{ id: 1, name: "Alice", wage: 100000 },
				{ id: 2, name: "Bob", wage: 150000 },
				{ id: 3, name: "Charlie", wage: 200000 },
			],
		};

		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation((async (
			path: string,
			options?: unknown,
		) => {
			expect(path).toBe("/company");
			const opts = options as { queryParams?: { selections?: string[] } };
			expect(opts?.queryParams?.selections).toEqual(["profile", "employees"]);
			return mockResponse;
		}) as unknown as typeof tornApi.getPersonal);

		const result = await syncCompanyDailyProfit();
		expect(result).not.toBeNull();
		if (!result) return;

		// Inflow: 10,000,000
		// Outflow: 500,000 (ad budget) + 100,000 + 150,000 + 200,000 (wages) = 950,000
		// Profit: 9,050,000
		expect(result.inflow).toBe(10000000);
		expect(result.outflow).toBe(950000);
		expect(result.profit).toBe(9050000);

		// Check state
		const state = getCompanySyncState();
		expect(state.status).toBe("completed");
		expect(state.lastProfit).toBe(9050000);

		// Verify database insertion in companyDailyProfits
		const snapshots = await db.select().from(companyDailyProfits).all();
		expect(snapshots.length).toBe(1);
		const snapshot = snapshots[0];
		expect(snapshot?.inflow).toBe(10000000);
		expect(snapshot?.outflow).toBe(950000);
		expect(snapshot?.profit).toBe(9050000);

		// Verify database insertion in ledgerEvents
		const events = await db
			.select()
			.from(ledgerEvents)
			.where(eq(ledgerEvents.transactionName, "Daily Company Profit/Loss"))
			.all();
		expect(events.length).toBe(1);
		const ev = events[0];
		expect(ev?.realizedPnl).toBe(9050000);
		expect(ev?.type).toBe("injection");
		expect(ev?.categoryId).toBe(9);
	});

	test("handles loss scenario correctly (outflow > inflow)", async () => {
		const mockResponse = {
			profile: {
				id: 5678,
				name: "Struggling Startup",
				daily_income: 200000,
				advertisement_budget: 300000,
			},
			employees: {
				"101": { id: 101, name: "Dave", wage: 150000 },
			},
		};

		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation(
			(async () => {
				return mockResponse;
			}) as unknown as typeof tornApi.getPersonal,
		);

		const result = await syncCompanyDailyProfit();
		expect(result).not.toBeNull();
		if (!result) return;

		// Inflow: 200,000
		// Outflow: 300,000 + 150,000 = 450,000
		// Profit: -250,000
		expect(result.inflow).toBe(200000);
		expect(result.outflow).toBe(450000);
		expect(result.profit).toBe(-250000);

		const events = await db
			.select()
			.from(ledgerEvents)
			.where(eq(ledgerEvents.transactionName, "Daily Company Profit/Loss"))
			.all();
		expect(events.length).toBe(1);
		expect(events[0]?.type).toBe("loss");
		expect(events[0]?.realizedPnl).toBe(-250000);
	});

	test("handles missing personal key gracefully without throwing", async () => {
		delete process.env.TORN_API_KEY;
		await db.delete(apiKeys).where(eq(apiKeys.id, TEST_KEY_ID));

		const result = await syncCompanyDailyProfit();
		expect(result).toBeNull();
	});

	test("handles API error gracefully without throwing", async () => {
		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation(
			(async () => {
				throw new Error("API rate limit exceeded");
			}) as unknown as typeof tornApi.getPersonal,
		);

		const result = await syncCompanyDailyProfit();
		expect(result).toBeNull();

		const state = getCompanySyncState();
		expect(state.status).toBe("error");
		expect(state.lastError).toContain("API rate limit exceeded");
	});

	test("startCompanySync registers listener for company_pay_received event", async () => {
		getPersonalSpy = spyOn(tornApi, "getPersonal").mockImplementation(
			(async () => {
				return {
					profile: { daily_income: 1000, advertisement_budget: 100 },
					employees: [],
				};
			}) as unknown as typeof tornApi.getPersonal,
		);

		startCompanySync({ initialDelayMs: 0 });

		// Emit event
		schedulerEvents.emit("company_pay_received");

		// Wait briefly for async handler
		await new Promise((r) => setTimeout(r, 100));

		expect(getPersonalSpy).toHaveBeenCalled();
	});
});
