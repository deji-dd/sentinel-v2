import { db, workerSchedules } from "@sentinel/database";
import type { IpcMessage } from "@sentinel/schemas";
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
