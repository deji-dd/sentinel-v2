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

export type LogLevel = "info" | "warn" | "error" | "debug";

export type LogEntry = {
	id: string;
	timestamp: string;
	service: "api" | "bot" | "scheduler";
	context: string;
	subContext?: string;
	level: LogLevel;
	message: string;
};

export type IpcLogEventMessage = {
	action: "log_event";
	data: LogEntry;
};

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
		cpuUsage?: number;
		memory: {
			rssBytes: number;
			heapTotalBytes: number;
			heapUsedBytes: number;
			externalBytes: number;
		};
		recentLogs?: LogEntry[];
	};
};

export type IpcForceWorkerMessage = {
	action: "force_run_worker";
	data: {
		workerName: string;
	};
};

export type IpcResetLogManagerMessage = {
	action: "reset_log_manager";
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

export type MemberVerificationAction = {
	discordId: string;
	rolesToAdd: string[] | null;
	rolesToRemove: string[] | null;
	newNickname: string | null;
};

export type GuildMemberVerificationInput = {
	discordId: string;
	currentRoleIds: string[];
	currentNickname: string | null;
};

export type BulkVerificationProgressData = {
	guildId: string;
	processed: number;
	total: number;
	updated: number;
	errors: number;
	status: "running" | "completed" | "failed";
	message?: string;
	actions?: MemberVerificationAction[];
};

export type IpcBulkVerifyRequestMessage = {
	action: "bulk_verification_request";
	requestId: string;
	data: {
		guildId: string;
		channelId?: string;
		triggeredBy?: "user" | "admin" | "cron";
		members?: GuildMemberVerificationInput[];
	};
};

export type IpcBulkVerifyProgressMessage = {
	action: "bulk_verification_progress";
	requestId: string;
	data: BulkVerificationProgressData;
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

export type IpcReinitializeCrimeLedgerMessage = {
	action: "reinitialize_crime_ledger";
	data?: Record<string, unknown>;
};

export type IpcCrimeLedgerStateUpdatedMessage = {
	action: "crime_ledger_state_updated";
	data: {
		status: "idle" | "running" | "completed" | "error";
		totalIndexedCrimes?: number;
		lastProcessedTimestamp?: number | null;
		lastError?: string | null;
		updatedAt?: string;
	};
};

export type IpcReinitializeGymLedgerMessage = {
	action: "reinitialize_gym_ledger";
	data?: Record<string, unknown>;
};

export type IpcGymLedgerStateUpdatedMessage = {
	action: "gym_ledger_state_updated";
	data: {
		status: "idle" | "running" | "completed" | "error";
		totalIndexedLogs?: number;
		lastProcessedTimestamp?: number | null;
		lastError?: string | null;
		updatedAt?: string;
	};
};

export type IpcReinitializeBattlestatsLedgerMessage = {
	action: "reinitialize_battlestats_ledger";
	data?: Record<string, unknown>;
};

export type IpcBattlestatsLedgerStateUpdatedMessage = {
	action: "battlestats_ledger_state_updated";
	data: {
		status: "idle" | "running" | "completed" | "error";
		totalIndexedLogs?: number;
		lastProcessedTimestamp?: number | null;
		lastError?: string | null;
		updatedAt?: string;
	};
};

export type IpcReinitializeStocksLedgerMessage = {
	action: "reinitialize_stocks_ledger";
	data?: Record<string, unknown>;
};

export type IpcStocksLedgerStateUpdatedMessage = {
	action: "stocks_ledger_state_updated";
	data: {
		status: "idle" | "running" | "completed" | "error";
		totalIndexedLogs?: number;
		lastProcessedTimestamp?: number | null;
		lastError?: string | null;
		updatedAt?: string;
	};
};

export type IpcCompanySyncStateUpdatedMessage = {
	action: "company_sync_state_updated";
	data: {
		status: "idle" | "running" | "completed" | "error";
		lastInflow?: number;
		lastOutflow?: number;
		lastProfit?: number;
		lastSyncTimestamp?: number | null;
		lastError?: string | null;
		updatedAt?: string;
	};
};

export type IpcReinitializeWealthMessage = {
	action: "reinitialize_wealth";
	data?: {
		timestamp?: number;
	};
};

export type IpcWealthStateUpdatedMessage = {
	action: "wealth_state_updated";
	data: {
		init: boolean;
		initTimestamp: number | null;
		status: "idle" | "running" | "completed" | "error";
		lastSyncTimestamp: number | null;
		lastError: string | null;
		updatedAt: string;
		totals: {
			totalInflow: number;
			totalOutflow: number;
			netProfit: number;
			crimesInflow: number;
			stocksInflow: number;
			companyInflow: number;
			companyOutflow: number;
			otherInflow: number;
		};
		totalEventsIndexed: number;
	};
};

/**
 * Discriminated union of ALL strongly-typed IPC messages in Sentinel V2.
 */
export type IpcMessage =
	| IpcBotMessage
	| IpcTelemetryRequestMessage
	| IpcTelemetryResponseMessage
	| IpcLogEventMessage
	| IpcForceWorkerMessage
	| IpcResetLogManagerMessage
	| IpcVerifyRequestMessage
	| IpcVerifyResponseMessage
	| IpcBulkVerifyRequestMessage
	| IpcBulkVerifyProgressMessage
	| IpcBulkVerifyResponseMessage
	| IpcSyncReactionRolesMessage
	| IpcSyncFactionMapMessage
	| IpcReinitializeCrimeLedgerMessage
	| IpcCrimeLedgerStateUpdatedMessage
	| IpcReinitializeGymLedgerMessage
	| IpcGymLedgerStateUpdatedMessage
	| IpcReinitializeBattlestatsLedgerMessage
	| IpcBattlestatsLedgerStateUpdatedMessage
	| IpcReinitializeStocksLedgerMessage
	| IpcStocksLedgerStateUpdatedMessage
	| IpcCompanySyncStateUpdatedMessage
	| IpcReinitializeWealthMessage
	| IpcWealthStateUpdatedMessage;
