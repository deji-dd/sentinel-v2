import {
	type RwTravelingBuckets,
	type RwTravelKind,
	type RwTravelLine,
	TORN_TRAVEL_DESTINATIONS,
	type TravelDestination,
} from "@sentinel/schemas";
import type { RankedWarOpponent } from "../workers/subversive/ranked-war-worker";

/**
 * Groups the "outside Torn" slice of an opposing roster by where the players
 * are: airborne and inbound, landed and free, or downed in a hospital abroad.
 *
 * Torn gives the location as a human sentence rather than structured fields, so
 * the destination has to be recovered from `status.description`. Three shapes
 * are handled, one per state that puts a player outside Torn:
 *
 *   Traveling  "Traveling from Switzerland to Torn"  → the trailing clause
 *   Abroad     "In Japan"                            → the whole remainder
 *   Hospital   "In a Japanese hospital for 24 mins"  → the nationality
 *
 * The last one is the awkward case: Torn reports a hospital stay abroad with the
 * same `Hospital` state and the same `until` timer as one inside Torn, and names
 * the hospital after the *nation* ("In a Japanese hospital"), never the country
 * ("In a Japan hospital"). So only a nationality adjective can place it, and
 * only a table of those adjectives can turn it back into a country.
 *
 * The matching is strict on purpose. An unrecognised destination, or an
 * overseas hospital whose nationality is not in the table, is dropped rather
 * than rendered, so a new Torn country can never leak into the embed as an
 * unselectable field.
 */

const DESTINATION_SET: ReadonlySet<string> = new Set(TORN_TRAVEL_DESTINATIONS);

/** The city itself, which no landed player can be sitting in. */
const TORN_DESTINATION: TravelDestination = "Torn";

/** Torn status state that means the player is airborne. */
const STATE_TRAVELING = "Traveling";

/** Torn status state that means the player has landed in another country. */
const STATE_ABROAD = "Abroad";

/**
 * Torn status state that means the player is downed. Shared by a hospital in
 * Torn and one overseas, which is exactly why the description has to be read.
 */
const STATE_HOSPITAL = "Hospital";

/** Prefix Torn puts in front of the route, e.g. "Traveling from A to B". */
const DESCRIPTION_PREFIX = "Traveling from ";

/** Prefix Torn puts in front of an abroad country, e.g. "In Japan". */
const ABROAD_PREFIX = /^in\s+/i;

/**
 * A hospital stay overseas, e.g. "In a Japanese hospital for 24 mins". The
 * article is what separates it from the domestic "In hospital for 3 hrs 12
 * mins", which names no nation at all.
 */
const OVERSEAS_HOSPITAL_DESCRIPTION = /^in an? (.+?) hospital\b/i;

/**
 * Nationality adjectives Torn uses for an overseas hospital, mapped back to the
 * country they name.
 *
 * Japan, UAE and Switzerland are verified against the live API (see
 * `packages/utils/src/torn-status.ts`); the rest are the standard English
 * adjectives for Torn's country list. An adjective that is neither here nor a
 * country name followed by a suffix is dropped, not guessed.
 */
const HOSPITAL_NATIONALITIES: Readonly<Record<string, TravelDestination>> = {
	japanese: "Japan",
	emirati: "UAE",
	swiss: "Switzerland",
	mexican: "Mexico",
	hawaiian: "Hawaii",
	"south african": "South Africa",
	chinese: "China",
	argentine: "Argentina",
	argentinian: "Argentina",
	canadian: "Canada",
	british: "United Kingdom",
	caymanian: "Cayman Islands",
};

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

/**
 * Extracts the country a landed player is sitting in from a Torn status
 * description.
 *
 * Torn writes `"In Japan"`. The `"In "` prefix is optional here rather than
 * required — the country still has to match Torn's list exactly, so a rewording
 * that drops the prefix keeps working while an unrelated sentence still cannot
 * be mistaken for a country. A domestic hospital reads `"In hospital for 25
 * mins"` and fails that exact match, so it stays out.
 *
 * `"Torn"` is rejected even though it is a legitimate *flight* destination: a
 * player reported `Abroad` in Torn is a contradiction, not a country, and
 * rendering it would put them under "Returning to Torn" with an "already there"
 * count.
 */
export function parseAbroadDestination(
	description: string | null | undefined,
): TravelDestination | null {
	if (!description) return null;

	const trimmed = description.trim();
	const candidate = trimmed.replace(ABROAD_PREFIX, "").trim();

	if (!DESTINATION_SET.has(candidate)) return null;
	if (candidate === TORN_DESTINATION) return null;
	return candidate as TravelDestination;
}

/**
 * Extracts the country of an overseas hospital stay from a Torn status
 * description, or null when the stay is inside Torn or cannot be placed.
 *
 * A domestic stay ("In hospital for 3 hrs 12 mins") has no nationality and is
 * never matched, which is what keeps members downed inside Torn out of a board
 * whose whole point is where opponents are *outside* Torn.
 */
export function parseOverseasHospitalDestination(
	description: string | null | undefined,
): TravelDestination | null {
	if (!description) return null;

	const match = OVERSEAS_HOSPITAL_DESCRIPTION.exec(description.trim());
	const nationality = match?.[1]?.trim().toLowerCase();
	if (!nationality) return null;

	const known = HOSPITAL_NATIONALITIES[nationality];
	if (known) return known;

	// Adjectives that carry the country name as a prefix ("South African" →
	// "South Africa"), which the table above cannot be trusted to enumerate.
	for (const destination of TORN_TRAVEL_DESTINATIONS) {
		if (nationality.startsWith(destination.toLowerCase())) return destination;
	}

	return null;
}

interface ClassifiedOpponent {
	destination: TravelDestination;
	kind: RwTravelKind;
}

/**
 * Places one opponent on the board, or returns null when Torn's wording cannot
 * be resolved to a country.
 *
 * Only these three states put a player outside Torn, and each resolves its
 * destination differently, so the state decides which parser runs.
 */
function classifyOpponent(
	opponent: RankedWarOpponent,
): ClassifiedOpponent | null {
	const state = opponent.status?.state;
	const description = opponent.status?.description;

	if (state === STATE_TRAVELING) {
		const destination = parseTravelDestination(description);
		return destination ? { destination, kind: "traveling" } : null;
	}

	if (state === STATE_ABROAD) {
		const destination = parseAbroadDestination(description);
		return destination ? { destination, kind: "abroad" } : null;
	}

	if (state === STATE_HOSPITAL) {
		const destination = parseOverseasHospitalDestination(description);
		return destination ? { destination, kind: "hospitalAbroad" } : null;
	}

	return null;
}

function toLine(opponent: RankedWarOpponent, kind: RwTravelKind): RwTravelLine {
	return {
		id: opponent.id,
		name: opponent.name,
		estimatedBs: opponent.estimatedBs,
		lastSeenAt: opponent.lastAction?.timestamp ?? 0,
		// Only an overseas hospital stay carries a timer: Torn reports `until`
		// as null for a landed player and for an airborne one.
		hospitalUntil:
			kind === "hospitalAbroad" ? (opponent.status?.until ?? null) : null,
		kind,
	};
}

/**
 * Buckets opponents outside Torn by destination.
 *
 * Every kind of away opponent lands in the same bucket for a country — inbound
 * and already-there are two headings on one board, not two boards — with the
 * per-player `kind` left for the renderer to distinguish them.
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
	const grouped = new Map<TravelDestination, RwTravelLine[]>();

	for (const opponent of opponents) {
		const classified = classifyOpponent(opponent);
		// An away player whose location cannot be resolved still exists, but
		// there is no bucket to file them under, so they are omitted entirely.
		if (!classified) continue;

		const line = toLine(opponent, classified.kind);
		const bucket = grouped.get(classified.destination);
		if (bucket) {
			bucket.push(line);
		} else {
			grouped.set(classified.destination, [line]);
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
 * The kind is part of the fingerprint because a player landing in the country
 * they were flying to moves nothing else, and the hospital timer is part of it
 * because it is rendered and can be extended by a fresh hit.
 */
export function buildTravelingSignature(
	destinations: RwTravelingBuckets,
): string {
	return destinations
		.map(
			({ destination, players }) =>
				`${destination}:${players
					.map(
						(p) => `${p.id}@${p.estimatedBs}@${p.kind}@${p.hospitalUntil ?? 0}`,
					)
					.sort()
					.join(",")}`,
		)
		.join("|");
}
