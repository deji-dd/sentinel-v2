import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	FF_SCOUTER_BATCH_SIZE,
	FFScouterApiError,
	FFScouterBatcher,
	FFScouterRateLimiter,
	fetchFFScouterBatchWithRetry,
	fetchFFScouterStats,
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
