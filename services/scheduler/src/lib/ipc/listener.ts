import { db, workerSchedules } from "@sentinel/database";
import type { IpcMessage } from "@sentinel/schemas";
import { Logger } from "@sentinel/utils";
import { IPC_SOCKET_PATHS, IpcServer } from "@sentinel/utils/ipc";
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

			if (message.action === "get_telemetry") {
				const workerMem = process.memoryUsage();
				ipcServer.broadcast({
					action: "get_telemetry_response",
					requestId: message.requestId,
					data: {
						pid: process.pid,
						status: "online",
						uptimeSeconds: Math.round(process.uptime()),
						memory: {
							rssBytes: workerMem.rss,
							heapTotalBytes: workerMem.heapTotal,
							heapUsedBytes: workerMem.heapUsed,
							externalBytes: workerMem.external,
						},
					},
				});
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
					ipcServer.broadcast({
						action: "bulk_verification_response",
						requestId: message.requestId,
						data: {
							guildId: message.data.guildId,
							processed: 0,
							updated: 0,
							errors: 1,
						},
					});
				}
				return;
			}

			logger.info("IPC Message Received:", message);

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
	return ipcServer;
}
