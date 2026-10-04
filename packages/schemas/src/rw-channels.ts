/**
 * Ranked-war channel selections for the Subversive family factions.
 *
 * These are the Discord channels the ranked-war tooling reads and writes to.
 * They are stored per family faction (2013 / 27312) in the
 * `subversive_rw_channel_configs` table so each faction can route its own war
 * channels independently, mirroring how dibs settings are scoped.
 *
 * Every field is a Discord snowflake, or null when that selection is not
 * routed yet.
 */
export interface SubversiveRwChannelConfig {
	// ── Channel selections ─────────────────────────────────────────────────
	/** Channel hosting the faction's primary ranked-war display. */
	primaryDisplaysChannelId: string | null;
	/**
	 * Channel hosting the faction's secondary ranked-war display, which
	 * summarises where the opposing roster is currently flying.
	 *
	 * Must differ from `primaryDisplaysChannelId`: the primary channel's
	 * stale-message sweep deletes any bot-authored message it does not
	 * recognise, so a shared channel would have the primary sweep destroy the
	 * travel embed as strays on the next war cycle.
	 */
	secondaryDisplaysChannelId: string | null;

	updatedAt?: string;
	updatedBy?: string;
}

export const DEFAULT_SUBVERSIVE_RW_CHANNEL_CONFIG: SubversiveRwChannelConfig = {
	primaryDisplaysChannelId: null,
	secondaryDisplaysChannelId: null,
};
