import {
	getPlayerStatCacheRaw,
	upsertPlayerStatCacheRaw,
} from "@sentinel/database";
import { Logger } from "../../utils";

const logger = new Logger("FFScouter");

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

/**
 * Low-level FFScouter API fetch.
 * Batches player IDs up to 200 items per request (API maximum is 205).
 * Errors are caught and re-thrown without swallowing.
 *
 * @internal — prefer `getPlayerStats` which adds a 30-day DB cache layer.
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

	const uniqueIds = Array.from(new Set(playerIds.filter((id) => id > 0)));
	if (uniqueIds.length === 0) {
		return [];
	}

	const results: FFScouterTargetResult[] = [];
	const BATCH_SIZE = 200;

	for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
		const batch = uniqueIds.slice(i, i + BATCH_SIZE);
		const targets = batch.join(",");
		const url = `https://ffscouter.com/api/v1/get-stats?key=${encodeURIComponent(key)}&targets=${targets}`;

		try {
			const res = await fetch(url, {
				headers: {
					Accept: "application/json",
					"User-Agent": "Sentinel/2.0 (FFScouter Client)",
				},
			});

			if (!res.ok) {
				const errorText = await res.text().catch(() => "Unknown HTTP error");
				logger.error(`FFScouter API returned HTTP ${res.status}: ${errorText}`);
				throw new Error(
					`FFScouter request failed with HTTP ${res.status}: ${errorText}`,
				);
			}

			const data = (await res.json()) as unknown;
			if (Array.isArray(data)) {
				results.push(...(data as FFScouterTargetResult[]));
			} else if (
				data &&
				typeof data === "object" &&
				"error" in data &&
				typeof (data as { error: unknown }).error === "string"
			) {
				throw new Error(
					`FFScouter error: ${(data as { error: string }).error}`,
				);
			} else {
				logger.warn("Unexpected FFScouter response format:", data);
			}
		} catch (err) {
			logger.error("Failed to query FFScouter API:", err);
			throw err;
		}
	}

	return results;
}

/**
 * Centralised entry point for FFScouter player stats with a 30-day DB cache.
 *
 * 1. Checks the `player_stat_cache` table for non-expired entries.
 * 2. Returns cached results immediately for fresh IDs.
 * 3. Fetches only stale/missing IDs from the live FFScouter API.
 * 4. Persists newly fetched results back into the cache (TTL = 30 days).
 * 5. Returns the merged set of cached + freshly fetched results.
 *
 * @param playerIds - Torn player IDs to look up.
 * @param apiKey    - Optional API key override (falls back to FF_SCOUTER_KEY env var).
 */
export async function getPlayerStats(
	playerIds: number[],
	apiKey?: string,
): Promise<FFScouterTargetResult[]> {
	const uniqueIds = Array.from(new Set(playerIds.filter((id) => id > 0)));
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

	// 2. Fetch missing/stale IDs from the live API
	const freshResults = await fetchFFScouterStats(staleIds, apiKey);

	// 3. Persist fresh results into the cache
	if (freshResults.length > 0) {
		await upsertPlayerStatCacheRaw(
			freshResults as unknown as Array<{
				player_id: number;
				source?: string | null;
				[key: string]: unknown;
			}>,
		);
	}

	// 4. Return merged results (cached + fresh)
	return [...cachedResults, ...freshResults];
}
