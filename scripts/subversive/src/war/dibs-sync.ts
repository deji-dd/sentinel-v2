import type { DibsItem } from "../types";

/**
 * Replaces a local dibs map with the board the API just sent.
 *
 * Dibs are authoritative on the server: a claim is released when the lock timer
 * expires, dropped when the target is downed, and cleared when the war ends. The
 * panel's map used to be append-only, so a claim the server had already released
 * kept rendering as "Claimed (You)" / "Claimed: <name>" until a page reload —
 * which is what made the panel disagree with the Discord callouts.
 *
 * Kept free of DOM and state imports so the rule can be tested directly.
 */
export function syncDibsFromServer(
	current: Map<number, DibsItem>,
	dibs: DibsItem[],
): void {
	const seen = new Set<number>();

	for (const incoming of dibs) {
		if (typeof incoming?.targetId !== "number") continue;
		seen.add(incoming.targetId);
		current.set(incoming.targetId, incoming);
	}

	// Anything the server no longer lists is gone: released, downed, or its war
	// has ended.
	for (const targetId of [...current.keys()]) {
		if (!seen.has(targetId)) current.delete(targetId);
	}
}
