import {
	type RwOpponentLine,
	type RwTravelingBuckets,
	TORN_TRAVEL_DESTINATIONS,
	type TravelDestination,
} from "@sentinel/schemas";
import type { RankedWarOpponent } from "../workers/subversive/ranked-war-worker";

/**
 * Groups the airborne slice of an opposing roster by flight destination.
 *
 * Torn reports a traveling member's route as a human sentence rather than
 * structured fields — `status.description` is `"Traveling from Switzerland to
 * Torn"` and `status.until` is null for every traveler — so the destination has
 * to be recovered from the sentence.
 *
 * Reads as `from <origin> to <destination>`: the destination is the trailing
 * clause. `"Traveling from Switzerland to Torn"` is a player flying *home*.
 *
 * The matching is strict on purpose. An unrecognised destination is dropped
 * rather than rendered, so a new Torn country can never leak into the embed as
 * an unselectable field.
 */

const DESTINATION_SET: ReadonlySet<string> = new Set(TORN_TRAVEL_DESTINATIONS);

/** Torn status state that means the player is airborne. */
const STATE_TRAVELING = "Traveling";

/** Prefix Torn puts in front of the route, e.g. "Traveling from A to B". */
const DESCRIPTION_PREFIX = "Traveling from ";

/**
 * Extracts the flight destination from a Torn status description.
 *
 * Returns null for anything that is not a recognisable route, including
 * descriptions belonging to other states.
 *
 * The split uses the **last** `" to "` because no destination name contains
 * that substring, which makes the trailing clause unambiguous.
 */
export function parseTravelDestination(
	description: string | null | undefined,
): TravelDestination | null {
	if (!description) return null;
	if (!description.startsWith(DESCRIPTION_PREFIX)) return null;

	const separator = description.lastIndexOf(" to ");
	if (separator <= DESCRIPTION_PREFIX.length - 1) return null;

	const candidate = description.slice(separator + " to ".length).trim();

	if (!DESTINATION_SET.has(candidate)) return null;
	return candidate as TravelDestination;
}

function toLine(opponent: RankedWarOpponent): RwOpponentLine {
	return {
		id: opponent.id,
		name: opponent.name,
		estimatedBs: opponent.estimatedBs,
		lastSeenAt: opponent.lastAction?.timestamp ?? 0,
		hospitalUntil: null,
	};
}

/**
 * Buckets airborne opponents by destination.
 *
 * Ordering is player count descending then destination name, so the busiest
 * destination leads both the embed fields and the select menu. Players within
 * a destination are ordered by battle stat descending — the largest targets are
 * the ones worth knowing about first.
 *
 * Never mutates the input array.
 */
export function classifyTravelingOpponents(
	opponents: RankedWarOpponent[],
): RwTravelingBuckets {
	const grouped = new Map<TravelDestination, RwOpponentLine[]>();

	for (const opponent of opponents) {
		if (opponent.status?.state !== STATE_TRAVELING) continue;

		const destination = parseTravelDestination(opponent.status?.description);
		// A traveler with an unrecognised route is still traveling, but there is
		// no bucket to file them under, so they are omitted entirely.
		if (!destination) continue;

		const bucket = grouped.get(destination);
		if (bucket) {
			bucket.push(toLine(opponent));
		} else {
			grouped.set(destination, [toLine(opponent)]);
		}
	}

	return [...grouped.entries()]
		.map(([destination, players]) => ({
			destination,
			players: [...players].sort((a, b) => b.estimatedBs - a.estimatedBs),
		}))
		.sort(
			(a, b) =>
				b.players.length - a.players.length ||
				a.destination.localeCompare(b.destination),
		);
}

/**
 * A stable string describing the travel buckets, used to suppress redundant
 * broadcasts.
 *
 * Counts alone are not enough: players land and leave constantly, so two
 * destinations holding the same number of travelers are not interchangeable.
 */
export function buildTravelingSignature(
	destinations: RwTravelingBuckets,
): string {
	return destinations
		.map(
			({ destination, players }) =>
				`${destination}:${players
					.map((p) => `${p.id}@${p.estimatedBs}`)
					.sort()
					.join(",")}`,
		)
		.join("|");
}
