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
 * Fetches player stats from FFScouter API using strictly the provided key (from FF_SCOUTER_KEY).
 * Batches player IDs up to 200 items per request (API maximum is 205).
 * Errors are caught and handled cleanly without mocking.
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
