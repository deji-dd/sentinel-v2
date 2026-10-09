import type { RwDisplayBuckets, RwOpponentLine } from "@sentinel/schemas";
import { isInTornHospital } from "@sentinel/utils";
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
/** Torn's `UserStatusStateEnum` value for a dead account. */
const STATE_FALLEN = "Fallen";
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
 *
 * The stay must also be inside Torn: Torn reports a member hospitalised abroad
 * with the same Hospital state, and only the description says where. Those
 * opponents cannot be attacked without flying, so they do not belong in a
 * bucket a member reads as "hit this when the timer runs out".
 */
function isLeavingHospital(
	opponent: RankedWarOpponent,
	nowSec: number,
): boolean {
	if (!isInTornHospital(opponent.status)) return false;
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
 * Whether the account is dead.
 *
 * `Fallen` opponents are excluded from every bucket even when they carry the
 * revive flag: a dead account can never enter hospital for a revive, and Torn
 * reports no usable timestamps for them.
 */
function isFallen(opponent: RankedWarOpponent): boolean {
	return opponent.status?.state === STATE_FALLEN;
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
 * - `hospital` requires a live timer: Torn keeps reporting the Hospital state
 *   for a moment after `until` has elapsed, and a player already out is not a
 *   departure target.
 * - `revivable` mirrors Torn's `is_revivable` flag itself, **not** the flag
 *   filtered by a Hospital status. `is_revivable` is a standing permission
 *   ("this player allows revives"), confirmed against the key's own faction
 *   where it is true for exactly the members whose `revive_setting` is
 *   "Everyone" or "Friends & faction" and false for every "No one" member.
 *   Requiring a Hospital status on top of it emptied the bucket whenever no
 *   flagged opponent happened to be down — a live roster reported 41 flagged
 *   members while the embed claimed 0, which reads as a broken embed rather
 *   than as a lull in revivable targets. The API number and the embed must
 *   agree, so the flag alone decides membership.
 * - `revivable` stays ordered for action: downed opponents first (soonest
 *   hospital exit, matching `hospital`), then everyone else most recently
 *   active first.
 * - `Fallen` players are excluded everywhere, including from `revivable` even
 *   when flagged. They carry a null `until`, and their last-seen timestamps run
 *   back years (one sampled at 2070 days), so any "recently seen" ordering
 *   would be meaningless for them.
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
			hospital.push(toLine(opponent));
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

		// Independent of the buckets above: membership here is the permission
		// flag alone, so a flagged opponent appears whether they are down, okay,
		// travelling or abroad.
		if (opponent.isRevivable && !isFallen(opponent)) {
			revivable.push(toLine(opponent));
		}
	}

	const downed = revivable.filter((line) => line.hospitalUntil !== null);
	const others = revivable.filter((line) => line.hospitalUntil === null);

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
		// Downed players lead on the same ordering as `hospital` — they are the
		// immediately actionable revives — and the rest follow most recently
		// active first.
		revivable: [
			...byAsc(downed, (l) => l.hospitalUntil ?? Number.MAX_SAFE_INTEGER),
			...byDesc(others, (l) => l.lastSeenAt),
		],
	};
}
