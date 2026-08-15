import type {
	BulkVerificationProgressData,
	IpcMessage,
	IpcTelemetryResponseMessage,
	VerificationResponse,
} from "@sentinel/schemas";
import { IPC_SOCKET_PATHS, IpcClient, IpcServer } from "@sentinel/utils/ipc";
import type { Client } from "discord.js";
import { handleCronVerificationProgress } from "../cron-verification-logger";
import { updateFactionMapChannel } from "../faction-map-channel";
import { logger } from "../logger";
import { syncReactionRoleMessages } from "../reaction-roles";
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

const messageListeners = new Set<IpcMessageListener>();
export const pendingRequests = new Map<string, PendingRequest>();
export const pendingBulkRequests = new Map<string, PendingBulkRequest>();

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

// Bot Socket Server listening for direct incoming requests on bot.sock
export const botIpcServer = new IpcServer<IpcMessage>(
	IPC_SOCKET_PATHS.bot,
	(message) => {
		if (message.action === "get_telemetry") {
			const botMem = process.memoryUsage();
			const response: IpcTelemetryResponseMessage = {
				action: "get_telemetry_response",
				requestId: message.requestId,
				data: {
					pid: process.pid,
					status: "online",
					uptimeSeconds: Math.round(process.uptime()),
					memory: {
						rssBytes: botMem.rss,
						heapTotalBytes: botMem.heapTotal,
						heapUsedBytes: botMem.heapUsed,
						externalBytes: botMem.external,
					},
				},
			};
			botIpcServer.broadcast(response);
		}
	},
);

botIpcServer.start();

/**
 * Registers IPC message listeners for real-time bot event dispatches (reaction roles, faction map, territory alerts, cron verification).
 */
export function setupBotIpcListeners(client: Client): void {
	addIpcMessageListener((message) => {
		if (message.action === "sync_reaction_roles") {
			void syncReactionRoleMessages(client, message.data?.guildId);
		} else if (message.action === "sync_faction_map") {
			void updateFactionMapChannel(client, message.data?.guildId);
		} else if (
			message.action === "bulk_verification_progress" &&
			message.requestId?.startsWith("cron-")
		) {
			void handleCronVerificationProgress(
				client,
				message.requestId,
				message.data,
			);
		} else if ("data" in message && message.data) {
			handleTerritoryAlert(
				client,
				message.action,
				message.data as Record<string, unknown>,
			);
		}
	});
}
