/**
 * Strongly-typed IPC message schemas for inter-process communication between
 * Worker/Scheduler V2, Bot, and API applications.
 */

export type IpcWarAction =
	| "assault_start"
	| "assault_succeed"
	| "assault_fail"
	| "peace_treaty";

export type IpcTerritoryAction =
	| "tt_claim"
	| "tt_drop"
	| "racket_spawn"
	| "racket_despawn"
	| "racket_level_up"
	| "racket_level_down";

export type IpcBotAction = IpcWarAction | IpcTerritoryAction;

export type IpcWarPayload = {
	id: string;
	tt: string;
	assaultingFaction: number;
	defendingFaction: number;
	victorFaction: number | null;
	startTime: Date | number;
	endTime: Date | number | null;
};

export type IpcTerritoryPayload = {
	id: string;
	factionId: number | null;
	racket: unknown | null;
	isWarring: boolean;
};

export type IpcWarMessage = {
	action: IpcWarAction;
	data: IpcWarPayload;
};

export type IpcTerritoryMessage = {
	action: IpcTerritoryAction;
	data: IpcTerritoryPayload;
};

export type IpcBotMessage = IpcWarMessage | IpcTerritoryMessage;

export type IpcTelemetryRequestMessage = {
	action: "get_telemetry";
	requestId?: string;
};

export type IpcTelemetryResponseMessage = {
	action: "get_telemetry_response";
	requestId?: string;
	data: {
		pid: number;
		status: "online" | "offline";
		uptimeSeconds: number;
		memory: {
			rssBytes: number;
			heapTotalBytes: number;
			heapUsedBytes: number;
			externalBytes: number;
		};
	};
};

export type IpcForceWorkerMessage = {
	action: "force_run_worker";
	data: {
		workerName: string;
	};
};

export type VerificationTrigger = "user" | "admin" | "join" | "cron";

export type VerificationRequest = {
	guildId: string;
	channelId: string;
	discordId: string;
	currentRoleIds: string[];
	currentNickname: string | null;
	triggeredBy?: VerificationTrigger;
};

export type VerificationSuccessResponse = {
	guildId: string;
	channelId: string;
	discordId: string;
	rolesToAdd: string[] | null;
	rolesToRemove: string[] | null;
	newNickname: string | null;
};

export type VerificationFailureResponse = {
	guildId: string;
	channelId: string;
	discordId: string;
	error: { message: string };
};

export type VerificationResponse =
	| VerificationSuccessResponse
	| VerificationFailureResponse;

export type IpcVerifyRequestMessage = {
	action: "verification_request";
	requestId: string;
	data: VerificationRequest;
};

export type IpcVerifyResponseMessage = {
	action: "verification_response";
	requestId: string;
	data: VerificationResponse;
};

export type BulkVerificationProgressData = {
	guildId: string;
	processed: number;
	total: number;
	updated: number;
	errors: number;
	status: "running" | "completed" | "failed";
	message?: string;
};

export type IpcBulkVerifyProgressMessage = {
	action: "bulk_verification_progress";
	requestId: string;
	data: BulkVerificationProgressData;
};

export type IpcBulkVerifyRequestMessage = {
	action: "bulk_verification_request";
	requestId: string;
	data: {
		guildId: string;
		channelId?: string;
		triggeredBy?: "user" | "admin" | "cron";
	};
};

export type IpcBulkVerifyResponseMessage = {
	action: "bulk_verification_response";
	requestId: string;
	data: {
		guildId: string;
		processed: number;
		total: number;
		updated: number;
		errors: number;
	};
};

export type IpcSyncReactionRolesMessage = {
	action: "sync_reaction_roles";
	data?: {
		guildId?: string;
	};
};

export type IpcSyncFactionMapMessage = {
	action: "sync_faction_map";
	data?: {
		guildId?: string;
	};
};

/**
 * Discriminated union of ALL strongly-typed IPC messages in Sentinel V2.
 */
export type IpcMessage =
	| IpcBotMessage
	| IpcTelemetryRequestMessage
	| IpcTelemetryResponseMessage
	| IpcForceWorkerMessage
	| IpcVerifyRequestMessage
	| IpcVerifyResponseMessage
	| IpcBulkVerifyRequestMessage
	| IpcBulkVerifyProgressMessage
	| IpcBulkVerifyResponseMessage
	| IpcSyncReactionRolesMessage
	| IpcSyncFactionMapMessage;
