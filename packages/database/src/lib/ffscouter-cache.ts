import { and, gt, inArray } from "drizzle-orm";
import { db } from "../../index";
import { playerStatCache } from "../schema/ffscouter";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Retrieves all non-expired cache entries for the given Torn player IDs.
 * Returns a map from player_id → raw JSON payload (typed as Record<string, unknown>).
 * Callers in @sentinel/torn-api cast to FFScouterTargetResult.
 */
export async function getPlayerStatCacheRaw(
	playerIds: number[],
): Promise<Map<number, Record<string, unknown>>> {
	const result = new Map<number, Record<string, unknown>>();
	if (playerIds.length === 0) return result;

	const now = new Date();
	const rows = await db
		.select()
		.from(playerStatCache)
		.where(
			and(
				inArray(playerStatCache.playerId, playerIds),
				gt(playerStatCache.expiresAt, now),
			),
		);

	for (const row of rows) {
		result.set(row.playerId, row.data as Record<string, unknown>);
	}
	return result;
}

/**
 * Upserts a batch of FFScouter API results (raw JSON) into the cache.
 * Sets expires_at = now + 30 days for each entry.
 */
export async function upsertPlayerStatCacheRaw(
	results: Array<{
		player_id: number;
		source?: string | null;
		[key: string]: unknown;
	}>,
): Promise<void> {
	if (results.length === 0) return;

	const now = new Date();
	const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);

	await db
		.insert(playerStatCache)
		.values(
			results.map((r) => ({
				playerId: r.player_id,
				data: r as Record<string, unknown>,
				source: r.source ?? null,
				fetchedAt: now,
				expiresAt,
			})),
		)
		.onConflictDoUpdate({
			target: playerStatCache.playerId,
			set: {
				data: playerStatCache.data,
				source: playerStatCache.source,
				fetchedAt: playerStatCache.fetchedAt,
				expiresAt: playerStatCache.expiresAt,
			},
		});
}
