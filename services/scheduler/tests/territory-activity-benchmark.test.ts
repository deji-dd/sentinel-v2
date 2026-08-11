import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	apiKeys,
	db,
	eq,
	like,
	territoryStates,
	warLedgers,
} from "@sentinel/database";
import { performance } from "node:perf_hooks";
import { executeActivityEngine } from "../src/workers/torn/territory-activity";

describe("Territory Activity Multi-Pass Performance Benchmark (DB vs Network vs CPU)", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	const MOCK_BENCHMARK_KEY_ID = "bench_mock_key_id_9999";

	beforeEach(async () => {
		// Ensure benchmark mock key exists without wiping real user keys
		await db
			.insert(apiKeys)
			.values({
				id: MOCK_BENCHMARK_KEY_ID,
				userId: 9999,
				apiKeyEncrypted: "bench_mock_key_123",
				apiKeyHash: "bench_mock_hash_123",
				keyType: "system",
				isValid: true,
			})
			.onConflictDoNothing();
	});

	afterEach(async () => {
		if (fetchSpy) {
			fetchSpy.mockRestore();
		}
		// Clean up ONLY the benchmark mock keys and benchmark records
		await db.delete(apiKeys).where(eq(apiKeys.id, MOCK_BENCHMARK_KEY_ID));
		await db
			.delete(territoryStates)
			.where(like(territoryStates.id, "TERR_BENCH_%"));
		await db.delete(warLedgers).where(like(warLedgers.id, "WAR_BENCH_%"));
	});

	test(
		"calculates average DB read/write performance vs Network across 3 passes",
		async () => {
			const NETWORK_LATENCY_MS = 20;
			const NUM_PASSES = 3;

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async (url: string | URL | Request) => {
				await new Promise((r) => setTimeout(r, NETWORK_LATENCY_MS));
				const urlStr = url.toString();

				if (urlStr.includes("/faction/rackets")) {
					return new Response(
						JSON.stringify({
							rackets: [
								{
									territory: "PAR",
									name: "Park Racket",
									level: 2,
									faction: 100,
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (urlStr.includes("/torn") && urlStr.includes("territorywars")) {
					return new Response(
						JSON.stringify({
							territorywars: {
								WAR_1: {
									territory_war_id: 12345,
									territory: "PAR",
									assaulting_faction: 200,
									defending_faction: 100,
									started: Math.floor(Date.now() / 1000) - 3600,
								},
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (
					urlStr.includes("/faction/basic") ||
					urlStr.includes("/faction/")
				) {
					return new Response(
						JSON.stringify({
							ID: 100,
							name: "Benchmark Faction",
							tag: "BENCH",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (urlStr.includes("/faction/territoryownership")) {
					return new Response(
						JSON.stringify({
							territoryOwnership: Array.from({ length: 500 }, (_, i) => ({
								id: `TERR_${i}`,
								faction: 100 + (i % 10),
								sector: 1,
								size: 10,
								density: 5,
								slots: 4,
							})),
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				return new Response(JSON.stringify({}), { status: 200 });
			}) as unknown as typeof fetch,
		);

		const dbReadTimes: number[] = [];
		const dbWriteTimes: number[] = [];
		const engineTimes: number[] = [];

		for (let pass = 1; pass <= NUM_PASSES; pass++) {
			// Benchmark 1: DB Read phase
			const dbReadStart = performance.now();
			await db.query.systemStates.findFirst();
			await db.query.territoryStates.findFirst();
			const dbReadDuration = performance.now() - dbReadStart;
			dbReadTimes.push(dbReadDuration);

			// Benchmark 2: Full Engine Execution
			const engineStart = performance.now();
			await executeActivityEngine();
			const totalEngineDuration = performance.now() - engineStart;
			engineTimes.push(totalEngineDuration);
		}

		const avg = (arr: number[]) =>
			arr.reduce((sum, v) => sum + v, 0) / arr.length;
		const min = (arr: number[]) => Math.min(...arr);
		const max = (arr: number[]) => Math.max(...arr);

		const avgTotalEngine = avg(engineTimes);
		const avgDbRead = avg(dbReadTimes);
		const avgNetwork = NETWORK_LATENCY_MS;
		const avgCpuAndDbWrite = Math.max(0, avgTotalEngine - avgNetwork);

		console.log(`
======================================================================
    TERRITORY ACTIVITY MULTI-PASS BENCHMARK (${NUM_PASSES} PASSES)
======================================================================
  • Total Loop Execution : avg ${avgTotalEngine.toFixed(2)} ms (min: ${min(engineTimes).toFixed(2)}ms, max: ${max(engineTimes).toFixed(2)}ms)
  • DB Warm Read Latency : avg ${avgDbRead.toFixed(2)} ms (min: ${min(dbReadTimes).toFixed(2)}ms, max: ${max(dbReadTimes).toFixed(2)}ms)
  • Network Overhead     : ~${avgNetwork.toFixed(2)} ms (11 parallel requests)
  • RAM Cache + DB Writes: ~${avgCpuAndDbWrite.toFixed(2)} ms
----------------------------------------------------------------------
  REAL-WORLD PROD ESTIMATE (Warm RAM Cache):
  - Network Fetching (API): ~${((avgNetwork / avgTotalEngine) * 100).toFixed(1)}% of execution time
  - RAM Cache / DB Writes : ~${((avgCpuAndDbWrite / avgTotalEngine) * 100).toFixed(1)}% of execution time
======================================================================
`);

		expect(engineTimes.length).toBe(NUM_PASSES);
		expect(avgTotalEngine).toBeGreaterThan(0);
	});
});
