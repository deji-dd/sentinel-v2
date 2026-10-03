export interface SubversiveDibsConfig {
	enabled: boolean;
	channelId: string | null;
	claimLeadTime: number; // in minutes (e.g. 5)
	maxDibsPerPerson: number; // e.g. 1
	postHospTimeoutSeconds: number; // e.g. 20
	autoDeleteOnDowned: boolean; // default true

	// ── Channel maintenance ──────────────────────────────────────────────
	/**
	 * Enables the periodic sweep that removes orphaned dibs messages from the
	 * Discord channel (e.g. when a war was termed mid-claim, or after a restart).
	 */
	channelMaintenanceEnabled?: boolean;
	/**
	 * Any bot-authored dibs message older than this is removed by the sweep,
	 * regardless of whether the API still tracks it. Catches orphans the API
	 * lost track of entirely (restarts, failed IPC deliveries).
	 */
	maxDibsMessageAgeHours?: number;
	/**
	 * How often the sweep runs, in minutes. 0 disables the periodic sweep while
	 * leaving the manual dashboard trigger available.
	 */
	sweepIntervalMinutes?: number;

	updatedAt?: string;
	updatedBy?: string;
}

/**
 * A dibs Discord message tracked for cleanup. Persisted so orphaned messages
 * can still be deleted after an API restart.
 */
export interface DibsMessageRef {
	targetId: number;
	factionId?: number;
	channelId: string;
	messageId: string;
	/** Epoch ms when the message was posted. */
	createdAt: number;
}

export const DEFAULT_SUBVERSIVE_DIBS_CONFIG: SubversiveDibsConfig = {
	enabled: true,
	channelId: null,
	claimLeadTime: 5,
	maxDibsPerPerson: 1,
	postHospTimeoutSeconds: 20,
	autoDeleteOnDowned: true,
	channelMaintenanceEnabled: true,
	maxDibsMessageAgeHours: 6,
	sweepIntervalMinutes: 15,
};

export interface DibsClaimant {
	tornId?: number;
	tornName?: string;
	discordId?: string;
	discordTag?: string;
	platform: "script" | "discord";
}

export type DibsStatus = "open" | "claimed";

export interface DibsRecord {
	targetId: number;
	/** Family faction whose ranked war this dibs belongs to (2013 / 27312). */
	factionId?: number;
	targetName: string;
	targetLevel: number;
	estimatedBs: number;
	fairFight: number;
	hospitalUntil: number; // epoch seconds
	status: DibsStatus;
	claimedBy?: DibsClaimant;
	claimedAt?: number; // epoch ms
	discordMessageId?: string;
	discordChannelId?: string;
	exitHospAt?: number; // epoch ms when target was first noticed out of hosp
	createdAt: number; // epoch ms
}
