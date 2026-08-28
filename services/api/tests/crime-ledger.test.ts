import { describe, expect, it, spyOn } from "bun:test";
import { crimeActionMappings, db, eq } from "@sentinel/database";
import { app } from "../src/app";
import * as schedulerIpc from "../src/lib/scheduler-ipc";

describe("Elysia API Server - Crime Ledger Routes", () => {
	it("GET /api/v1/system/crime-ledger/state returns state object", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/system/crime-ledger/state"),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as Record<string, unknown>;
		expect(typeof data.status).toBe("string");
		expect(typeof data.totalIndexedCrimes).toBe("number");
		expect(typeof data.totalInDb).toBe("number");
		expect(typeof data.totalNerveSpent).toBe("number");
		expect(typeof data.totalLootValue).toBe("number");
		expect(typeof data.distinctCrimesCount).toBe("number");
	});

	it("GET /api/v1/system/crime-ledger/definitions returns list of definitions", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/system/crime-ledger/definitions"),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			definitions: Array<{ id: number; name: string }>;
		};
		expect(Array.isArray(data.definitions)).toBe(true);
		expect(data.definitions.length).toBeGreaterThan(0);
		expect(data.definitions[0]?.id).toBeDefined();
		expect(data.definitions[0]?.name).toBeDefined();
	});

	it("GET /api/v1/system/crime-ledger/logs returns paginated records", async () => {
		const response = await app.handle(
			new Request(
				"http://localhost/api/v1/system/crime-ledger/logs?page=1&limit=10",
			),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			logs: Array<unknown>;
			total: number;
			page: number;
			limit: number;
			totalPages: number;
		};
		expect(Array.isArray(data.logs)).toBe(true);
		expect(typeof data.total).toBe("number");
		expect(data.page).toBe(1);
		expect(data.limit).toBe(10);
	});

	it("GET /api/v1/system/crime-ledger/logs supports from and to date range parameters", async () => {
		const response = await app.handle(
			new Request(
				"http://localhost/api/v1/system/crime-ledger/logs?from=2026-01-01&to=2026-12-31&page=1&limit=5",
			),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			logs: Array<unknown>;
			total: number;
		};
		expect(Array.isArray(data.logs)).toBe(true);
		expect(typeof data.total).toBe("number");
	});

	it("GET /api/v1/system/crime-ledger/analytics returns KPIs, timeline, categories, hourly distribution", async () => {
		const response = await app.handle(
			new Request(
				"http://localhost/api/v1/system/crime-ledger/analytics?days=30",
			),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			kpis: {
				totalCrimes: number;
				totalNerve: number;
				totalValue: number;
				distinctCrimes: number;
				avgValuePerCrime: number;
				avgNervePerCrime: number;
				avgValuePerNerve: number;
			};
			timeline: Array<{
				date: string;
				count: number;
				nerve: number;
				value: number;
				efficiency: number;
			}>;
			categories: Array<{
				crimeId: number;
				crimeName: string;
				count: number;
				nerve: number;
				value: number;
				efficiency: number;
				percentage: number;
			}>;
			hourly: Array<{ hour: number; count: number; nerve: number }>;
			topLootEvents: Array<{
				id: string;
				action: string;
				crimeId: number;
				crimeName: string;
				nerve: number;
				value: number;
			}>;
		};

		expect(data.kpis).toBeDefined();
		expect(typeof data.kpis.totalCrimes).toBe("number");
		expect(typeof data.kpis.totalNerve).toBe("number");
		expect(typeof data.kpis.totalValue).toBe("number");
		expect(Array.isArray(data.timeline)).toBe(true);
		expect(Array.isArray(data.categories)).toBe(true);
		expect(Array.isArray(data.hourly)).toBe(true);
		expect(data.hourly.length).toBe(24);
		expect(Array.isArray(data.topLootEvents)).toBe(true);
	});

	it("GET /api/v1/system/crime-ledger/analytics supports from and to date range parameters", async () => {
		const response = await app.handle(
			new Request(
				"http://localhost/api/v1/system/crime-ledger/analytics?from=2026-01-01&to=2026-12-31",
			),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			kpis: {
				totalCrimes: number;
				totalNerve: number;
				totalValue: number;
			};
			timeline: Array<unknown>;
		};
		expect(data.kpis).toBeDefined();
		expect(typeof data.kpis.totalCrimes).toBe("number");
		expect(Array.isArray(data.timeline)).toBe(true);
	});

	it("POST and GET /api/v1/system/crime-ledger/mappings manages custom action mappings", async () => {
		const testAction = `test_custom_action_${Date.now()}`;
		const postRes = await app.handle(
			new Request("http://localhost/api/v1/system/crime-ledger/mappings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: testAction,
					crimeId: 7,
				}),
			}),
		);

		expect(postRes.status).toBe(200);
		const postData = (await postRes.json()) as {
			success: boolean;
			mapping: { id: string; crimeId: number };
		};
		expect(postData.success).toBe(true);
		expect(postData.mapping.id).toBe(testAction);
		expect(postData.mapping.crimeId).toBe(7);

		const getRes = await app.handle(
			new Request("http://localhost/api/v1/system/crime-ledger/mappings"),
		);
		expect(getRes.status).toBe(200);
		const getData = (await getRes.json()) as {
			mappings: Array<{ id: string; crimeId: number }>;
		};
		expect(Array.isArray(getData.mappings)).toBe(true);
		expect(getData.mappings.some((m) => m.id === testAction)).toBe(true);

		// Cleanup
		db.delete(crimeActionMappings)
			.where(eq(crimeActionMappings.id, testAction))
			.run();
	});

	it("POST /api/v1/system/crime-ledger/reconcile dispatches re-initialization to scheduler", async () => {
		const ipcSpy = spyOn(
			schedulerIpc,
			"requestCrimeLedgerReinitialize",
		).mockResolvedValue(true);

		try {
			const response = await app.handle(
				new Request("http://localhost/api/v1/system/crime-ledger/reconcile", {
					method: "POST",
				}),
			);

			expect(response.status).toBe(200);
			const data = (await response.json()) as {
				success: boolean;
				message: string;
				schedulerNotified: boolean;
			};
			expect(data.success).toBe(true);
			expect(typeof data.message).toBe("string");
			expect(data.schedulerNotified).toBe(true);
			expect(ipcSpy).toHaveBeenCalledTimes(1);
		} finally {
			ipcSpy.mockRestore();
		}
	});
});
