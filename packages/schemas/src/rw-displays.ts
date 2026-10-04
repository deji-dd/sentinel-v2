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
