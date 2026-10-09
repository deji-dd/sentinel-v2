/**
 * Torn user-status classification.
 *
 * A player hospitalised *outside* Torn keeps `state: "Hospital"` in every
 * roster Torn returns — only the wording of `status.description` says where the
 * hospital is, because Torn names it after the nation:
 *
 *   in Torn        "In hospital for 3 hrs 12 mins"
 *   overseas       "In a Japanese hospital for 24 mins"
 *                  "In an Emirati hospital for 34 mins"
 *                  "In a Swiss hospital for 41 mins"
 *
 * Verified against the live `/faction/{id}/members` roster (70 factions,
 * 5,509 members, 344 hospitalised): 329 read "In hospital for <duration>" and
 * 15 read "In a[n] <nationality> hospital for <duration>". `status.until`,
 * `status.color` and `status.details` are identical for both, so the
 * description is the only field that can tell a Torn hospital from a foreign
 * one.
 *
 * Traveling and Abroad members carry their own states and never a hospital
 * description, so a status check on `state` alone already excludes anyone who
 * is airborne or already overseas.
 */

/** Torn's `UserStatusStateEnum` value for a player free of any status. */
export const TORN_STATE_OKAY = "Okay";

/** Torn's `UserStatusStateEnum` value for a player currently in hospital. */
export const TORN_STATE_HOSPITAL = "Hospital";

/** Torn's `UserStatusStateEnum` value for a player currently airborne. */
export const TORN_STATE_TRAVELING = "Traveling";

/** Torn's `UserStatusStateEnum` value for a player already in another country. */
export const TORN_STATE_ABROAD = "Abroad";

/**
 * The fields needed to place a player, so both a full Torn `UserStatus` and the
 * trimmed status carried by the ranked-war IPC payload can be classified.
 */
export interface TornStatusLike {
	state?: string | null;
	description?: string | null;
}

/**
 * A hospital stay abroad, e.g. "In a Japanese hospital for 24 mins" or
 * "In an Emirati hospital for 34 mins": Torn always gives a foreign hospital
 * its nationality, so every observed overseas stay carries an article.
 *
 * Deliberately a deny-list rather than an allow-list on the Torn wording. This
 * pattern only ever removes a stay Torn has positively placed overseas, so a
 * rewording of the domestic phrase degrades to "we still post callouts" instead
 * of silently emptying the dibs board.
 */
const OVERSEAS_HOSPITAL_DESCRIPTION = /^in an? .* hospital/i;

/**
 * Whether a Torn status describes a player in a hospital our members can reach
 * without flying — i.e. a hospital inside Torn.
 *
 * Returns false for:
 * - any state other than Hospital (Okay, Traveling, Abroad, Jail, Federal,
 *   Fallen), including members who are airborne or already overseas;
 * - a Hospital state whose description places the hospital abroad.
 */
export function isInTornHospital(
	status: TornStatusLike | null | undefined,
): boolean {
	if (!isHospitalStatus(status)) return false;

	const description = status?.description?.trim() ?? "";
	return !OVERSEAS_HOSPITAL_DESCRIPTION.test(description);
}

/**
 * Whether Torn reports the player as hospitalised at all, wherever the hospital
 * is. Used to decide whether a hospital timer is meaningful — both a stay in
 * Torn and one abroad carry a real `until` — while `isInTornHospital` answers
 * the different question of whether a member can act on it.
 */
export function isHospitalStatus(
	status: TornStatusLike | null | undefined,
): boolean {
	return (
		status?.state?.trim().toLowerCase() === TORN_STATE_HOSPITAL.toLowerCase()
	);
}

/**
 * Whether a member in this status can be attacked from Torn without flying.
 *
 * Only a player standing free in Torn is attackable: `Hospital` (anywhere,
 * including overseas), `Traveling`, `Abroad`, `Jail`, `Federal` and `Fallen`
 * are all states a member cannot reach from Torn. The target-finder ready pool
 * uses this as its whole availability rule — a row whose last known state is
 * not attackable must never be offered as a farm target.
 */
export function isAttackableInTorn(
	status: TornStatusLike | null | undefined,
): boolean {
	return status?.state?.toLowerCase() === TORN_STATE_OKAY.toLowerCase();
}

/**
 * Torn's state lowercased, for the target pool's `status` column: `"okay"`,
 * `"hospital"`, `"traveling"`, `"abroad"`, and `"other"` when Torn reported no
 * usable state at all. Recording the real state is what lets the pool tell a
 * hospital stay (which expires on its own) from an unavailability that has no
 * timer and therefore has to be re-checked.
 */
export function tornStateSlug(
	status: TornStatusLike | null | undefined,
): string {
	return status?.state?.trim().toLowerCase() || "other";
}
