/**
 * Strongly-typed IPC message schemas for inter-process communication between
 * Worker/Scheduler V2, Bot, and API applications.
 */

import type {
	IpcSubversiveRwDisplaysUpdateMessage,
	IpcSubversiveRwTravelingUpdateMessage,
} from "./rw-displays";
import type { StockAlertEvent } from "./stock-alerts";
import type { FactionMember } from "./torn/api";

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

export type IpcForceWorkerMessage = {
	action: "force_run_worker";
	data: {
		workerName: string;
	};
};

export type IpcResetLogManagerMessage = {
	action: "reset_log_manager";
};

export type IpcResetSubversiveRecruitmentMessage = {
	action: "reset_subversive_recruitment";
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

export type IpcGuildMembersRequestMessage = {
	action: "guild_members_request";
	requestId: string;
	data: {
		guildId: string;
	};
};

export type IpcGuildMembersResponseMessage = {
	action: "guild_members_response";
	requestId: string;
	data: {
		guildId: string;
		members: GuildMemberVerificationInput[];
		error?: string;
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

export type IpcSyncFactionMonitoringMessage = {
	action: "sync_faction_monitoring";
	data?: {
		guildId?: string;
		monitorId?: string;
		factionId?: number;
		factionName?: string;
		members?: FactionMember[];
		category?: "revives";
	};
};

export type IpcSyncGuildCommandsMessage = {
	action: "sync_guild_commands";
	data?: {
		guildId?: string;
	};
};

export type IpcSyncAuthorizedGuildsMessage = {
	action: "sync_authorized_guilds";
	data?: {
		guildId?: string;
	};
};

export type IpcDeauthorizeGuildMessage = {
	action: "deauthorize_guild";
	data?: {
		guildId?: string;
	};
};

export type IpcSyncElimsGuildMessage = {
	action: "sync_elims_guild";
	data?: {
		guildId?: string;
		adminRoleIds?: string[];
	};
};

export type IpcResetElimsGuildMessage = {
	action: "reset_elims_guild";
	data?: Record<string, unknown>;
};

export type IpcSyncElimsItemRequestsMessage = {
	action: "sync_elims_item_requests";
	data?: {
		guildId?: string;
		config?: Record<string, unknown>;
	};
};

export type IpcSyncElimsGiveawaysMessage = {
	action: "sync_elims_giveaways";
	data?: {
		guildId?: string;
	};
};

export type IpcSyncElimsKeyDonationMessage = {
	action: "sync_elims_key_donation";
	data?: {
		guildId?: string;
	};
};

export type IpcSyncElimsLiveDataMessage = {
	action: "sync_elims_live_data";
	data?: {
		guildId?: string;
		previousChannelId?: string | null;
		previousMessageId?: string | null;
	};
};

export type IpcElimsAssignStatRolesMessage = {
	action: "elims_assign_stat_roles";
	data?: {
		guildId?: string;
		roleMappings?: Record<string, string>;
	};
};

export interface UserCompetitionElimination {
	name: "Elimination" | string;
	score: number;
	team: string;
	attacks: number;
}

export interface ResolvedElimsUser {
	tornId: number;
	tornName: string;
	competition?: UserCompetitionElimination | null;
	networth?: number | null;
	attacks?: number | null;
	attacksWon?: number | null;
}

export type IpcElimsResolveUserRequestMessage = {
	action: "elims_resolve_user_request";
	requestId: string;
	data: {
		discordId: string;
		guildId: string;
	};
};

export type IpcElimsResolveUserResponseMessage = {
	action: "elims_resolve_user_response";
	requestId: string;
	data: {
		user: ResolvedElimsUser | null;
		error?: string;
	};
};

export type IpcElimsVerifyKeyRequestMessage = {
	action: "elims_verify_key_request";
	requestId: string;
	data: {
		apiKey: string;
	};
};

export type IpcElimsVerifyKeyResponseMessage = {
	action: "elims_verify_key_response";
	requestId: string;
	data: {
		tornId?: number;
		tornName?: string;
		error?: string;
	};
};

export type IpcElimsFetchMemberStatsRequestMessage = {
	action: "elims_fetch_member_stats_request";
	requestId: string;
	data: {
		guildId: string;
		roleId?: string;
		forceRefresh?: boolean;
	};
};

export type IpcElimsFetchMemberStatsResponseMessage = {
	action: "elims_fetch_member_stats_response";
	requestId: string;
	data: {
		total: number;
		newProcessed: number;
		resolved: number;
		ffScouterHits: number;
		error?: string;
	};
};

export type IpcElimsSyncTeamsRequestMessage = {
	action: "elims_sync_teams_request";
	requestId: string;
};

export type IpcElimsSyncTeamsResponseMessage = {
	action: "elims_sync_teams_response";
	requestId: string;
	data: {
		success: boolean;
		isMock: boolean;
		teamsCount: number;
		error?: string;
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

export type IpcElimsStopWorkersRequestMessage = {
	action: "elims_stop_workers";
	requestId: string;
};

export type IpcElimsStopWorkersResponseMessage = {
	action: "elims_stop_workers_response";
	requestId: string;
	data: {
		stopped: string[];
		workersStopped?: boolean;
	};
};

export type IpcElimsStartWorkersRequestMessage = {
	action: "elims_start_workers";
	requestId: string;
};

export type IpcElimsStartWorkersResponseMessage = {
	action: "elims_start_workers_response";
	requestId: string;
	data: {
		started: string[];
		workersStopped?: boolean;
	};
};

export type IpcSubversiveRecruitmentAlertPayload = {
	candidateId: string;
	playerId: number;
	playerName: string;
	playerLevel: number;
	factionId: number;
	factionName: string;
	warId: number;
	attacks: number;
	factionTotalAttacks: number;
	attackPercentage: number;
	score: number;
	bsEstimate: number | null;
	fairFight: number | null;
	daysInFaction?: number | null;
	factionRole?: string | null;
	notificationChannelId: string;
};

export type IpcSubversiveRecruitmentAlertMessage = {
	action: "subversive_recruitment_alert";
	data: IpcSubversiveRecruitmentAlertPayload;
};

/**
 * One batched stock-alert delivery for a single Discord channel.
 *
 * Batched rather than one message per event because a market-wide move can trip
 * several stocks in the same cycle, and the bot renders the batch as one
 * message with several embeds.
 */
export type IpcSubversiveStockAlertsPayload = {
	notificationChannelId: string;
	alerts: StockAlertEvent[];
};

export type IpcSubversiveStockAlertsMessage = {
	action: "subversive_stock_alerts";
	data: IpcSubversiveStockAlertsPayload;
};

export type IpcFetchFactionMembersRequestMessage = {
	action: "fetch_faction_members_request";
	requestId: string;
	data: {
		factionId: number;
	};
};

export type IpcFetchFactionMembersResponseMessage = {
	action: "fetch_faction_members_response";
	requestId: string;
	data: {
		factionId: number;
		members: FactionMember[];
		error?: string;
	};
};

/**
 * Discriminated union of ALL strongly-typed IPC messages in Sentinel V2.
 */
export type IpcMessage =
	| IpcBotMessage
	| IpcForceWorkerMessage
	| IpcResetLogManagerMessage
	| IpcFetchFactionMembersRequestMessage
	| IpcFetchFactionMembersResponseMessage
	| IpcVerifyRequestMessage
	| IpcVerifyResponseMessage
	| IpcBulkVerifyRequestMessage
	| IpcBulkVerifyProgressMessage
	| IpcBulkVerifyResponseMessage
	| IpcGuildMembersRequestMessage
	| IpcGuildMembersResponseMessage
	| IpcSyncReactionRolesMessage
	| IpcSyncFactionMapMessage
	| IpcSyncFactionMonitoringMessage
	| IpcSyncGuildCommandsMessage
	| IpcSyncAuthorizedGuildsMessage
	| IpcDeauthorizeGuildMessage
	| IpcSyncElimsGuildMessage
	| IpcResetElimsGuildMessage
	| IpcSyncElimsItemRequestsMessage
	| IpcSyncElimsGiveawaysMessage
	| IpcSyncElimsKeyDonationMessage
	| IpcSyncElimsLiveDataMessage
	| IpcElimsAssignStatRolesMessage
	| IpcElimsResolveUserRequestMessage
	| IpcElimsResolveUserResponseMessage
	| IpcElimsVerifyKeyRequestMessage
	| IpcElimsVerifyKeyResponseMessage
	| IpcElimsFetchMemberStatsRequestMessage
	| IpcElimsFetchMemberStatsResponseMessage
	| IpcElimsSyncTeamsRequestMessage
	| IpcElimsSyncTeamsResponseMessage
	| IpcElimsStopWorkersRequestMessage
	| IpcElimsStopWorkersResponseMessage
	| IpcElimsStartWorkersRequestMessage
	| IpcElimsStartWorkersResponseMessage
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
	| IpcWealthStateUpdatedMessage
	| IpcSubversiveRecruitmentAlertMessage
	| IpcSubversiveStockAlertsMessage
	| IpcResetSubversiveRecruitmentMessage
	| IpcSubversiveWarUpdatedMessage
	| IpcSubversiveRetalUpdatedMessage
	| IpcSubversiveHitCountsUpdatedMessage
	| IpcSubversiveRwDisplaysUpdateMessage
	| IpcSubversiveRwTravelingUpdateMessage
	| IpcPersonalBountiesUpdatedMessage
	| IpcPostDibsAlertMessage
	| IpcEditDibsAlertMessage
	| IpcDeleteDibsAlertMessage
	| IpcSweepDibsChannelMessage
	| IpcPostMercContractAnnouncementMessage
	| IpcPostMercTargetAlertMessage
	| IpcMercTargetMessageRecordedMessage
	| IpcUpdateMercTargetAlertMessage
	| IpcDeleteMercTargetAlertMessage
	| IpcDeleteAllMercTargetAlertsMessage
	| IpcPostMercHitLogMessage
	| IpcPostMercContractEndSummaryMessage
	| IpcPostMercContractPaidMessage
	| IpcDeleteMercUpcomingAnnouncementMessage
	| IpcSyncMercContractCreationMessage
	| IpcArchiveMercClientChannelMessage
	| IpcCheckExpiredMercTokensMessage
	| IpcCleanupArchivedMercChannelsMessage
	| IpcMercClaimTargetRequestMessage
	| IpcMercClaimTargetResponseMessage
	| IpcMercReleaseTargetRequestMessage
	| IpcMercReleaseTargetResponseMessage
	| IpcUpdateMercRevivablesListMessage;

export type IpcPostDibsAlertMessage = {
	action: "post_dibs_alert";
	data: {
		channelId: string;
		dibs: import("./dibs").DibsRecord;
	};
};

export type IpcEditDibsAlertMessage = {
	action: "edit_dibs_alert";
	data: {
		channelId: string;
		messageId: string;
		dibs: import("./dibs").DibsRecord;
		status: "open" | "claimed";
	};
};

export type IpcDeleteDibsAlertMessage = {
	action: "delete_dibs_alert";
	data: {
		channelId: string;
		messageId: string;
		targetId?: number;
	};
};

/**
 * Reconciles a dibs channel by deleting our own orphaned / expired dibs callouts.
 *
 * `liveMessageIds` are the messages the API still considers active and must never
 * be touched. `trackedMessageIds` are messages the API has on record but no longer
 * treats as active — those are orphans (e.g. war termed, API restarted) and are
 * deleted. Anything authored by this bot past `maxAgeHours` is also removed.
 */
export type IpcSweepDibsChannelMessage = {
	action: "sweep_dibs_channel";
	data: {
		channelId: string;
		factionId: number;
		liveMessageIds: string[];
		trackedMessageIds: string[];
		maxAgeHours: number;
	};
};

/**
 * Ranked war snapshot for a single family faction (2013 / 27312).
 */
export type IpcSubversiveFactionWarSnapshot = {
	war: unknown;
	opponents: unknown[];
};

export type IpcSubversiveWarUpdatedMessage = {
	action: "subversive_war_updated";
	data: {
		/** War snapshots keyed by family faction id. */
		wars: Record<string, IpcSubversiveFactionWarSnapshot>;
		/** @deprecated Legacy single-faction payload, retained for compatibility. */
		war?: unknown;
		/** @deprecated Legacy single-faction payload, retained for compatibility. */
		opponents?: unknown[];
	};
};

/**
 * Retal state for one family faction: opponents that have struck a member
 * within the last 5 minutes. An empty list is meaningful — it clears badges.
 */
export type IpcSubversiveRetalUpdatedMessage = {
	action: "subversive_retal_updated";
	data: {
		/** Family faction id the set applies to (2013 / 27312). */
		factionId: number;
		/** Opponent member ids currently holding a Retal badge. */
		retalIds: number[];
		updatedAt: number;
	};
};

/**
 * Per-member ranked war hit counts for one family faction. Counts are scoped to
 * a single war and reset when the faction rolls into a new one.
 */
export type IpcSubversiveHitCountsUpdatedMessage = {
	action: "subversive_hit_counts_updated";
	data: {
		/** Family faction id the counts apply to (2013 / 27312). */
		factionId: number;
		/** Torn war id the counts belong to. */
		warId: number | null;
		/** Landed ranked war hits, keyed by attacker Torn id as a string. */
		counts: Record<string, number>;
		updatedAt: number;
	};
};

export type IpcPersonalBountiesUpdatedMessage = {
	action: "personal_bounties_updated";
	data: unknown;
};

export type IpcPostMercContractAnnouncementMessage = {
	action: "post_merc_contract_announcement";
	data: {
		guildId: string;
		channelName: string;
		contract: unknown;
		mercRoleId?: string | null;
	};
};

export type IpcPostMercTargetAlertMessage = {
	action: "post_merc_target_alert";
	data: {
		guildId: string;
		channelName: string;
		contractId: string;
		target: unknown;
		mercRoleId?: string | null;
	};
};

export type IpcMercTargetMessageRecordedMessage = {
	action: "merc_target_message_recorded";
	data: {
		contractId: string;
		targetId: number;
		messageId: string;
		channelName: string;
	};
};

export type IpcUpdateMercTargetAlertMessage = {
	action: "update_merc_target_alert";
	data: {
		guildId: string;
		channelName: string;
		messageId: string;
		contractId: string;
		target: unknown;
	};
};

export type IpcDeleteMercTargetAlertMessage = {
	action: "delete_merc_target_alert";
	data: {
		guildId: string;
		channelName: string;
		messageId: string;
	};
};

export type IpcDeleteAllMercTargetAlertsMessage = {
	action: "delete_all_merc_target_alerts";
	data: {
		guildId: string;
		channelName: string;
		contractId: string;
	};
};

export type IpcPostMercHitLogMessage = {
	action: "post_merc_hit_log";
	data: {
		guildId: string;
		channelName: string;
		hitData: unknown;
	};
};

export type IpcPostMercContractEndSummaryMessage = {
	action: "post_merc_contract_end_summary";
	data: {
		guildId: string;
		channelName: string;
		contract: unknown;
		summary: unknown;
	};
};

/**
 * Sent when an admin settles a concluded contract, to announce the payment in the
 * guild's configured past contracts channel. Fired exactly once per contract —
 * the API suppresses it if `paid_at` was already set.
 */
export type IpcPostMercContractPaidMessage = {
	action: "post_merc_contract_paid";
	data: {
		guildId: string;
		/** Channel name for the past contracts channel; resolved by the bot. */
		channelName: string;
		contract: unknown;
		summary: unknown;
		/** ISO timestamp of when the contract was marked paid. */
		paidAt: string;
	};
};

export type IpcDeleteMercUpcomingAnnouncementMessage = {
	action: "delete_merc_upcoming_announcement";
	data: {
		guildId: string;
		contractId: string;
		factionId: number;
		channelName?: string;
		messageId?: string;
	};
};

export type IpcSyncMercContractCreationMessage = {
	action: "sync_merc_contract_creation";
	data: {
		guildId?: string;
	};
};

export type IpcArchiveMercClientChannelMessage = {
	action: "archive_merc_client_channel";
	data: {
		guildId: string;
		channelId: string;
		clientDiscordId?: string;
		reason?: string;
	};
};

export type IpcCheckExpiredMercTokensMessage = {
	action: "check_expired_merc_tokens";
};

export type IpcCleanupArchivedMercChannelsMessage = {
	action: "cleanup_archived_merc_channels";
	data?: {
		maxAgeDays?: number;
	};
};

export type IpcMercClaimTargetRequestMessage = {
	action: "merc_claim_target_request";
	requestId?: string;
	data: {
		contractId: string;
		targetId: number;
		claimant: unknown;
	};
};

export type IpcMercClaimTargetResponseMessage = {
	action: "merc_claim_target_response";
	requestId?: string;
	data: {
		success: boolean;
		targetId?: number;
		error?: string;
		reason?: string;
		claimant?: unknown;
	};
};

export type IpcMercReleaseTargetRequestMessage = {
	action: "merc_release_target_request";
	requestId?: string;
	data: {
		contractId: string;
		targetId: number;
		discordUserId?: string;
	};
};

export type IpcMercReleaseTargetResponseMessage = {
	action: "merc_release_target_response";
	requestId?: string;
	data: {
		success: boolean;
		targetId?: number;
		error?: string;
		reason?: string;
	};
};

export type IpcUpdateMercRevivablesListMessage = {
	action: "update_merc_revivables_list";
	data: {
		guildId: string;
		contractId: string;
		channelName: string;
		factionName: string;
		factionId: number;
		members: Array<{
			id: number;
			name: string;
			level: number;
			statusState: string;
			statusDescription: string;
			statusUntil?: number | null;
			lastActionRelative?: string | null;
		}>;
	};
};
