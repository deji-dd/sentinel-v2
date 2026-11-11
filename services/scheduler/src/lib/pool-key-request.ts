import {
	getActiveSystemKeyPool,
	type ManagedApiKey,
	TornError,
} from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";

import {
	getSubversiveUserKeys,
	markSubversiveKeyDisabled,
	recordSubversiveKeySuccess,
	subversiveKeyHealthManager,
} from "../workers/subversive/subversive-key-pool";

const logger = new Logger("Scheduler", "PoolKeyRequest");

/** Key-level errors: the key is bad, not the request. */
const KEY_ERROR_CODES = new Set([2, 10, 13, 18]);

/** Bounded at 32 so a large pool cannot open an unbounded number of sockets. */
const MAX_TOTAL_CONCURRENCY = 32;
const CONCURRENCY_PER_KEY = 4;

let cachedPool: { keys: ManagedApiKey[]; cachedAt: number } | null = null;
const POOL_TTL_MS = 15_000;

export interface PoolCallRecord {
	endpoint: string;
	keySuffix: string;
	keyOwner: number | null;
	status: number | null;
	latencyMs: number;
	errorCode: number | null;
	error: string | null;
}

let callRecorder: PoolCallRecord[] | null = null;

/** Starts collecting one smoke-test/support run's Torn calls. */
export function beginPoolCallRecording(): void {
	callRecorder = [];
}

/** Stops recording and returns the captured calls. */
export function endPoolCallRecording(): PoolCallRecord[] {
	const records = callRecorder ?? [];
	callRecorder = null;
	return records;
}

function recordCall(
	label: string,
	key: ManagedApiKey,
	startedAt: number,
	error: unknown,
): void {
	if (!callRecorder) return;
	const tornError = error instanceof TornError ? error : null;
	callRecorder.push({
		endpoint: label,
		keySuffix: key.apiKey.slice(-4),
		keyOwner: key.userId || null,
		status: error ? null : 200,
		latencyMs: Date.now() - startedAt,
		errorCode: tornError?.code ?? null,
		error: error
			? error instanceof Error
				? error.message
				: String(error)
			: null,
	});
}

/**
 * Returns every active Subversive key, falling back to system keys only when
 * there are not enough user keys to spread work.
 *
 * This is the parallel counterpart to `getNextSubversiveUserKey`: sequential
 * code should keep using the round-robin helper, while batch work (the stock
 * detail bootstrap/refresh) should see the whole pool at once.
 */
export async function getPoolKeys(): Promise<ManagedApiKey[]> {
	if (cachedPool && Date.now() - cachedPool.cachedAt < POOL_TTL_MS) {
		return cachedPool.keys;
	}

	const userKeys = await getSubversiveUserKeys();
	let pool = userKeys.filter(
		(key) => !subversiveKeyHealthManager.isKeyTemporarilyDisabled(key.apiKey),
	);

	if (pool.length <= 1) {
		try {
			const systemKeys = await getActiveSystemKeyPool();
			const active = systemKeys.filter(
				(key) =>
					!subversiveKeyHealthManager.isKeyTemporarilyDisabled(key.apiKey),
			);
			if (active.length > 0) {
				const seen = new Set(pool.map((key) => key.apiKey));
				pool = [...pool, ...active.filter((key) => !seen.has(key.apiKey))];
			}
		} catch (error) {
			logger.warn(
				`Could not load system keys for parallel batch: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// Local/dev and first-boot fallback: the environment key is a real key the
	// owner has authorised for this deployment. It is used only when no user or
	// system key is available, never instead of the pool.
	if (pool.length === 0) {
		const envKey = process.env.TORN_API_KEY?.trim();
		if (envKey && envKey.length === 16) {
			pool = [{ apiKey: envKey, userId: 0, keyType: "personal" }];
		}
	}

	cachedPool = { keys: pool, cachedAt: Date.now() };
	return pool;
}

/** Test seam and key-mutation invalidation. */
export function clearPoolKeyCache(): void {
	cachedPool = null;
}

export function isPoolKeyError(error: unknown): boolean {
	if (error instanceof TornError) return KEY_ERROR_CODES.has(error.code);
	return String(error).includes("Key temporarily disabled");
}

function pickKey(pool: ManagedApiKey[], cursor: number): ManagedApiKey | null {
	if (pool.length === 0) return null;
	const key = pool[cursor % pool.length];
	return key ?? null;
}

/**
 * Runs one request against a fresh key, rotating once when the key itself is
 * rejected. Non-key failures are surfaced immediately: retrying a malformed
 * request on another key would just burn a second key.
 */
export async function requestWithPool<T>(
	label: string,
	run: (key: ManagedApiKey) => Promise<T>,
): Promise<T> {
	const pool = await getPoolKeys();
	if (pool.length === 0) {
		throw new Error("No active Subversive or system API keys are available.");
	}

	let lastError: unknown = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		const key = pool[attempt % pool.length];
		if (!key) continue;
		const startedAt = Date.now();
		try {
			const result = await run(key);
			recordCall(label, key, startedAt, null);
			recordSubversiveKeySuccess(key.apiKey);
			return result;
		} catch (error) {
			recordCall(label, key, startedAt, error);
			lastError = error;
			if (!isPoolKeyError(error)) throw error;
			const cooldownMs = markSubversiveKeyDisabled(key.apiKey);
			logger.warn(
				`${label} rejected key ending '...${key.apiKey.slice(-4)}' (disabled for ${Math.round(cooldownMs / 1000)}s).`,
			);
			cachedPool = null;
		}
	}
	throw lastError ?? new Error(`${label} failed without a recorded error.`);
}

export interface MapWithPoolOptions {
	concurrencyPerKey?: number;
	onError?: (item: unknown, error: unknown) => void;
}

/**
 * Maps independent requests across the whole pool.
 *
 * Work is pulled from a shared cursor by a bounded number of workers; keys are
 * assigned round-robin, so a 35-request detail sweep is spread over every
 * available key instead of pinning one. A failed item is retried once on the
 * next key; a non-key error is reported through `onError` and yields `null`
 * for that item, so one bad stock cannot fail the whole cycle.
 */
export async function mapWithPool<T, R>(
	items: readonly T[],
	label: string,
	run: (item: T, key: ManagedApiKey) => Promise<R>,
	options: MapWithPoolOptions = {},
): Promise<Array<R | null>> {
	if (items.length === 0) return [];
	const pool = await getPoolKeys();
	if (pool.length === 0) {
		throw new Error("No active Subversive or system API keys are available.");
	}

	const perKey = Math.max(1, options.concurrencyPerKey ?? CONCURRENCY_PER_KEY);
	const total = Math.min(
		MAX_TOTAL_CONCURRENCY,
		Math.max(1, pool.length * perKey),
	);
	const results: Array<R | null> = new Array(items.length).fill(null);
	let cursor = 0;
	let keyCursor = 0;

	const nextKey = (): ManagedApiKey | null => {
		for (let i = 0; i < pool.length; i++) {
			const key = pickKey(pool, keyCursor + i);
			if (!key) continue;
			if (!subversiveKeyHealthManager.isKeyTemporarilyDisabled(key.apiKey)) {
				keyCursor += i + 1;
				return key;
			}
		}
		return null;
	};

	const worker = async (): Promise<void> => {
		while (true) {
			const index = cursor;
			cursor += 1;
			if (index >= items.length) return;
			const item = items[index];
			if (item === undefined) continue;

			let lastError: unknown = null;
			let completed = false;
			for (let attempt = 0; attempt < 2 && !completed; attempt++) {
				const key = nextKey();
				if (!key) {
					lastError = new Error("All API keys are temporarily disabled.");
					break;
				}
				const startedAt = Date.now();
				try {
					const result = await run(item, key);
					recordCall(label, key, startedAt, null);
					recordSubversiveKeySuccess(key.apiKey);
					results[index] = result;
					completed = true;
				} catch (error) {
					recordCall(label, key, startedAt, error);
					lastError = error;
					if (isPoolKeyError(error)) {
						markSubversiveKeyDisabled(key.apiKey);
						cachedPool = null;
						continue;
					}
					break;
				}
			}

			if (!completed) {
				options.onError?.(item, lastError);
				logger.warn(
					`${label} failed for item ${index}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
				);
			}
		}
	};

	await Promise.all(Array.from({ length: total }, () => worker()));
	return results;
}
