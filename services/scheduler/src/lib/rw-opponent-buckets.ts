import type { RwDisplayBuckets, RwOpponentLine } from "@sentinel/schemas";
import type { RankedWarOpponent } from "../workers/subversive/ranked-war-worker";

/**
 * Pure classification of a ranked-war opposing roster into the four
 * primary-display buckets.
 *
 * No IO and no clock reads beyond the injected `nowSec`, so the whole module is
 * exhaustively unit-testable.
 */

/** Torn's `UserStatusStateEnum` value for a player currently in hospital. */
const STATE_HOSPITAL = "Hospital";
/** Torn's `UserStatusStateEnum` value for a player free of any status. */
const STATE_OKAY = "Okay";
/** Torn's `UserLastActionStatusEnum` values. */
const ACTION_ONLINE = "Online";
const ACTION_OFFLINE = "Offline";

/**
 * Trims a full opponent into the projection the embeds render.
 */
function toLine(opponent: RankedWarOpponent): RwOpponentLine {
	return {
		id: opponent.id,
		name: opponent.name,
		estimatedBs: opponent.estimatedBs,
		lastSeenAt: opponent.lastAction?.timestamp ?? 0,
		// `until` is only ever populated by Torn for Hospital/Jail states, but
		// normalising it here keeps a surprise value from reaching the renderer.
		hospitalUntil:
			opponent.status?.state === STATE_HOSPITAL
				? (opponent.status?.until ?? null)
				: null,
	};
}

/**
 * Whether a player is currently in hospital with time left on the clock.
 *
 * `until` is unix seconds. A player whose timer has already elapsed is no
 * longer a departure target even if Torn still reports the Hospital state.
 */
function isLeavingHospital(
	opponent: RankedWarOpponent,
	nowSec: number,
): boolean {
	if (opponent.status?.state !== STATE_HOSPITAL) return false;
	const until = opponent.status?.until ?? null;
	return until !== null && until > nowSec;
}

/**
 * Whether a player is free and clear — neither downed, jailed, travelling,
 * fallen, nor abroad. Only these players are actionable targets.
 */
function isOkay(opponent: RankedWarOpponent): boolean {
	return opponent.status?.state === STATE_OKAY;
}

/**
 * Sorts by a numeric key descending, breaking ties on name so the ordering is
 * stable and readable rather than dependent on API response order.
 */
function byDesc<T extends { name: string }>(
	items: T[],
	key: (item: T) => number,
): T[] {
	return [...items].sort((a, b) => {
		const delta = key(b) - key(a);
		if (delta !== 0) return delta;
		return a.name.localeCompare(b.name, undefined, {
			sensitivity: "base",
			numeric: true,
		});
	});
}

/** Sorts ascending by a numeric key, same tie-breaking as `byDesc`. */
function byAsc<T extends { name: string }>(
	items: T[],
	key: (item: T) => number,
): T[] {
	return [...items].sort((a, b) => {
		const delta = key(a) - key(b);
		if (delta !== 0) return delta;
		return a.name.localeCompare(b.name, undefined, {
			sensitivity: "base",
			numeric: true,
		});
	});
}

/**
 * Classifies an opposing roster into the four ranked-war display buckets.
 *
 * @param opponents Opposing faction roster from `/faction/{id}/members`.
 * @param nowSec   Current unix time in **seconds**; Torn's timestamps are
 *                 seconds too, so mixing the two would silently misclassify.
 *
 * Notes on the semantics, each verified against the live Torn API:
 *
 * - Buckets are intentionally **not** disjoint. A player in hospital who
 *   allows revives appears in both `hospital` and `revivable`, because both are
 *   actionable views of the same opportunity.
 * - `revivable` is **not** `is_revivable` alone. Torn's `is_revivable` is a
 *   standing permission flag meaning "this player allows revives"; on a real
 *   99-member opposing roster 40 members carried it while only one was in
 *   hospital and none overlapped. Treating the flag alone as "revivable"
 *   would list 40 healthy players as downed. The genuine predicate is the flag
 *   **and** a live hospital timer.
 * - `Fallen` players are excluded everywhere. They carry a null `until`, and
 *   their last-seen timestamps run back years (one sampled at 2070 days), so
 *   any "recently seen" ordering would be meaningless for them.
 */
export function classifyOpponentsIntoRwBuckets(
	opponents: RankedWarOpponent[],
	nowSec: number,
): RwDisplayBuckets {
	const hospital: RwOpponentLine[] = [];
	const offlineOkay: RwOpponentLine[] = [];
	const onlineOkay: RwOpponentLine[] = [];
	const revivable: RwOpponentLine[] = [];

	for (const opponent of opponents) {
		const leavingHospital = isLeavingHospital(opponent, nowSec);

		if (leavingHospital) {
			const line = toLine(opponent);
			hospital.push(line);
			// Only players who allow revives are actionable while down.
			if (opponent.isRevivable) {
				revivable.push(line);
			}
		} else if (isOkay(opponent)) {
			const line = toLine(opponent);
			const action = opponent.lastAction?.status;
			if (action === ACTION_ONLINE) {
				onlineOkay.push(line);
			} else if (action === ACTION_OFFLINE) {
				offlineOkay.push(line);
			}
			// Idle players are neither online nor offline to an operator, so
			// they are intentionally absent from both buckets.
		}
	}

	return {
		// Soonest departure first: that is the actionable end of the window.
		hospital: byAsc(
			hospital,
			(l) => l.hospitalUntil ?? Number.MAX_SAFE_INTEGER,
		),
		// Most recently seen first, so the freshest offline targets lead.
		offlineOkay: byDesc(offlineOkay, (l) => l.lastSeenAt),
		// Biggest targets first for the online list.
		onlineOkay: byDesc(onlineOkay, (l) => l.estimatedBs),
		// Same window as `hospital`, so the same ordering.
		revivable: byAsc(
			revivable,
			(l) => l.hospitalUntil ?? Number.MAX_SAFE_INTEGER,
		),
	};
}
