import { describe, expect, it, spyOn } from "bun:test";
import { app } from "../src/app";
import * as schedulerIpc from "../src/lib/scheduler-ipc";

describe("Elysia API Server - Battlestats Ledger Routes", () => {
	it("GET /api/v1/system/battlestats-ledger/state returns state object", async () => {
		const response = await app.handle(
			new Request("http://localhost/api/v1/system/battlestats-ledger/state"),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as Record<string, unknown>;
		expect(typeof data.status).toBe("string");
		expect(typeof data.totalIndexedLogs).toBe("number");
	});

	it("GET /api/v1/system/battlestats-ledger/logs returns paginated records", async () => {
		const response = await app.handle(
			new Request(
				"http://localhost/api/v1/system/battlestats-ledger/logs?page=1&pageSize=10",
			),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			items: Array<unknown>;
			pagination: {
				total: number;
				page: number;
				pageSize: number;
				totalPages: number;
			};
		};
		expect(Array.isArray(data.items)).toBe(true);
		expect(typeof data.pagination.total).toBe("number");
		expect(data.pagination.page).toBe(1);
		expect(data.pagination.pageSize).toBe(10);
	});

	it("GET /api/v1/system/battlestats-ledger/logs supports from and to date range parameters", async () => {
		const response = await app.handle(
			new Request(
				"http://localhost/api/v1/system/battlestats-ledger/logs?from=2026-01-01&to=2026-12-31&page=1&pageSize=5",
			),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			items: Array<unknown>;
			pagination: {
				total: number;
			};
		};
		expect(Array.isArray(data.items)).toBe(true);
		expect(typeof data.pagination.total).toBe("number");
	});

	it("GET /api/v1/system/battlestats-ledger/analytics returns KPIs, timeline, stat breakdown, hourly distribution", async () => {
		const response = await app.handle(
			new Request(
				"http://localhost/api/v1/system/battlestats-ledger/analytics?days=30",
			),
		);

		expect(response.status).toBe(200);
		const data = (await response.json()) as {
			summary: {
				totalGained: number;
				totalTrains: number;
				totalEnergyUsed: number;
				totalLogs: number;
				avgGainPerTrain: number;
				avgGainPerEnergy: number;
			};
			timeline: Array<{
				date: string;
				strength: number;
				defense: number;
				speed: number;
				dexterity: number;
				totalGained: number;
			}>;
			statBreakdown: Array<{
				statType: string;
				gained: number;
			}>;
			sourceBreakdown: Array<{
				source: string;
				gained: number;
			}>;
			hourly: Array<{
				hour: number;
				count: number;
			}>;
		};
		expect(typeof data.summary.totalGained).toBe("number");
		expect(typeof data.summary.totalTrains).toBe("number");
		expect(typeof data.summary.totalEnergyUsed).toBe("number");
		expect(Array.isArray(data.timeline)).toBe(true);
		expect(Array.isArray(data.statBreakdown)).toBe(true);
		expect(Array.isArray(data.sourceBreakdown)).toBe(true);
		expect(Array.isArray(data.hourly)).toBe(true);
		expect(data.hourly.length).toBe(24);
	});

	it("POST /api/v1/system/battlestats-ledger/reconcile dispatches re-initialization to scheduler", async () => {
		const spy = spyOn(
			schedulerIpc,
			"requestBattlestatsLedgerReinitialize",
		).mockResolvedValue(true);

		const response = await app.handle(
			new Request(
				"http://localhost/api/v1/system/battlestats-ledger/reconcile",
				{
					method: "POST",
				},
			),
		);

		expect(response.status).toBe(200);
		const result = (await response.json()) as {
			success: boolean;
			message: string;
		};
		expect(result.success).toBe(true);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
	});
});
