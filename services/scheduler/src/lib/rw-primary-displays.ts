import {
	RW_DISPLAY_CATEGORIES,
	type RwDisplayBuckets,
} from "@sentinel/schemas";

/**
 * Broadcast throttling for the four primary ranked-war displays.
 *
 * Suppression lives here rather than in the bot because the scheduler is the
 * side that knows whether the roster actually changed. The bot keeps its own
 * render-interval floor as a second line of defence against Discord's
 * per-channel edit budget.
 *
 * The secondary travel display keeps its own independent state — see
 * `rw-traveling-displays.ts`. Sharing it would let a traveling-only change be
 * suppressed as "unchanged", because travelers populate none of these buckets.
 */

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
