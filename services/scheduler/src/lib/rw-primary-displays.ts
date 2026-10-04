import { db, inArray, subversiveRwChannelConfigs } from "@sentinel/database";
import {
	RW_DISPLAY_CATEGORIES,
	type RwDisplayBuckets,
} from "@sentinel/schemas";
import { Logger } from "@sentinel/utils";

const logger = new Logger("Scheduler", "RwPrimaryDisplays");

/**
 * How long a resolved primary-channel selection is reused before re-reading it.
 *
 * The war cycle ticks every second during an active war, and this table has at
 * most one row per family faction, so re-reading it every tick would be pure
 * waste. Thirty seconds keeps the "admin just deselected the channel" case
 * responsive without adding a second poll to the hot path.
 */
const CHANNEL_CONFIG_TTL_MS = 30_000;

interface CachedChannelConfig {
	channelIdByFaction: Map<number, string | null>;
	loadedAtMs: number;
}

let cachedChannelConfig: CachedChannelConfig | null = null;

/**
 * Reads the primary displays channel for every given faction.
 *
 * A faction with no row at all resolves to `null` (nothing selected), which is
 * a normal state rather than an error: the dashboard simply has not been
 * configured for it yet.
 *
 * A database failure resolves every faction to `null` and is not cached, so the
 * next cycle retries. Degrading to "no channel" is safe because the bot treats
 * it as "tear down", which is preferable to reposting into a channel an admin
 * may have just unselected.
 */
export async function resolvePrimaryDisplayChannels(
	factionIds: number[],
): Promise<Map<number, string | null>> {
	if (factionIds.length === 0) return new Map();

	const now = Date.now();
	if (
		cachedChannelConfig &&
		now - cachedChannelConfig.loadedAtMs < CHANNEL_CONFIG_TTL_MS
	) {
		const out = new Map<number, string | null>();
		for (const factionId of factionIds) {
			out.set(
				factionId,
				cachedChannelConfig.channelIdByFaction.get(factionId) ?? null,
			);
		}
		return out;
	}

	const channelIdByFaction = new Map<number, string | null>();
	try {
		const rows = await db
			.select({
				factionId: subversiveRwChannelConfigs.factionId,
				primaryDisplaysChannelId:
					subversiveRwChannelConfigs.primaryDisplaysChannelId,
			})
			.from(subversiveRwChannelConfigs)
			.where(inArray(subversiveRwChannelConfigs.factionId, factionIds));

		for (const row of rows) {
			// Empty strings are historically possible in this column; the
			// backfill migration normalised them to NULL but the PUT handler does
			// not validate, so treat them as unset rather than as a bad snowflake.
			channelIdByFaction.set(
				row.factionId,
				row.primaryDisplaysChannelId?.trim() || null,
			);
		}
		cachedChannelConfig = { channelIdByFaction, loadedAtMs: now };
	} catch (err) {
		logger.warn("Failed to resolve ranked-war primary display channels:", err);
		// Deliberately not cached, so the next cycle retries the read.
		return new Map(factionIds.map((id) => [id, null]));
	}

	return new Map(
		factionIds.map((id) => [id, channelIdByFaction.get(id) ?? null]),
	);
}

/** Test seam: drops the memoised channel selection. */
export function resetPrimaryDisplayChannelCache(): void {
	cachedChannelConfig = null;
}

/**
 * Builds a stable fingerprint of the four buckets.
 *
 * Used to suppress redundant IPC traffic: the war cycle runs every second
 * during an active war, but the opponent roster only meaningfully changes on
 * the members cache TTL. Folding the counts and per-player identity into the
 * signature means a roster that is merely *reordered* still counts as changed
 * (which is correct — the embeds reorder too), while an identical roster sends
 * nothing.
 */
export function buildBucketSignature(buckets: RwDisplayBuckets): string {
	const parts: string[] = [];
	for (const category of RW_DISPLAY_CATEGORIES) {
		const lines = buckets[category];
		parts.push(
			`${category}:${lines.length}:${lines
				.map(
					(l) =>
						`${l.id}.${l.lastSeenAt}.${l.hospitalUntil ?? 0}.${l.estimatedBs}`,
				)
				.join(",")}`,
		);
	}
	return parts.join("|");
}

export interface RwDisplaysBroadcastState {
	signature: string;
	lastSentAtMs: number;
}

const lastSentByFaction = new Map<number, RwDisplaysBroadcastState>();

/**
 * Minimum gap between two IPC pushes for the same faction when content changed.
 * Discord cannot absorb four message edits per second for long.
 */
const BROADCAST_MIN_INTERVAL_MS = 5_000;

/**
 * Fallback heartbeat so a bot that restarted mid-war still repaints. Without it
 * a bot that missed every push would leave stale embeds up indefinitely.
 */
const BROADCAST_HEARTBEAT_MS = 30_000;

/** Test seam: clears all broadcast suppression state. */
export function resetRwDisplaysBroadcastState(): void {
	lastSentByFaction.clear();
}

/**
 * Decides whether this update is worth pushing, then records it.
 *
 * Returns true when the payload should be broadcast: either the roster changed
 * and the minimum interval has elapsed, or the heartbeat has expired.
 */
export function shouldBroadcastRwDisplays(
	factionId: number,
	buckets: RwDisplayBuckets,
	nowMs: number,
): boolean {
	const signature = buildBucketSignature(buckets);
	const prev = lastSentByFaction.get(factionId);

	if (!prev) {
		lastSentByFaction.set(factionId, { signature, lastSentAtMs: nowMs });
		return true;
	}

	const changed = signature !== prev.signature;
	const stale = nowMs - prev.lastSentAtMs >= BROADCAST_HEARTBEAT_MS;
	const elapsed = nowMs - prev.lastSentAtMs >= BROADCAST_MIN_INTERVAL_MS;

	if (!elapsed) return false;
	if (!changed && !stale) return false;

	lastSentByFaction.set(factionId, { signature, lastSentAtMs: nowMs });
	return true;
}

/**
 * Whether this faction has previously had a render broadcast.
 *
 * Used to decide whether a war-ended teardown is worth sending: a faction that
 * never rendered has nothing to tear down, so emitting would be pure noise.
 */
export function hasRwDisplaysBroadcastState(factionId: number): boolean {
	return lastSentByFaction.has(factionId);
}

/**
 * Forgets a faction's broadcast state. Called after a war-ended teardown has
 * been broadcast, so the next war starts with a guaranteed first push rather
 * than being suppressed as "unchanged".
 */
export function clearRwDisplaysBroadcastState(factionId: number): void {
	lastSentByFaction.delete(factionId);
}
