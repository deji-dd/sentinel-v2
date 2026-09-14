import {
	getPlayerStatCacheRaw,
	upsertPlayerStatCacheRaw,
} from "@sentinel/database";
import { Logger } from "../../utils";

const logger = new Logger("FFScouter");

export const FF_SCOUTER_BATCH_SIZE = 200; // API maximum is 205; 200 provides safety margin
export const FF_SCOUTER_RATE_LIMIT_MAX = 20;
export const FF_SCOUTER_RATE_LIMIT_WINDOW_MS = 60_000;
export const FF_SCOUTER_COALESCE_DELAY_MS = 50;

/**
 * Known FFScouter API error codes and their human-readable descriptions.
 */
export const FFSCOUTER_ERROR_MESSAGES: Record<number, string> = {
	1: "API key is required",
	2: "Invalid API key format. Key must be 16 alphanumeric characters",
	3: "The targets parameter is required",
	4: "At least one target ID is required and no more than 205",
	5: "All target IDs must be positive integers",
	6: "Invalid API key. Please sign up at ffscouter.com to use this service",
	4010: "The account is banned from FFScouter. The response directs the user to the FFScouter Discord and does not include the staff ban reason.",
	4011: "The user's faction is banned from FFScouter. The response directs the user to the FFScouter Discord and does not include the staff ban reason.",
};

export class FFScouterApiError extends Error {
	readonly code?: number;
	readonly httpStatus?: number;
	readonly isRetryable: boolean;

	constructor(
		message: string,
		options?: {
			code?: number;
			httpStatus?: number;
			isRetryable?: boolean;
		},
	) {
		super(message);
		this.name = "FFScouterApiError";
		this.code = options?.code;
		this.httpStatus = options?.httpStatus;
		this.isRetryable = options?.isRetryable ?? false;
	}
}

function isFFScouterErrorPayload(
	val: unknown,
): val is { error: string; code?: number } {
	return (
		typeof val === "object" &&
		val !== null &&
		"error" in val &&
		typeof (val as { error: unknown }).error === "string"
	);
}

/**
 * Sliding Window RAM Rate Limiter for outbound requests to FFScouter.
 * Enforces a maximum of 20 requests per 60 seconds per process/IP.
 */
export class FFScouterRateLimiter {
	private maxRequests: number;
	private windowMs: number;
	private timestamps: number[] = [];
	private queueChain: Promise<void> = Promise.resolve();

	constructor(
		maxRequests = FF_SCOUTER_RATE_LIMIT_MAX,
		windowMs = FF_SCOUTER_RATE_LIMIT_WINDOW_MS,
	) {
		this.maxRequests = maxRequests;
		this.windowMs = windowMs;
	}

	async waitIfNeeded(): Promise<void> {
		const nextPromise = this.queueChain.then(async () => {
			const now = Date.now();
			const cutoff = now - this.windowMs;
			this.timestamps = this.timestamps.filter((ts) => ts > cutoff);

			if (this.timestamps.length >= this.maxRequests) {
				const oldest = this.timestamps[0];
				if (oldest !== undefined) {
					const delayNeeded = oldest + this.windowMs - now + 150; // 150ms buffer
					if (delayNeeded > 0) {
						logger.warn(
							`FFScouter IP rate limit reached (${this.timestamps.length}/${this.maxRequests} in 60s). Pausing for ${(delayNeeded / 1000).toFixed(2)}s...`,
						);
						await new Promise<void>((resolve) =>
							setTimeout(resolve, delayNeeded),
						);
					}
				}
			}

			const postWaitNow = Date.now();
			const freshCutoff = postWaitNow - this.windowMs;
			this.timestamps = this.timestamps.filter((ts) => ts > freshCutoff);
			this.timestamps.push(postWaitNow);
		});

		this.queueChain = nextPromise.catch(() => {});
		return nextPromise;
	}

	getRequestCount(): number {
		const cutoff = Date.now() - this.windowMs;
		this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
		return this.timestamps.length;
	}

	reset(): void {
		this.timestamps = [];
		this.queueChain = Promise.resolve();
	}
}

export const ffScouterRateLimiter = new FFScouterRateLimiter();

export interface FFScouterEstimate {
	bss_public?: number | null;
	bs_estimate: number | null;
	bs_estimate_human: string | null;
	last_updated: number | null;
	fair_fight: number | null;
	source?: string | null;
}

export interface FFScouterSpy {
	strength: number;
	speed: number;
	defense: number;
	dexterity: number;
	total: number;
	last_updated: number;
	source: string;
	source_faction_id?: number;
}

export interface FFScouterDistribution {
	last_updated: number;
	distribution_human: string;
	stats_percentage: {
		strength?: number;
		speed?: number;
		defense?: number;
		dexterity?: number;
	};
}

export interface FFScouterTargetResult {
	player_id: number;
	fair_fight: number | null;
	bs_estimate: number | null;
	bs_estimate_human: string | null;
	bss_public: number | null;
	last_updated: number | null;
	source: "bss" | "premium" | "spies" | string;
	premium_insights_available: boolean;
	distribution: FFScouterDistribution | null;
	spies: FFScouterSpy[];
	available_estimates: {
		bss: FFScouterEstimate | null;
		premium: FFScouterEstimate | null;
		spies: FFScouterEstimate | null;
	};
}

export interface FetchRetryOptions {
	maxRetries?: number;
	initialBackoffMs?: number;
	maxBackoffMs?: number;
}

/**
 * Executes a single batched HTTP request to FFScouter with rate limiting and exponential backoff retries.
 */
export async function fetchFFScouterBatchWithRetry(
	batch: number[],
	apiKey: string,
	options?: FetchRetryOptions,
): Promise<FFScouterTargetResult[]> {
	const maxRetries = options?.maxRetries ?? 3;
	const initialBackoffMs = options?.initialBackoffMs ?? 1000;
	const maxBackoffMs = options?.maxBackoffMs ?? 30_000;

	const targets = batch.join(",");
	const url = `https://ffscouter.com/api/v1/get-stats?key=${encodeURIComponent(apiKey)}&targets=${targets}`;

	let lastError: unknown;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		await ffScouterRateLimiter.waitIfNeeded();

		try {
			const res = await fetch(url, {
				headers: {
					Accept: "application/json",
					"User-Agent": "Sentinel/2.0 (FFScouter Client)",
				},
			});

			if (!res.ok) {
				const errorText = await res.text().catch(() => "Unknown HTTP error");
				let parsedCode: number | undefined;
				let parsedMsg = errorText;

				try {
					const json = JSON.parse(errorText) as unknown;
					if (isFFScouterErrorPayload(json)) {
						parsedMsg = json.error;
						if (typeof (json as { code?: unknown }).code === "number") {
							parsedCode = (json as { code: number }).code;
						}
					}
				} catch {
					// Response body was not JSON
				}

				const isRetryable =
					res.status === 429 || (res.status >= 500 && res.status < 600);

				const err = new FFScouterApiError(
					parsedCode !== undefined
						? `FFScouter error (code ${parsedCode}): ${parsedMsg}`
						: `FFScouter request failed with HTTP ${res.status}: ${parsedMsg}`,
					{
						code: parsedCode,
						httpStatus: res.status,
						isRetryable,
					},
				);

				if (!isRetryable || attempt === maxRetries) {
					logger.error(
						`FFScouter API returned HTTP ${res.status}: ${parsedMsg}`,
					);
					throw err;
				}

				let delayMs = Math.min(
					initialBackoffMs * 2 ** attempt + Math.floor(Math.random() * 250),
					maxBackoffMs,
				);

				if (res.status === 429) {
					const retryAfter = res.headers.get("Retry-After");
					if (retryAfter) {
						const seconds = Number.parseInt(retryAfter, 10);
						if (!Number.isNaN(seconds) && seconds > 0) {
							delayMs = seconds * 1000 + 200;
						} else {
							const parsedDate = Date.parse(retryAfter);
							if (!Number.isNaN(parsedDate)) {
								delayMs = Math.max(0, parsedDate - Date.now()) + 200;
							}
						}
					}
					logger.warn(
						`FFScouter rate limited (HTTP 429). Retrying in ${(delayMs / 1000).toFixed(2)}s (attempt ${attempt + 1}/${maxRetries})...`,
					);
				} else {
					logger.warn(
						`FFScouter server error (HTTP ${res.status}). Retrying in ${(delayMs / 1000).toFixed(2)}s (attempt ${attempt + 1}/${maxRetries})...`,
					);
				}

				await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
				continue;
			}

			const data = (await res.json()) as unknown;
			if (Array.isArray(data)) {
				return data as FFScouterTargetResult[];
			}

			if (isFFScouterErrorPayload(data)) {
				const parsedCode =
					typeof (data as { code?: unknown }).code === "number"
						? (data as { code: number }).code
						: undefined;
				throw new FFScouterApiError(`FFScouter error: ${data.error}`, {
					code: parsedCode,
					httpStatus: 200,
					isRetryable: false,
				});
			}

			logger.warn("Unexpected FFScouter response format:", data);
			return [];
		} catch (err) {
			if (err instanceof FFScouterApiError && !err.isRetryable) {
				throw err;
			}

			lastError = err;
			if (attempt === maxRetries) {
				logger.error("Failed to query FFScouter API after retries:", err);
				break;
			}

			const delayMs = Math.min(
				initialBackoffMs * 2 ** attempt + Math.floor(Math.random() * 250),
				maxBackoffMs,
			);
			logger.warn(
				`FFScouter request network failure (${err instanceof Error ? err.message : String(err)}). Retrying in ${(delayMs / 1000).toFixed(2)}s (attempt ${attempt + 1}/${maxRetries})...`,
			);
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}

	throw lastError instanceof Error
		? lastError
		: new Error(`FFScouter request failed: ${String(lastError)}`);
}

/**
 * Low-level FFScouter API fetch.
 * Batches player IDs up to 200 items per request (API maximum is 205).
 * Errors are caught and re-thrown without swallowing.
 *
 * @internal — prefer `getPlayerStats` which adds smart coalescing and a 30-day DB cache layer.
 */
export async function fetchFFScouterStats(
	playerIds: number[],
	apiKey?: string,
): Promise<FFScouterTargetResult[]> {
	const key = (apiKey ?? process.env.FF_SCOUTER_KEY ?? "").trim();
	if (!key) {
		throw new Error(
			"FF_SCOUTER_KEY is not configured in the environment. Please set FF_SCOUTER_KEY in your environment variables.",
		);
	}

	const uniqueIds = Array.from(
		new Set(playerIds.filter((id) => Number.isInteger(id) && id > 0)),
	);
	if (uniqueIds.length === 0) {
		return [];
	}

	const results: FFScouterTargetResult[] = [];

	for (let i = 0; i < uniqueIds.length; i += FF_SCOUTER_BATCH_SIZE) {
		const batch = uniqueIds.slice(i, i + FF_SCOUTER_BATCH_SIZE);
		const batchResults = await fetchFFScouterBatchWithRetry(batch, key);
		results.push(...batchResults);
	}

	return results;
}

interface QueuedRequest {
	playerIds: Set<number>;
	resolve: (results: FFScouterTargetResult[]) => void;
	reject: (reason: unknown) => void;
}

interface BatchState {
	queue: QueuedRequest[];
	timer: ReturnType<typeof setTimeout> | null;
}

/**
 * DataLoader-style Request Coalescer for FFScouter.
 * Automatically bundles multiple one-off or concurrent getPlayerStats() calls within
 * a short window (default: 50ms) into unified batched upstream requests, deduplicates player IDs,
 * chunks them to 200 items, and routes the specific matching results back to each requester.
 */
export class FFScouterBatcher {
	private states = new Map<string, BatchState>();
	private coalesceMs: number;

	constructor(coalesceMs = FF_SCOUTER_COALESCE_DELAY_MS) {
		this.coalesceMs = coalesceMs;
	}

	async fetch(
		playerIds: number[],
		apiKey: string,
	): Promise<FFScouterTargetResult[]> {
		const positiveIds = playerIds.filter(
			(id) => Number.isInteger(id) && id > 0,
		);
		if (positiveIds.length === 0) {
			return [];
		}

		return new Promise<FFScouterTargetResult[]>((resolve, reject) => {
			let state = this.states.get(apiKey);
			if (!state) {
				state = { queue: [], timer: null };
				this.states.set(apiKey, state);
			}

			state.queue.push({
				playerIds: new Set(positiveIds),
				resolve,
				reject,
			});

			if (!state.timer) {
				state.timer = setTimeout(() => {
					void this.flush(apiKey);
				}, this.coalesceMs);
			}
		});
	}

	async flush(apiKey: string): Promise<void> {
		const state = this.states.get(apiKey);
		if (!state || state.queue.length === 0) {
			return;
		}

		if (state.timer) {
			clearTimeout(state.timer);
			state.timer = null;
		}

		const callers = state.queue;
		state.queue = [];

		const allIds = new Set<number>();
		for (const caller of callers) {
			for (const id of caller.playerIds) {
				allIds.add(id);
			}
		}

		const uniqueIds = Array.from(allIds);
		if (uniqueIds.length === 0) {
			for (const caller of callers) {
				caller.resolve([]);
			}
			return;
		}

		const resultMap = new Map<number, FFScouterTargetResult>();
		const failedIds = new Set<number>();
		let lastBatchError: unknown = null;

		for (let i = 0; i < uniqueIds.length; i += FF_SCOUTER_BATCH_SIZE) {
			const chunk = uniqueIds.slice(i, i + FF_SCOUTER_BATCH_SIZE);
			try {
				const freshResults = await fetchFFScouterBatchWithRetry(chunk, apiKey);

				// Persist into database cache incrementally per batch
				if (freshResults.length > 0) {
					await upsertPlayerStatCacheRaw(
						freshResults as unknown as Array<{
							player_id: number;
							source?: string | null;
							[key: string]: unknown;
						}>,
					);
				}

				for (const item of freshResults) {
					resultMap.set(item.player_id, item);
				}
			} catch (err) {
				lastBatchError = err;
				for (const id of chunk) {
					failedIds.add(id);
				}
			}
		}

		// Distribute results back to each specific caller
		for (const caller of callers) {
			const hasFailedId = Array.from(caller.playerIds).some((id) =>
				failedIds.has(id),
			);
			if (hasFailedId && lastBatchError) {
				caller.reject(lastBatchError);
			} else {
				const callerResults: FFScouterTargetResult[] = [];
				for (const id of caller.playerIds) {
					const found = resultMap.get(id);
					if (found) {
						callerResults.push(found);
					}
				}
				caller.resolve(callerResults);
			}
		}
	}

	async flushAll(): Promise<void> {
		const keys = Array.from(this.states.keys());
		for (const key of keys) {
			await this.flush(key);
		}
	}

	reset(): void {
		for (const state of this.states.values()) {
			if (state.timer) {
				clearTimeout(state.timer);
			}
		}
		this.states.clear();
	}
}

export const defaultFFScouterBatcher = new FFScouterBatcher();

export async function flushFFScouterBatcher(): Promise<void> {
	await defaultFFScouterBatcher.flushAll();
}

/**
 * Centralised entry point for FFScouter player stats with smart coalescing and 30-day DB cache.
 *
 * 1. Checks the `player_stat_cache` table for non-expired entries.
 * 2. Returns cached results immediately for fresh IDs.
 * 3. Transparently coalesces stale/missing IDs across callers within 50ms into batched queries (<=200 IDs).
 * 4. Enforces IP rate limiting (20 req/min) and exponential backoff retries.
 * 5. Persists newly fetched results back into the cache (TTL = 30 days).
 * 6. Returns the merged set of cached + freshly fetched results matching each caller's requested IDs.
 *
 * @param playerIds - Torn player IDs to look up.
 * @param apiKey    - Optional API key override (falls back to FF_SCOUTER_KEY env var).
 */
export async function getPlayerStats(
	playerIds: number[],
	apiKey?: string,
): Promise<FFScouterTargetResult[]> {
	const key = (apiKey ?? process.env.FF_SCOUTER_KEY ?? "").trim();
	if (!key) {
		throw new Error(
			"FF_SCOUTER_KEY is not configured in the environment. Please set FF_SCOUTER_KEY in your environment variables.",
		);
	}

	const uniqueIds = Array.from(
		new Set(playerIds.filter((id) => Number.isInteger(id) && id > 0)),
	);
	if (uniqueIds.length === 0) {
		return [];
	}

	// 1. Batch-check the DB cache for all requested IDs
	const cacheHits = await getPlayerStatCacheRaw(uniqueIds);

	const cachedResults: FFScouterTargetResult[] = [];
	const staleIds: number[] = [];

	for (const id of uniqueIds) {
		const hit = cacheHits.get(id);
		if (hit) {
			cachedResults.push(hit as unknown as FFScouterTargetResult);
		} else {
			staleIds.push(id);
		}
	}

	logger.info(
		`Player stats cache: ${cachedResults.length} hit(s), ${staleIds.length} miss(es) out of ${uniqueIds.length} requested.`,
	);

	if (staleIds.length === 0) {
		return cachedResults;
	}

	// 2. Fetch missing/stale IDs via the smart coalescing batcher
	const freshResults = await defaultFFScouterBatcher.fetch(staleIds, key);

	// 3. Return merged results (cached + fresh)
	return [...cachedResults, ...freshResults];
}
