import type { RwFriendlyLine } from "@sentinel/schemas";

/**
 * Broadcast throttling for the friendly (own revives) display.
 *
 * Mirrors `rw-traveling-displays.ts` and keeps entirely separate state. The
 * three ranked-war payloads are throttled independently because the data behind
 * them changes independently — a teammate falling into hospital moves nothing
 * on the opponent board, so sharing a signature map would let the friendly
 * update be suppressed as "unchanged".
 */

/** Shortest gap between two broadcasts for one faction. */
export const FRIENDLY_BROADCAST_MIN_INTERVAL_MS = 5_000;

/** Re-send even when unchanged, so a bot restart mid-war repaints. */
export const FRIENDLY_BROADCAST_HEARTBEAT_MS = 30_000;

interface LastFriendlySent {
	signature: string;
	lastSentAtMs: number;
}

const lastSentByFaction = new Map<number, LastFriendlySent>();

/**
 * Stable fingerprint of a friendly roster.
 *
 * Covers every field the embed renders, so an unchanged signature guarantees an
 * unchanged board. Ordering is included deliberately: the embed reorders too,
 * so a reorder is a real change worth repainting.
 */
export function buildFriendlySignature(members: RwFriendlyLine[]): string {
	return members
		.map((m) => `${m.id}.${m.lastSeenAt}.${m.hospitalUntil ?? 0}`)
		.join(",");
}

/** Test seam: clears all friendly broadcast suppression state. */
export function resetRwFriendlyBroadcastState(): void {
	lastSentByFaction.clear();
}

/**
 * Decides whether a friendly payload is worth pushing, then records it.
 *
 * Returns true when the roster changed and the minimum interval has elapsed, or
 * when the heartbeat has expired.
 */
export function shouldBroadcastRwFriendly(
	factionId: number,
	members: RwFriendlyLine[],
	nowMs: number,
): boolean {
	const signature = buildFriendlySignature(members);
	const prev = lastSentByFaction.get(factionId);

	if (!prev) {
		lastSentByFaction.set(factionId, { signature, lastSentAtMs: nowMs });
		return true;
	}

	const changed = signature !== prev.signature;
	const stale = nowMs - prev.lastSentAtMs >= FRIENDLY_BROADCAST_HEARTBEAT_MS;
	const elapsed =
		nowMs - prev.lastSentAtMs >= FRIENDLY_BROADCAST_MIN_INTERVAL_MS;

	if (!elapsed) return false;
	if (!changed && !stale) return false;

	lastSentByFaction.set(factionId, { signature, lastSentAtMs: nowMs });
	return true;
}

/**
 * Whether this faction has previously had a friendly render broadcast.
 *
 * Gates the war-ended teardown: a faction that never rendered has nothing to
 * delete, so emitting would be pure noise on every idle cycle.
 */
export function hasRwFriendlyBroadcastState(factionId: number): boolean {
	return lastSentByFaction.has(factionId);
}

/**
 * Forgets a faction's friendly suppression state after a teardown has been
 * sent, so the next war's first push is never suppressed as "unchanged".
 */
export function clearRwFriendlyBroadcastState(factionId: number): void {
	lastSentByFaction.delete(factionId);
}
