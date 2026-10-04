/**
 * Ranked-war primary-display contract.
 *
 * When a family faction's primary ranked-war channel is configured, the
 * scheduler resolves that faction's opposing roster into four operator-facing
 * buckets and pushes them to the Discord bot over IPC. This module owns the
 * shared vocabulary: the bucket keys, the trimmed per-player shape the bot
 * renders, and the payload shape itself.
 *
 * Classification lives in the scheduler (`rw-opponent-buckets.ts`) because that
 * is where the fully-populated opponent roster already exists. Only the
 * vocabulary that both sides must agree on lives here.
 */

/** The four persistent embeds rendered into the primary displays channel. */
export const RW_DISPLAY_CATEGORIES = [
	"hospital",
	"offlineOkay",
	"onlineOkay",
	"revivable",
] as const;

export type RwDisplayCategory = (typeof RW_DISPLAY_CATEGORIES)[number];

/**
 * A trimmed projection of an opposing player, carrying only what the embeds
 * render. Keeps the IPC payload small and lets the bot stay a pure renderer.
 */
export interface RwOpponentLine {
	/** Torn player id. */
	id: number;
	name: string;
	/** FFScouter-derived battle stat estimate; 0 when unresolved. */
	estimatedBs: number;
	/**
	 * Unix **seconds** of the player's last recorded action, or 0 when Torn
	 * reported no timestamp. Renders via Discord's `<t:…:R>`.
	 */
	lastSeenAt: number;
	/**
	 * Unix **seconds** the player leaves hospital, or null when not in
	 * hospital. Only populated for `status.state === "Hospital"`.
	 */
	hospitalUntil: number | null;
}

/** All four buckets for one opposing roster. */
export type RwDisplayBuckets = Record<RwDisplayCategory, RwOpponentLine[]>;

/** An empty bucket set, used when a war is not engaged. */
export function emptyRwDisplayBuckets(): RwDisplayBuckets {
	return { hospital: [], offlineOkay: [], onlineOkay: [], revivable: [] };
}

/**
 * Payload pushed to the Discord bot for one family faction.
 *
 * `warState` drives the bot's lifecycle:
 * - `scheduled` / `active` — render the four buckets into `channelId`.
 * - `no_war` — the war ended; delete any rendered messages and clear the
 *   tracked ids. Only emitted to a faction that previously received a render,
 *   so a permanently idle faction never generates traffic.
 *
 * `channelId` is resolved by the scheduler from
 * `subversive_rw_channel_configs.primary_displays_channel_id`. A null value is
 * meaningful and distinct from "no war": it means no primary channel is
 * selected, so the bot must tear down anything it previously rendered rather
 * than posting anything.
 */
export interface RwDisplaysUpdate {
	/** Family faction (2013 / 27312) whose channel these displays belong to. */
	factionId: number;
	/** The opposing faction this roster came from; 0 when `no_war`. */
	opponentFactionId: number;
	/** The opposing faction name; empty when `no_war`. */
	opponentFactionName: string;
	/** Torn ranked war id, or null when the war is scheduled but not yet begun. */
	warId: number | null;
	warState: "no_war" | "scheduled" | "active";
	/** Discord snowflake of the primary displays channel, or null when unset. */
	channelId: string | null;
	buckets: RwDisplayBuckets;
	/** Epoch ms the scheduler produced this payload. */
	updatedAt: number;
}

export type IpcSubversiveRwDisplaysUpdateMessage = {
	action: "subversive_rw_displays_update";
	data: RwDisplaysUpdate;
};

/* ────────────────────────── secondary (travel) display ────────────────────────── */

/**
 * The category key the travel embed's message id is stored under.
 *
 * Lives alongside the four primary categories in
 * `subversive_rw_display_messages`. It is deliberately *not* part of
 * `RW_DISPLAY_CATEGORIES`, so the primary renderer neither reads nor deletes
 * it.
 */
export const RW_TRAVELING_CATEGORY = "traveling";

/**
 * Every destination Torn can report a flight destination as.
 *
 * Mirrors Torn's own `CountryEnum` exactly, in the API's spelling. Note the
 * eleventh entry is `"UAE"`, **not** "United Arab Emirates" — the long form is
 * the human-readable label only, and matching on it would silently drop every
 * UAE traveler.
 *
 * `"Torn"` is the eleventh country plus the city itself: a player with
 * `"Traveling from Switzerland to Torn"` is flying *home*, and is a real,
 * reportable destination rather than something to discard. Excluding it would
 * make the embed claim nobody is flying while the roster plainly shows
 * airborne players.
 */
export const TORN_TRAVEL_DESTINATIONS = [
	"Mexico",
	"Hawaii",
	"South Africa",
	"Japan",
	"China",
	"Argentina",
	"Switzerland",
	"Canada",
	"United Kingdom",
	"UAE",
	"Cayman Islands",
	"Torn",
] as const;

export type TravelDestination = (typeof TORN_TRAVEL_DESTINATIONS)[number];

/** Players currently inbound to one destination. */
export interface RwTravelingDestination {
	destination: TravelDestination;
	players: RwOpponentLine[];
}

/**
 * Destinations with at least one airborne player, ordered by player count
 * descending then destination name.
 *
 * An array rather than a record so the ordering is explicit and survives the
 * IPC round-trip, and so only populated destinations appear — the Discord
 * select menu should list destinations that are actually active.
 */
export type RwTravelingBuckets = RwTravelingDestination[];

/** An empty travel bucket set, used when a war is not engaged. */
export function emptyRwTravelingBuckets(): RwTravelingBuckets {
	return [];
}

/**
 * Label shown for the `Torn` destination.
 *
 * `"Torn"` alone reads as a country in a list of countries; the distinction
 * between "flying to Japan" and "flying home to the city" is the whole point
 * of this display, so it is spelled out in the embed field name.
 */
export const TRAVEL_DESTINATION_LABELS: Record<TravelDestination, string> = {
	...(Object.fromEntries(TORN_TRAVEL_DESTINATIONS.map((d) => [d, d])) as Record<
		TravelDestination,
		string
	>),
	Torn: "Returning to Torn",
};

/**
 * Payload for the secondary travel display.
 *
 * Separate from `RwDisplaysUpdate` on purpose: traveling players match neither
 * `state === "Okay"` nor `state === "Hospital"`, so they appear in none of the
 * four primary buckets. Sharing one payload would mean a traveling-only change
 * produced an identical bucket signature and got suppressed as "unchanged",
 * leaving the travel embed stale while the primary embeds looked healthy.
 *
 * `warState` and `channelId` behave exactly as in `RwDisplaysUpdate`, including
 * `no_war` as the teardown signal.
 */
export interface RwTravelingUpdate {
	/** Family faction (2013 / 27312) whose channel this display belongs to. */
	factionId: number;
	/** The opposing faction this roster came from; 0 when `no_war`. */
	opponentFactionId: number;
	/** The opposing faction name; empty when `no_war`. */
	opponentFactionName: string;
	/** Torn ranked war id, or null when scheduled but not yet begun. */
	warId: number | null;
	warState: "no_war" | "scheduled" | "active";
	/** Discord snowflake of the secondary channel, or null when unset. */
	channelId: string | null;
	destinations: RwTravelingBuckets;
	/** Epoch ms the scheduler produced this payload. */
	updatedAt: number;
}

export type IpcSubversiveRwTravelingUpdateMessage = {
	action: "subversive_rw_traveling_update";
	data: RwTravelingUpdate;
};
