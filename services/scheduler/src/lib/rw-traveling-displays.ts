import type { RwTravelingBuckets } from "@sentinel/schemas";
import { buildTravelingSignature } from "./rw-traveling-buckets";

/**
 * Broadcast throttling for the secondary travel display.
 *
 * Mirrors `rw-primary-displays.ts` but keeps entirely separate state. The two
 * payloads are throttled independently because the underlying data changes
 * independently: travelers populate none of the four primary buckets, so a
 * flight departing would leave the primary signature byte-identical and be
 * suppressed as "unchanged" if the two shared a map.
 */

/** Shortest gap between two broadcasts for one faction. */
export const TRAVEL_BROADCAST_MIN_INTERVAL_MS = 5_000;

/** Re-send even when unchanged, so a bot restart mid-war repaints. */
export const TRAVEL_BROADCAST_HEARTBEAT_MS = 30_000;

interface LastTravelSent {
	signature: string;
	lastSentAtMs: number;
}

const lastSentByFaction = new Map<number, LastTravelSent>();

/** Test seam: clears all travel broadcast suppression state. */
export function resetRwTravelingBroadcastState(): void {
	lastSentByFaction.clear();
}

/**
 * Decides whether a travel payload is worth pushing, then records it.
 *
 * Returns true when destinations changed and the minimum interval has elapsed,
 * or when the heartbeat has expired.
 */
export function shouldBroadcastRwTraveling(
	factionId: number,
	destinations: RwTravelingBuckets,
	nowMs: number,
): boolean {
	const signature = buildTravelingSignature(destinations);
	const prev = lastSentByFaction.get(factionId);

	if (!prev) {
		lastSentByFaction.set(factionId, { signature, lastSentAtMs: nowMs });
		return true;
	}

	const changed = signature !== prev.signature;
	const stale = nowMs - prev.lastSentAtMs >= TRAVEL_BROADCAST_HEARTBEAT_MS;
	const elapsed = nowMs - prev.lastSentAtMs >= TRAVEL_BROADCAST_MIN_INTERVAL_MS;

	if (!elapsed) return false;
	if (!changed && !stale) return false;

	lastSentByFaction.set(factionId, { signature, lastSentAtMs: nowMs });
	return true;
}

/**
 * Whether this faction has previously had a travel render broadcast.
 *
 * Gates the war-ended teardown: a faction that never rendered has nothing to
 * delete, so emitting would be pure noise on every idle cycle.
 */
export function hasRwTravelingBroadcastState(factionId: number): boolean {
	return lastSentByFaction.has(factionId);
}

/**
 * Forgets a faction's travel suppression state after a teardown has been sent,
 * so the next war's first push is never suppressed as "unchanged".
 */
export function clearRwTravelingBroadcastState(factionId: number): void {
	lastSentByFaction.delete(factionId);
}
