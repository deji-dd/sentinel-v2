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
	lastClassifiedByFaction.clear();
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

/** Minimal shape needed to fingerprint a roster without classifying it. */
export type FingerprintableOpponent = {
	id: number;
	estimatedBs?: number | null;
	status?: { state?: string | null; until?: number | null } | null;
	lastAction?: { status?: string | null; timestamp?: number | null } | null;
};

/**
 * Cheap fingerprint of an opponent roster.
 *
 * Deliberately computed straight from the raw roster so it can be compared
 * *before* the expensive classification pass (five array copies and sorts per
 * faction per tick). It covers every field the buckets are derived from, so an
 * unchanged fingerprint guarantees an unchanged bucket set; it may occasionally
 * over-report (a field that does not affect buckets changing), which costs one
 * redundant classify rather than a missed update.
 */
export function buildOpponentFingerprint(
	opponents: readonly FingerprintableOpponent[],
): string {
	const parts: string[] = [];
	for (const o of opponents) {
		parts.push(
			`${o.id}.${o.estimatedBs ?? 0}.${o.status?.state ?? ""}.${o.status?.until ?? 0}.${o.lastAction?.status ?? ""}.${o.lastAction?.timestamp ?? 0}`,
		);
	}
	return parts.join(",");
}

interface RwReclassifyState {
	fingerprint: string;
	lastClassifiedAtMs: number;
}

const lastClassifiedByFaction = new Map<number, RwReclassifyState>();

/**
 * Whether the roster needs re-classifying this tick.
 *
 * Classification is the expensive half of the display path and its result is
 * usually discarded by `shouldBroadcastRwDisplays`, so gate it on a roster
 * fingerprint first. The heartbeat keeps the bucket signature fresh even on a
 * static roster, which is what `shouldBroadcastRwDisplays` needs to decide
 * whether to re-send.
 */
export function shouldReclassifyRwDisplays(
	factionId: number,
	fingerprint: string,
	nowMs: number,
): boolean {
	const prev = lastClassifiedByFaction.get(factionId);
	if (!prev) {
		lastClassifiedByFaction.set(factionId, {
			fingerprint,
			lastClassifiedAtMs: nowMs,
		});
		return true;
	}

	const changed = fingerprint !== prev.fingerprint;
	const stale = nowMs - prev.lastClassifiedAtMs >= BROADCAST_HEARTBEAT_MS;
	if (!changed && !stale) return false;

	lastClassifiedByFaction.set(factionId, {
		fingerprint,
		lastClassifiedAtMs: nowMs,
	});
	return true;
}

/**
 * Forgets a faction's broadcast state. Called after a war-ended teardown has
 * been broadcast, so the next war starts with a guaranteed first push rather
 * than being suppressed as "unchanged".
 */
export function clearRwDisplaysBroadcastState(factionId: number): void {
	lastSentByFaction.delete(factionId);
}
