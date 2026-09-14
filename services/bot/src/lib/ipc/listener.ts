import { getTargetGuildIds } from "@sentinel/database";
import type {
	BulkVerificationProgressData,
	FactionMember,
	GuildMemberVerificationInput,
	IpcMessage,
	ResolvedElimsUser,
	VerificationResponse,
} from "@sentinel/schemas";
import { IPC_SOCKET_PATHS, IpcClient, IpcServer } from "@sentinel/utils/ipc";
import type { Client } from "discord.js";
import { deployGuildCommands } from "../../scripts/deploy-commands";
import { handleCronVerificationProgress } from "../cron-verification-logger";
import { updateElimsArmoryStorageChannel } from "../elims-armory-storage";
import { updateElimsItemRequestsChannel } from "../elims-item-requests";
import { updateElimsKeyDonationChannel } from "../elims-key-donation";
import { updateElimsLiveDataChannel } from "../elims-live-data";
import { autoAssignElimsStatRoles } from "../elims-stat-roles";
import { syncElimsStockHoldersChannel } from "../elims-stock-holders";
import { updateFactionMapChannel } from "../faction-map-channel";
import { updateFactionRevivesChannel } from "../faction-monitoring-channel";
import { updateGiveawayChannel } from "../giveaways";
import { logger } from "../logger";
import { syncReactionRoleMessages } from "../reaction-roles";
import { handleSubversiveRecruitmentAlert } from "../recruitment-alert-distributor";
import { handleTerritoryAlert } from "../territory-alert-distributor";

type PendingRequest = {
	resolve: (data: VerificationResponse) => void;
	reject: (reason: Error) => void;
	timer: NodeJS.Timeout;
};

export type BulkVerificationResult = {
	guildId: string;
	processed: number;
	total: number;
	updated: number;
	errors: number;
};

export type PendingBulkRequest = {
	resolve: (data: BulkVerificationResult) => void;
	reject: (reason: Error) => void;
	onProgress?: (progress: BulkVerificationProgressData) => void | Promise<void>;
	inactivityTimeoutMs: number;
	timer: NodeJS.Timeout;
};

type IpcMessageListener = (message: IpcMessage) => void;

type PendingElimsResolveUserRequest = {
	resolve: (user: ResolvedElimsUser | null) => void;
	reject: (reason: Error) => void;
	timer: NodeJS.Timeout;
};

type PendingElimsVerifyKeyRequest = {
	resolve: (data: { tornId: number; tornName: string }) => void;
	reject: (reason: Error) => void;
	timer: NodeJS.Timeout;
};

const messageListeners = new Set<IpcMessageListener>();
export const pendingRequests = new Map<string, PendingRequest>();
export const pendingBulkRequests = new Map<string, PendingBulkRequest>();
export const pendingElimsResolveUserRequests = new Map<
	string,
	PendingElimsResolveUserRequest
>();
export const pendingElimsVerifyKeyRequests = new Map<
	string,
	PendingElimsVerifyKeyRequest
>();

type PendingFetchFactionMembersRequest = {
	resolve: (members: FactionMember[]) => void;
	reject: (reason: Error) => void;
	timer: NodeJS.Timeout;
};

export const pendingFetchFactionMembersRequests = new Map<
	string,
	PendingFetchFactionMembersRequest
>();

export function addIpcMessageListener(listener: IpcMessageListener): void {
	messageListeners.add(listener);
}

// Point-to-Point Client connecting directly to worker.sock to receive incoming responses
export const workerIpcClient = new IpcClient<IpcMessage>(
	IPC_SOCKET_PATHS.worker,
	(message) => {
		if (message.action === "verification_response" && message.requestId) {
			const pending = pendingRequests.get(message.requestId);
			if (pending) {
				clearTimeout(pending.timer);
				pendingRequests.delete(message.requestId);
				pending.resolve(message.data);
			}
		}

		if (message.action === "bulk_verification_progress" && message.requestId) {
			const pending = pendingBulkRequests.get(message.requestId);
			if (pending) {
				clearTimeout(pending.timer);

				if (pending.onProgress) {
					try {
						void pending.onProgress(message.data);
					} catch (err) {
						logger.error(
							"Error in onProgress callback for bulk verification:",
							err,
						);
					}
				}

				if (message.data.status === "failed") {
					pendingBulkRequests.delete(message.requestId);
					pending.reject(
						new Error(message.data.message || "Bulk verification failed."),
					);
				} else if (message.data.status === "completed") {
					pendingBulkRequests.delete(message.requestId);
					pending.resolve({
						guildId: message.data.guildId,
						processed: message.data.processed,
						total: message.data.total,
						updated: message.data.updated,
						errors: message.data.errors,
					});
				} else {
					pending.timer = setTimeout(() => {
						pendingBulkRequests.delete(message.requestId);
						pending.reject(
							new Error(
								"Bulk verification timed out. Worker process became unresponsive during streaming.",
							),
						);
					}, pending.inactivityTimeoutMs);
				}
			}
		}

		if (message.action === "bulk_verification_response" && message.requestId) {
			const pending = pendingBulkRequests.get(message.requestId);
			if (pending) {
				clearTimeout(pending.timer);
				pendingBulkRequests.delete(message.requestId);
				pending.resolve({
					guildId: message.data.guildId,
					processed: message.data.processed,
					total: message.data.total ?? message.data.processed,
					updated: message.data.updated,
					errors: message.data.errors,
				});
			}
		}

		if (message.action === "elims_resolve_user_response" && message.requestId) {
			const pending = pendingElimsResolveUserRequests.get(message.requestId);
			if (pending) {
				clearTimeout(pending.timer);
				pendingElimsResolveUserRequests.delete(message.requestId);
				if (message.data.error) {
					logger.warn(
						`Error returned for elims resolve user request [${message.requestId}]: ${message.data.error}`,
					);
				}
				pending.resolve(message.data.user);
			}
		}

		if (message.action === "elims_verify_key_response" && message.requestId) {
			const pending = pendingElimsVerifyKeyRequests.get(message.requestId);
			if (pending) {
				clearTimeout(pending.timer);
				pendingElimsVerifyKeyRequests.delete(message.requestId);
				if (message.data.error) {
					pending.reject(new Error(message.data.error));
				} else if (message.data.tornId && message.data.tornName) {
					pending.resolve({
						tornId: message.data.tornId,
						tornName: message.data.tornName,
					});
				} else {
					pending.reject(
						new Error(
							"Invalid verification response received from scheduler worker.",
						),
					);
				}
			}
		}

		if (
			message.action === "fetch_faction_members_response" &&
			message.requestId
		) {
			const pending = pendingFetchFactionMembersRequests.get(message.requestId);
			if (pending) {
				clearTimeout(pending.timer);
				pendingFetchFactionMembersRequests.delete(message.requestId);
				if (
					message.data.error &&
					(!message.data.members || message.data.members.length === 0)
				) {
					pending.reject(new Error(message.data.error));
				} else {
					pending.resolve(message.data.members ?? []);
				}
			}
		}

		for (const listener of messageListeners) {
			try {
				listener(message);
			} catch (err) {
				logger.error("Error in IPC message listener:", err);
			}
		}
	},
);

export const ipcClient = workerIpcClient;

import { Logger } from "@sentinel/utils";

// Bot Socket Server listening for direct incoming requests on bot.sock
export const botIpcServer = new IpcServer<IpcMessage>(
	IPC_SOCKET_PATHS.bot,
	(message) => {
		for (const listener of messageListeners) {
			try {
				listener(message);
			} catch (err) {
				logger.error("Error in Bot IPC message listener:", err);
			}
		}
	},
);

// Stream live logs to IPC subscribers
Logger.addLogSink((entry) => {
	botIpcServer.broadcast({
		action: "log_event",
		data: entry,
	});
});

if (process.env.NODE_ENV !== "test" && !process.env.BUN_TEST) {
	botIpcServer.start().catch((err) => {
		logger.error("Failed to start Bot IPC server:", err);
	});
}

/**
 * Registers IPC message listeners for real-time bot event dispatches (reaction roles, faction map, territory alerts, cron verification).
 */
export function setupBotIpcListeners(client: Client): void {
	addIpcMessageListener((message) => {
		if (message.action === "sync_guild_commands") {
			const guildId = message.data?.guildId;
			if (typeof guildId === "string") {
				void deployGuildCommands(guildId);
			}
		} else if (message.action === "sync_reaction_roles") {
			void syncReactionRoleMessages(client, message.data?.guildId);
		} else if (message.action === "sync_faction_map") {
			void updateFactionMapChannel(client, message.data?.guildId);
		} else if (message.action === "sync_faction_monitoring") {
			void updateFactionRevivesChannel(
				client,
				message.data?.guildId,
				message.data?.monitorId,
				message.data?.members && message.data?.factionId
					? {
							factionId: message.data.factionId,
							factionName: message.data.factionName,
							members: message.data.members,
						}
					: undefined,
			);
		} else if (message.action === "sync_elims_item_requests") {
			void updateElimsItemRequestsChannel(
				client,
				message.data?.guildId,
				message.data?.config,
			);
			void updateElimsArmoryStorageChannel(client, message.data?.guildId);
			void syncElimsStockHoldersChannel(client, message.data?.guildId);
		} else if (message.action === "sync_elims_giveaways") {
			void updateGiveawayChannel(client, message.data?.guildId);
		} else if (message.action === "sync_elims_key_donation") {
			void updateElimsKeyDonationChannel(client, message.data?.guildId);
		} else if (message.action === "sync_elims_live_data") {
			void updateElimsLiveDataChannel(client, message.data?.guildId, {
				previousChannelId: message.data?.previousChannelId,
				previousMessageId: message.data?.previousMessageId,
			});
		} else if (message.action === "elims_assign_stat_roles") {
			const guildId = message.data?.guildId;
			const roleMappings = message.data?.roleMappings as
				| Record<string, string>
				| undefined;
			if (typeof guildId === "string" && roleMappings) {
				void autoAssignElimsStatRoles(client, guildId, roleMappings);
			}
		} else if (message.action === "sync_elims_guild") {
			const guildId = message.data?.guildId;
			if (typeof guildId === "string") {
				const guildName = client.guilds.cache.get(guildId)?.name;
				logger.info(
					`Elims guild configuration updated via IPC for ${guildName ? `server "${guildName}"` : "guild"}.`,
				);
				void getTargetGuildIds();
				void deployGuildCommands(guildId, guildName);
				void updateElimsItemRequestsChannel(client, guildId);
				void updateGiveawayChannel(client, guildId);
				void updateElimsKeyDonationChannel(client, guildId);
				void updateElimsLiveDataChannel(client, guildId);
			}
		} else if (message.action === "reset_elims_guild") {
			logger.info("Elims guild configuration was reset via IPC.");
			void getTargetGuildIds();
		} else if (message.action === "sync_authorized_guilds") {
			const guildId = message.data?.guildId;
			if (typeof guildId === "string") {
				const guildName = client.guilds.cache.get(guildId)?.name;
				logger.info(
					`Authorized target guilds updated via IPC for ${guildName ? `server "${guildName}"` : "guild"}.`,
				);
				void getTargetGuildIds();
				void deployGuildCommands(guildId, guildName);
			}
		} else if (message.action === "deauthorize_guild") {
			const guildId = message.data?.guildId;
			if (typeof guildId === "string") {
				const guild = client.guilds.cache.get(guildId);
				const guildName = guild?.name;
				logger.info(
					`Server "${guildName ?? "guild"}" was deauthorized via IPC.`,
				);
				void getTargetGuildIds();
				if (guild) {
					void guild.leave().catch((err) => {
						logger.error(
							`Failed to leave deauthorized server "${guild.name}":`,
							err,
						);
					});
				}
			}
		} else if (message.action === "subversive_recruitment_alert") {
			void handleSubversiveRecruitmentAlert(client, message.data);
		} else if (
			message.action === "bulk_verification_progress" &&
			message.requestId?.startsWith("cron-")
		) {
			void handleCronVerificationProgress(
				client,
				message.requestId,
				message.data,
			);
		} else if (
			message.action === "guild_members_request" &&
			message.requestId &&
			message.data?.guildId
		) {
			const guildId = message.data.guildId;
			const requestId = message.requestId;
			void (async () => {
				try {
					const guild =
						client.guilds.cache.get(guildId) ||
						(await client.guilds.fetch(guildId).catch(() => null));
					if (!guild) {
						workerIpcClient.send({
							action: "guild_members_response",
							requestId,
							data: {
								guildId,
								members: [],
								error: `Guild ${guildId} not found on Discord client.`,
							},
						});
						return;
					}

					const guildMembers = await guild.members.fetch();
					const humanMembers = guildMembers.filter((m) => !m.user.bot);
					const members: GuildMemberVerificationInput[] = humanMembers.map(
						(m) => ({
							discordId: m.id,
							currentRoleIds: Array.from(m.roles.cache.keys()),
							currentNickname: m.nickname,
						}),
					);

					workerIpcClient.send({
						action: "guild_members_response",
						requestId,
						data: {
							guildId,
							members,
						},
					});
				} catch (err) {
					const guildName = client.guilds.cache.get(guildId)?.name;
					logger.error(
						`Failed to fetch guild members for ${guildName ? `server "${guildName}"` : "guild"}:`,
						err,
					);
					workerIpcClient.send({
						action: "guild_members_response",
						requestId,
						data: {
							guildId,
							members: [],
							error: err instanceof Error ? err.message : String(err),
						},
					});
				}
			})();
		} else if ("data" in message && message.data) {
			handleTerritoryAlert(
				client,
				message.action,
				message.data as Record<string, unknown>,
			);
		}
	});
}
