import type { RwFriendlyLine } from "@sentinel/schemas";

/**
 * Pure classification of a family faction's **own** roster into the friendly
 * revive list.
 *
 * The mirror image of `rw-opponent-buckets.ts`: same trimmed line shape, same
 * "the API number and the embed must agree" rule, but resolved for teammates
 * instead of targets. No IO and no clock reads beyond the injected `nowSec`, so
 * the whole module is unit-testable.
 */

/** Torn's `UserStatusStateEnum` value for a player currently in hospital. */
const STATE_HOSPITAL = "Hospital";
/** Torn's `UserStatusStateEnum` value for a dead account. */
const STATE_FALLEN = "Fallen";

/**
 * `revive_setting` values that grant faction members permission to revive.
 *
 * Torn's enum is `Everyone` | `Friends & faction` | `No one` | `Unknown`, where
 * only the first two allow a factionmate to revive. Kept as an explicit
 * allow-list so a new or renamed value fails closed — listing a member who
 * cannot actually be revived sends a reviver on a wasted trip.
 */
const REVIVE_ALLOWED_SETTINGS = new Set(["Everyone", "Friends & faction"]);

/** `revive_setting` value for a member who has explicitly opted out. */
const REVIVE_SETTING_NONE = "No one";

/**
 * The slice of one own-faction member this classification reads.
 *
 * Structural rather than a named dependency so the raw `/faction/{id}/members`
 * response can be passed straight in.
 */
export interface FriendlyRosterMember {
	id: number;
	name: string;
	/**
	 * Torn's standing "this player allows revives" permission flag. Populated
	 * for every faction, unlike `reviveSetting`.
	 */
	isRevivable: boolean;
	/**
	 * The member's revive opt-in preference. Torn only populates this when the
	 * API key belongs to the faction being read, so it reads "Unknown" for a
	 * whole roster when the key pool hands out a key from the sibling family
	 * faction — which is why the flag above is the primary signal.
	 */
	reviveSetting: string;
	lastAction?: { timestamp?: number | null } | null;
	status?: { state?: string | null; until?: number | null } | null;
}

/**
 * Whether one of our own members belongs on the friendly revive board.
 *
 * Membership is the standing permission flag, not a live Hospital state: the
 * same rule the opponent `revivable` bucket uses, so the two boards agree on
 * what "revivable" means. Requiring a Hospital status would empty the board
 * whenever nobody happened to be down, which reads as a broken embed.
 *
 * `revive_setting` can only refine that flag, never contradict it into a
 * listing: an explicit "No one" opts the member out even if the flag is stale,
 * and a key from the sibling faction leaving the setting "Unknown" falls back
 * to the flag alone. `Fallen` accounts are excluded everywhere — they can never
 * enter hospital for a revive.
 */
export function isFriendlyRevivable(member: FriendlyRosterMember): boolean {
	if (member.status?.state === STATE_FALLEN) return false;
	if (member.reviveSetting === REVIVE_SETTING_NONE) return false;
	return (
		member.isRevivable || REVIVE_ALLOWED_SETTINGS.has(member.reviveSetting)
	);
}

/**
 * Trims one own member into the projection the embed renders.
 *
 * `until` is normalised twice over, exactly as the opponent classifier does it:
 * it is only meaningful on a Hospital state, and Torn keeps reporting that state
 * for a moment after the timer has elapsed. A member whose timer is already in
 * the past is out, so showing them as downed would send a reviver to a bed they
 * have already left.
 */
function toLine(member: FriendlyRosterMember, nowSec: number): RwFriendlyLine {
	const until =
		member.status?.state === STATE_HOSPITAL
			? (member.status?.until ?? null)
			: null;

	return {
		id: member.id,
		name: member.name,
		lastSeenAt: member.lastAction?.timestamp ?? 0,
		hospitalUntil: until !== null && until > nowSec ? until : null,
	};
}

/**
 * Builds the friendly revive list: our own members who allow revives, ordered
 * for action.
 *
 * Downed members lead, soonest hospital exit first — they are the revives that
 * can be performed right now — and everyone else follows most recently active
 * first, so the revivers can see who is around. Ties break on name so the order
 * is stable rather than dependent on API response order.
 *
 * @param members Own faction roster from `/faction/{id}/members`.
 * @param nowSec  Current unix time in **seconds**; Torn's timestamps are
 *                seconds too, so mixing the two would silently misclassify.
 */
export function classifyFriendlyRevivables(
	members: readonly FriendlyRosterMember[],
	nowSec: number,
): RwFriendlyLine[] {
	const revivable = members
		.filter(isFriendlyRevivable)
		.map((member) => toLine(member, nowSec));

	const downed = revivable.filter((line) => line.hospitalUntil !== null);
	const others = revivable.filter((line) => line.hospitalUntil === null);

	const byName = (a: RwFriendlyLine, b: RwFriendlyLine) =>
		a.name.localeCompare(b.name, undefined, {
			sensitivity: "base",
			numeric: true,
		});

	downed.sort((a, b) => {
		const delta =
			(a.hospitalUntil ?? Number.MAX_SAFE_INTEGER) -
			(b.hospitalUntil ?? Number.MAX_SAFE_INTEGER);
		return delta !== 0 ? delta : byName(a, b);
	});

	others.sort((a, b) => {
		const delta = b.lastSeenAt - a.lastSeenAt;
		return delta !== 0 ? delta : byName(a, b);
	});

	return [...downed, ...others];
}
