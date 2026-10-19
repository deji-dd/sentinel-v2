/**
 * Chain-monitoring configuration and alert payloads for the Subversive family
 * factions.
 *
 * Each family faction (2013 / 27312) runs its own chain, so the settings are
 * per-faction rather than per-Discord-guild. The scheduler's chain monitor polls
 * Torn's `/faction/{id}/chain` with a key from the Subversive script key pool and
 * turns a low chain timer into a Discord warning by broadcasting
 * `subversive_chain_alert` over IPC.
 */

/** Smallest chain length a faction may configure as its monitoring threshold. */
export const MIN_SUBVERSIVE_CHAIN_START = 1;

/** Largest chain length a faction may configure as its monitoring threshold. */
export const MAX_SUBVERSIVE_CHAIN_START = 100_000;

/** Smallest remaining-time warning window, in seconds. */
export const MIN_SUBVERSIVE_CHAIN_WARNING_SECONDS = 5;

/** Largest remaining-time warning window, in seconds (one hour). */
export const MAX_SUBVERSIVE_CHAIN_WARNING_SECONDS = 3_600;

/** Largest repeat interval between warnings, in seconds (one hour). */
export const MAX_SUBVERSIVE_CHAIN_WARNING_INTERVAL_SECONDS = 3_600;

/**
 * Chain-monitor settings for one family faction.
 *
 * `chainTimeWarningSeconds` is measured against Torn's `chain.timeout`, which is
 * the number of seconds left before the chain breaks — not the chain's elapsed
 * duration. A value of 60 therefore means "warn once the timer drops to 60s or
 * less".
 */
export interface SubversiveChainConfig {
	enabled: boolean;
	/** Discord channel that receives warnings, or null when unrouted. */
	channelId: string | null;
	/** Discord role mentioned on every warning, or null for no mention. */
	warningRoleId: string | null;
	/** Chain length at or above which monitoring becomes active. */
	minimumChainStart: number;
	/** Seconds remaining on the chain timer at which warnings begin. */
	chainTimeWarningSeconds: number;
	/**
	 * Seconds between repeated warnings while the timer stays inside the
	 * warning window. Zero sends the first warning only.
	 */
	subsequentWarningIntervalSeconds: number;
	updatedAt?: string;
	updatedBy?: string;
}

/** Factory defaults used when the dashboard has never saved a faction's row. */
export const DEFAULT_SUBVERSIVE_CHAIN_CONFIG: SubversiveChainConfig = {
	enabled: true,
	channelId: null,
	warningRoleId: null,
	minimumChainStart: 10,
	chainTimeWarningSeconds: 60,
	subsequentWarningIntervalSeconds: 10,
};

/** One low-stat, currently-attackable target included with a warning. */
export interface SubversiveChainAlertTarget {
	id: number;
	name: string;
	level: number;
	estimatedBs: number;
}

/** IPC payload for one chain warning delivered to one Discord channel. */
export interface SubversiveChainAlertPayload {
	factionId: number;
	factionName: string;
	channelId: string;
	warningRoleId: string | null;
	chainCurrent: number;
	chainMax: number;
	timeoutSeconds: number;
	modifier: number;
	/** 1-based warning number within the current low-timer period. */
	warningNumber: number;
	/** Up to three lowest-BS okay targets, selected at send time. */
	targets: SubversiveChainAlertTarget[];
}
