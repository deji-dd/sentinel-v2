import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as dbModule from "@sentinel/database";
import {
	FF_SCOUTER_BATCH_SIZE,
	FFScouterApiError,
	FFScouterBatcher,
	FFScouterCircuitBreaker,
	FFScouterRateLimiter,
	fetchFFScouterBatchWithRetry,
	fetchFFScouterStats,
	ffScouterCircuitBreaker,
	getPlayerStats,
} from "../src/ffscouter";

describe("FFScouter Rate Limiter", () => {
	test("enforces sliding window request count", async () => {
		const limiter = new FFScouterRateLimiter(3, 200);

		await limiter.waitIfNeeded();
		await limiter.waitIfNeeded();
		await limiter.waitIfNeeded();

		expect(limiter.getRequestCount()).toBe(3);

		const start = Date.now();
		// 4th request should pause until window passes
		await limiter.waitIfNeeded();
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(150);
	});
});

describe("FFScouter Retries & Error Handling", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		fetchSpy?.mockRestore();
	});

	test("retries on HTTP 429 and respects Retry-After header", async () => {
		let callCount = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			callCount++;
			if (callCount === 1) {
				return new Response(JSON.stringify({ error: "Too Many Requests" }), {
					status: 429,
					headers: { "Retry-After": "0.1" },
				});
			}
			return new Response(
				JSON.stringify([
					{
						player_id: 1001,
						bs_estimate: 5000000,
						fair_fight: 3.5,
						bss_public: null,
						bs_estimate_human: "5m",
						last_updated: Date.now(),
						source: "bss",
						premium_insights_available: false,
						distribution: null,
						spies: [],
						available_estimates: { bss: null, premium: null, spies: null },
					},
				]),
				{ status: 200 },
			);
		}) as unknown as typeof fetch);

		const results = await fetchFFScouterBatchWithRetry(
			[1001],
			"valid_api_key_16",
			{
				maxRetries: 2,
				initialBackoffMs: 10,
			},
		);

		expect(callCount).toBe(2);
		expect(results).toHaveLength(1);
		expect(results[0]?.player_id).toBe(1001);
	});

	test("retries on HTTP 500 server error and succeeds", async () => {
		let callCount = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			callCount++;
			if (callCount === 1) {
				return new Response("Internal Server Error", { status: 500 });
			}
			return new Response(
				JSON.stringify([
					{
						player_id: 1002,
						bs_estimate: 1000000,
						fair_fight: 2.1,
						bss_public: null,
						bs_estimate_human: "1m",
						last_updated: Date.now(),
						source: "bss",
						premium_insights_available: false,
						distribution: null,
						spies: [],
						available_estimates: { bss: null, premium: null, spies: null },
					},
				]),
				{ status: 200 },
			);
		}) as unknown as typeof fetch);

		const results = await fetchFFScouterBatchWithRetry(
			[1002],
			"valid_api_key_16",
			{
				maxRetries: 2,
				initialBackoffMs: 10,
			},
		);

		expect(callCount).toBe(2);
		expect(results).toHaveLength(1);
		expect(results[0]?.player_id).toBe(1002);
	});

	test("fails immediately on non-retryable error codes (e.g., Code 6 Invalid API Key)", async () => {
		let callCount = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			callCount++;
			return new Response(
				JSON.stringify({
					code: 6,
					error:
						"Invalid API key. Please sign up at ffscouter.com to use this service",
				}),
				{ status: 401 },
			);
		}) as unknown as typeof fetch);

		let caughtError: unknown;
		try {
			await fetchFFScouterBatchWithRetry([1003], "invalid_key", {
				maxRetries: 3,
				initialBackoffMs: 10,
			});
		} catch (err) {
			caughtError = err;
		}

		expect(callCount).toBe(1); // Fast-fails on attempt 1 without wasting retries
		expect(caughtError).toBeInstanceOf(FFScouterApiError);
		expect((caughtError as FFScouterApiError).code).toBe(6);
		expect((caughtError as FFScouterApiError).isRetryable).toBe(false);
	});

	test("fails immediately on account ban code 4010", async () => {
		let callCount = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			callCount++;
			return new Response(
				JSON.stringify({
					code: 4010,
					error: "The account is banned from FFScouter.",
				}),
				{ status: 403 },
			);
		}) as unknown as typeof fetch);

		let caughtError: unknown;
		try {
			await fetchFFScouterBatchWithRetry([1004], "banned_key", {
				maxRetries: 3,
				initialBackoffMs: 10,
			});
		} catch (err) {
			caughtError = err;
		}

		expect(callCount).toBe(1);
		expect(caughtError).toBeInstanceOf(FFScouterApiError);
		expect((caughtError as FFScouterApiError).code).toBe(4010);
		expect((caughtError as FFScouterApiError).isRetryable).toBe(false);
	});
});

describe("FFScouter Batch Chunking", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		fetchSpy?.mockRestore();
	});

	test("chunks requests when player IDs exceed 200", async () => {
		const urlsCalled: string[] = [];
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			url: string,
		) => {
			urlsCalled.push(url);
			return new Response(JSON.stringify([]), { status: 200 });
		}) as unknown as typeof fetch);

		// Generate 250 unique IDs
		const ids = Array.from({ length: 250 }, (_, i) => i + 1);
		await fetchFFScouterStats(ids, "test_key_12345678");

		expect(urlsCalled.length).toBe(2);
		expect(urlsCalled[0]).toContain(
			`targets=${Array.from({ length: FF_SCOUTER_BATCH_SIZE }, (_, i) => i + 1).join(",")}`,
		);
	});
});

describe("FFScouter Smart Batcher (DataLoader pattern)", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		fetchSpy?.mockRestore();
	});

	test("coalesces concurrent requests and returns specific results to each caller", async () => {
		let callCount = 0;
		const requestedTargets: string[] = [];

		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			url: string,
		) => {
			callCount++;
			const parsed = new URL(url);
			const targets = parsed.searchParams.get("targets") ?? "";
			requestedTargets.push(targets);

			const targetIds = targets.split(",").map((id) => Number.parseInt(id, 10));
			const results = targetIds.map((id) => ({
				player_id: id,
				bs_estimate: id * 1000,
				fair_fight: 1.0,
				bss_public: null,
				bs_estimate_human: `${id}k`,
				last_updated: Date.now(),
				source: "bss",
				premium_insights_available: false,
				distribution: null,
				spies: [],
				available_estimates: { bss: null, premium: null, spies: null },
			}));

			return new Response(JSON.stringify(results), { status: 200 });
		}) as unknown as typeof fetch);

		const batcher = new FFScouterBatcher(30);

		// Caller 1 requests [101, 102]
		// Caller 2 requests [102, 103]
		// Caller 3 requests [104]
		const [res1, res2, res3] = await Promise.all([
			batcher.fetch([101, 102], "test_api_key_coalesce"),
			batcher.fetch([102, 103], "test_api_key_coalesce"),
			batcher.fetch([104], "test_api_key_coalesce"),
		]);

		// Single coalesced upstream call was made
		expect(callCount).toBe(1);
		// All 4 unique IDs were bundled
		expect(requestedTargets[0]).toContain("101");
		expect(requestedTargets[0]).toContain("102");
		expect(requestedTargets[0]).toContain("103");
		expect(requestedTargets[0]).toContain("104");

		// Caller 1 only received [101, 102]
		expect(res1.map((r) => r.player_id).sort()).toEqual([101, 102]);
		// Caller 2 only received [102, 103]
		expect(res2.map((r) => r.player_id).sort()).toEqual([102, 103]);
		// Caller 3 only received [104]
		expect(res3.map((r) => r.player_id).sort()).toEqual([104]);
	});
});

describe("FFScouter Circuit Breaker & Exponential Backoff", () => {
	let fetchSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		ffScouterCircuitBreaker.reset();
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		ffScouterCircuitBreaker.reset();
	});

	test("applies exponential backoff on consecutive service failures up to maxBackoff", () => {
		const breaker = new FFScouterCircuitBreaker(10_000, 80_000);

		expect(breaker.isOpen()).toBe(false);
		expect(breaker.getConsecutiveFailures()).toBe(0);

		// Failure 1: 10s backoff (10 * 2^0)
		const b1 = breaker.recordFailure(new Error("500 Internal Server Error"));
		expect(b1).toBe(10_000);
		expect(breaker.getConsecutiveFailures()).toBe(1);
		expect(breaker.isOpen()).toBe(true);
		expect(breaker.getRemainingBackoffMs()).toBeGreaterThan(0);

		// Failure 2: 20s backoff (10 * 2^1)
		const b2 = breaker.recordFailure(new Error("500 Internal Server Error"));
		expect(b2).toBe(20_000);
		expect(breaker.getConsecutiveFailures()).toBe(2);

		// Failure 3: 40s backoff (10 * 2^2)
		const b3 = breaker.recordFailure(new Error("500 Internal Server Error"));
		expect(b3).toBe(40_000);

		// Failure 4: 80s backoff (capped at maxBackoff = 80s)
		const b4 = breaker.recordFailure(new Error("500 Internal Server Error"));
		expect(b4).toBe(80_000);

		// Failure 5: still capped at 80s
		const b5 = breaker.recordFailure(new Error("500 Internal Server Error"));
		expect(b5).toBe(80_000);

		// Success resets breaker
		breaker.recordSuccess();
		expect(breaker.isOpen()).toBe(false);
		expect(breaker.getConsecutiveFailures()).toBe(0);
		expect(breaker.getRemainingBackoffMs()).toBe(0);
	});

	test("fetchFFScouterBatchWithRetry triggers circuit breaker after exhausting retries on HTTP 500", async () => {
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			return new Response(JSON.stringify({ message: "Server Error" }), {
				status: 500,
			});
		}) as unknown as typeof fetch);

		expect(ffScouterCircuitBreaker.isOpen()).toBe(false);

		let caughtErr: unknown;
		try {
			await fetchFFScouterBatchWithRetry([999], "test_key", {
				maxRetries: 1,
				initialBackoffMs: 5,
			});
		} catch (err) {
			caughtErr = err;
		}

		expect(caughtErr).toBeInstanceOf(FFScouterApiError);
		// Circuit breaker is now tripped
		expect(ffScouterCircuitBreaker.isOpen()).toBe(true);
		expect(ffScouterCircuitBreaker.getConsecutiveFailures()).toBe(1);

		// Subsequent call is blocked immediately by circuit breaker without making network calls
		let callCount = 0;
		fetchSpy.mockImplementation((async () => {
			callCount++;
			return new Response("OK", { status: 200 });
		}) as unknown as typeof fetch);

		let blockedErr: unknown;
		try {
			await fetchFFScouterBatchWithRetry([999], "test_key");
		} catch (err) {
			blockedErr = err;
		}

		expect(callCount).toBe(0);
		expect(blockedErr).toBeInstanceOf(FFScouterApiError);
		expect((blockedErr as FFScouterApiError).httpStatus).toBe(503);
		expect((blockedErr as FFScouterApiError).message).toContain(
			"exponential backoff",
		);
	});
});

describe("FFScouter getPlayerStats Resilient Cache Return", () => {
	let fetchSpy: ReturnType<typeof spyOn>;
	let getCacheSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		ffScouterCircuitBreaker.reset();
	});

	afterEach(() => {
		fetchSpy?.mockRestore();
		getCacheSpy?.mockRestore();
		ffScouterCircuitBreaker.reset();
	});

	test("returns cached stats even when upstream FFScouter API fails with HTTP 500", async () => {
		const cachedMock = new Map<number, Record<string, unknown>>();
		cachedMock.set(1001, {
			player_id: 1001,
			bs_estimate: 250_000,
			fair_fight: 1.8,
			bss_public: null,
			bs_estimate_human: "250k",
			last_updated: Date.now(),
			source: "bss",
			premium_insights_available: false,
			distribution: null,
			spies: [],
			available_estimates: { bss: null, premium: null, spies: null },
		});

		// 1001 is cached in database; 1002 is a miss
		getCacheSpy = spyOn(dbModule, "getPlayerStatCacheRaw").mockResolvedValue(
			cachedMock,
		);

		// Upstream fetch fails with 500
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			return new Response(JSON.stringify({ message: "Server Error" }), {
				status: 500,
			});
		}) as unknown as typeof fetch);

		// Request both [1001, 1002] with fast retries for the test
		const results = await getPlayerStats([1001, 1002], "test_key_16_char", {
			maxRetries: 1,
			initialBackoffMs: 5,
		});

		// Should NOT throw! Should return the cached target 1001
		expect(results).toHaveLength(1);
		expect(results[0]?.player_id).toBe(1001);
		expect(results[0]?.fair_fight).toBe(1.8);
	});

	test("serves cached results immediately without network calls when circuit breaker is open", async () => {
		const cachedMock = new Map<number, Record<string, unknown>>();
		cachedMock.set(2001, {
			player_id: 2001,
			bs_estimate: 500_000,
			fair_fight: 2.5,
			bss_public: null,
			bs_estimate_human: "500k",
			last_updated: Date.now(),
			source: "bss",
			premium_insights_available: false,
			distribution: null,
			spies: [],
			available_estimates: { bss: null, premium: null, spies: null },
		});

		getCacheSpy = spyOn(dbModule, "getPlayerStatCacheRaw").mockResolvedValue(
			cachedMock,
		);

		// Trip circuit breaker manually
		ffScouterCircuitBreaker.recordFailure(new Error("Outage"));
		expect(ffScouterCircuitBreaker.isOpen()).toBe(true);

		let fetchCalls = 0;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			fetchCalls++;
			return new Response("OK", { status: 200 });
		}) as unknown as typeof fetch);

		const results = await getPlayerStats([2001, 2002], "test_key_16_char");

		// No network calls made because circuit breaker is open
		expect(fetchCalls).toBe(0);
		// Cached result returned
		expect(results).toHaveLength(1);
		expect(results[0]?.player_id).toBe(2001);
	});
});
