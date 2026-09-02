import { db, workerSchedules } from "@sentinel/database";
import type {
	GuildMemberVerificationInput,
	IpcMessage,
} from "@sentinel/schemas";
import { Logger } from "@sentinel/utils";
import { IPC_SOCKET_PATHS, IpcServer } from "@sentinel/utils/ipc";
import { reinitializeBattlestatsLedger } from "../../workers/personal/battlestats";
import { reinitializeCrimeLedger } from "../../workers/personal/crimes";
import { requestResetLogManager } from "../../workers/personal/log-manager";
import { reinitializeStocksLedger } from "../../workers/personal/stocks";
import { initWealthTracking } from "../../workers/personal/wealth";

import { triggerWorkerByName } from "../scheduler";
import { runBulkGuildVerification, runVerificationJob } from "../verification";
import { setActiveIpcServer } from "./server";

const logger = new Logger("SchedulerIPC");

type PendingGuildMembersRequest = {
	resolve: (members: GuildMemberVerificationInput[] | null) => void;
	timer: NodeJS.Timeout;
};

const pendingGuildMembersRequests = new Map<
	string,
	PendingGuildMembersRequest
>();

/**
 * Requests live guild member state (roles, nickname) from the Discord bot over IPC.
 * Includes configurable retries with backoff if the bot is temporarily unresponsive.
 */
export async function requestGuildMembersFromBot(
	ipcServer: IpcServer<IpcMessage> | null,
	guildId: string,
	options: { timeoutMs?: number; retries?: number } = {},
): Promise<GuildMemberVerificationInput[] | null> {
	if (!ipcServer) {
		logger.warn("Cannot request guild members: IPC server is not initialized.");
		return null;
	}

	const timeoutMs = options.timeoutMs ?? 10000;
	const retries = options.retries ?? 2;

	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt > 0) {
			logger.info(
				`[Guild ${guildId}] Retrying guild members fetch from bot (Attempt ${attempt + 1}/${retries + 1})...`,
			);
			await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
		}

		const requestId = `members-${guildId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

		const result = await new Promise<GuildMemberVerificationInput[] | null>(
			(resolve) => {
				const timer = setTimeout(() => {
					pendingGuildMembersRequests.delete(requestId);
					resolve(null);
				}, timeoutMs);

				pendingGuildMembersRequests.set(requestId, { resolve, timer });

				ipcServer.broadcast({
					action: "guild_members_request",
					requestId,
					data: { guildId },
				});
			},
		);

		if (result !== null) {
			return result;
		}
	}

	logger.warn(
		`[Guild ${guildId}] Failed to retrieve live guild members from bot after ${retries + 1} attempts. Bot may be offline.`,
	);
	return null;
}

/**
 * Initializes and configures the Unix Domain Socket (IPC) server for the Scheduler service.
 */
export async function setupSchedulerIpc(): Promise<IpcServer<IpcMessage>> {
	const socketPath = IPC_SOCKET_PATHS.worker;

	const ipcServer = new IpcServer<IpcMessage>(
		socketPath,
		async (rawMessage: unknown) => {
			const message = rawMessage as IpcMessage;
			if (!message || typeof message !== "object" || !("action" in message)) {
				return;
			}

			if (message.action === "verification_request" && message.data) {
				try {
					const result = await runVerificationJob(message.data);
					ipcServer.broadcast({
						action: "verification_response",
						requestId: message.requestId,
						data: result,
					});
				} catch (err) {
					logger.error("Verification job failed via IPC:", err);
					ipcServer.broadcast({
						action: "verification_response",
						requestId: message.requestId,
						data: {
							guildId: message.data.guildId,
							channelId: message.data.channelId,
							discordId: message.data.discordId,
							error: {
								message:
									err instanceof Error ? err.message : "Internal worker error.",
							},
						},
					});
				}
				return;
			}

			if (
				message.action === "bulk_verification_request" &&
				message.data?.guildId
			) {
				try {
					const result = await runBulkGuildVerification(
						message.data.guildId,
						message.data.triggeredBy || "admin",
						(progress) => {
							ipcServer.broadcast({
								action: "bulk_verification_progress",
								requestId: message.requestId,
								data: progress,
							});
						},
						message.data.members,
					);
					ipcServer.broadcast({
						action: "bulk_verification_response",
						requestId: message.requestId,
						data: {
							guildId: message.data.guildId,
							...result,
						},
					});
				} catch (err) {
					logger.error("Bulk verification job failed via IPC:", err);
					const errMsg =
						err instanceof Error ? err.message : "Internal worker error.";
					ipcServer.broadcast({
						action: "bulk_verification_progress",
						requestId: message.requestId,
						data: {
							guildId: message.data.guildId,
							processed: 0,
							total: 0,
							updated: 0,
							errors: 1,
							status: "failed",
							message: errMsg,
						},
					});
					ipcServer.broadcast({
						action: "bulk_verification_response",
						requestId: message.requestId,
						data: {
							guildId: message.data.guildId,
							processed: 0,
							total: 0,
							updated: 0,
							errors: 1,
						},
					});
				}
				return;
			}

			if (message.action === "guild_members_response" && message.requestId) {
				const pending = pendingGuildMembersRequests.get(message.requestId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingGuildMembersRequests.delete(message.requestId);
					if (message.data.error) {
						logger.warn(
							`Error returned from bot for guild members request: ${message.data.error}`,
						);
						pending.resolve(null);
					} else {
						pending.resolve(message.data.members);
					}
				}
				return;
			}

			logger.info("IPC Message Received:", message);

			if (message.action === "reset_log_manager") {
				// Queue the reset on the worker itself. It is applied atomically at
				// the start of the next sync cycle, so it is race-safe even if a
				// cycle is currently executing. The queued force-run below ensures
				// the next cycle starts immediately (or right after the in-flight
				// cycle finishes).
				requestResetLogManager();
				logger.info("Queued Log Manager state reset request.");

				const triggered = triggerWorkerByName("personal:log_manager");
				if (triggered) {
					logger.info(
						"Triggered Log Manager runner to apply the reset immediately.",
					);
				} else {
					logger.warn(
						"Log Manager runner not active; reset will apply on its next cycle after startup.",
					);
				}
				return;
			}

			if (message.action === "reinitialize_crime_ledger") {
				logger.info(
					"Received reinitialize_crime_ledger IPC command. Running full rebuild in scheduler...",
				);
				reinitializeCrimeLedger().catch((err) => {
					logger.error("Error executing crime ledger reinitialization:", err);
				});
				return;
			}

			if (
				message.action === "reinitialize_battlestats_ledger" ||
				message.action === "reinitialize_gym_ledger"
			) {
				logger.info(
					"Received reinitialize_battlestats_ledger IPC command. Running full rebuild in scheduler...",
				);
				reinitializeBattlestatsLedger().catch((err) => {
					logger.error(
						"Error executing battlestats ledger reinitialization:",
						err,
					);
				});
				return;
			}

			if (message.action === "reinitialize_stocks_ledger") {
				logger.info(
					"Received reinitialize_stocks_ledger IPC command. Running full rebuild in scheduler...",
				);
				reinitializeStocksLedger().catch((err) => {
					logger.error("Error executing stocks ledger reinitialization:", err);
				});
				return;
			}

			if (message.action === "reinitialize_wealth") {
				const initTs = (message.data as { timestamp?: number } | undefined)
					?.timestamp;
				logger.info(
					`Received reinitialize_wealth IPC command with timestamp: ${initTs ?? "now"}. Running full baseline snapshot in scheduler...`,
				);
				initWealthTracking(initTs).catch((err) => {
					logger.error("Error executing wealth initialization:", err);
				});
				return;
			}

			if (message.action === "force_run_worker" && message.data?.workerName) {
				const workerName = message.data.workerName;

				try {
					await db
						.insert(workerSchedules)
						.values({ id: workerName, forceRun: true })
						.onConflictDoUpdate({
							target: workerSchedules.id,
							set: { forceRun: true },
						});

					logger.info(`Set forceRun = true for worker '${workerName}'.`);

					const triggered = triggerWorkerByName(workerName);
					if (triggered) {
						logger.info(
							`Triggered active in-memory runner for '${workerName}' immediately.`,
						);
					}
				} catch (err) {
					logger.error(`Failed to force trigger worker '${workerName}':`, err);
				}
			}
		},
	);

	setActiveIpcServer(ipcServer);

	Logger.addLogSink((entry) => {
		ipcServer.broadcast({
			action: "log_event",
			data: entry,
		});
	});

	return ipcServer;
}
