export interface SubversiveDibsConfig {
	enabled: boolean;
	channelId: string | null;
	claimLeadTime: number; // in minutes (e.g. 5)
	maxDibsPerPerson: number; // e.g. 1
	postHospTimeoutSeconds: number; // e.g. 20
	autoDeleteOnDowned: boolean; // default true
	updatedAt?: string;
	updatedBy?: string;
}

export const DEFAULT_SUBVERSIVE_DIBS_CONFIG: SubversiveDibsConfig = {
	enabled: true,
	channelId: null,
	claimLeadTime: 5,
	maxDibsPerPerson: 1,
	postHospTimeoutSeconds: 20,
	autoDeleteOnDowned: true,
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
