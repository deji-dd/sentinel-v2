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

	updatedAt?: string;
	updatedBy?: string;
}

export const DEFAULT_SUBVERSIVE_RW_CHANNEL_CONFIG: SubversiveRwChannelConfig = {
	primaryDisplaysChannelId: null,
};
