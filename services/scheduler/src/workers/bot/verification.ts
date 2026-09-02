import { db, eq, guildConfigs } from "@sentinel/database";
import { isTargetGuild, Logger } from "@sentinel/utils";
import { requestGuildMembersFromBot } from "../../lib/ipc/listener";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import { runBulkGuildVerification } from "../../lib/verification";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "bot:verification";
const logger = new Logger("Scheduler", "Verification");

/**
 * Periodically checks for guilds with `verifyCron` enabled and triggers verification runs.
 */
export async function runVerificationWorker(): Promise<void> {
	const finishLog = logger.time();

	try {
		const guilds = await db.query.guildConfigs.findMany({
			where: eq(guildConfigs.verifyCron, true),
		});

		const activeGuilds = guilds.filter((guild) => isTargetGuild(guild.guildId));

		if (activeGuilds.length === 0) {
			logger.info(
				"No target guilds currently have scheduled verification cron enabled.",
			);
			finishLog();
			return;
		}

		const now = new Date();

		for (const guild of activeGuilds) {
			const intervalHours = guild.verifyCronInterval || 24;
			const intervalMs = intervalHours * 60 * 60 * 1000;
			const lastRun = guild.lastVerifyCronAt?.getTime() || 0;
			const elapsedMs = now.getTime() - lastRun;

			if (elapsedMs >= intervalMs) {
				const ipcServer = getActiveIpcServer();

				logger.info(
					`[Guild ${guild.guildId}] Scheduled verification due (Interval: ${intervalHours}h). Requesting member roster from bot...`,
				);

				// Request live guild members (with current Discord role IDs & nickname) from bot over IPC
				const liveMembers = await requestGuildMembersFromBot(
					ipcServer,
					guild.guildId,
					{ timeoutMs: 10000, retries: 2 },
				);

				// If the bot process is offline or unreachable, terminate early without falsely updating lastVerifyCronAt
				if (!liveMembers) {
					logger.warn(
						`[Guild ${guild.guildId}] Bot is unreachable via IPC after retries. Aborting scheduled verification sweep early as Discord roles cannot be updated. Will retry next cycle.`,
					);
					continue;
				}

				await db
					.update(guildConfigs)
					.set({
						lastVerifyCronAt: now,
						updatedAt: now,
					})
					.where(eq(guildConfigs.guildId, guild.guildId));

				const requestId = `cron-${guild.guildId}-${Date.now()}`;

				logger.info(
					`[Guild ${guild.guildId}] Starting scheduled verification sweep with ${liveMembers.length} live members...`,
				);

				const stats = await runBulkGuildVerification(
					guild.guildId,
					"cron",
					(progress) => {
						// Stream progress to Discord Bot over IPC for live audit log updates
						ipcServer?.broadcast({
							action: "bulk_verification_progress",
							requestId,
							data: progress,
						});

						if (progress.total === 0) return;
						const pct = Math.min(
							100,
							Math.round((progress.processed / progress.total) * 100),
						);
						const barLen = 12;
						const filled = Math.min(barLen, Math.round((pct / 100) * barLen));
						const bar = `[${"█".repeat(filled)}${"░".repeat(barLen - filled)}]`;

						if (
							progress.status === "running" &&
							(progress.processed % 10 === 0 ||
								progress.processed === progress.total)
						) {
							logger.info(
								`[Guild ${guild.guildId}] ${bar} ${pct}% (${progress.processed}/${progress.total}) • ${progress.updated} updated • ${progress.errors} errors`,
							);
						}
					},
					liveMembers,
				);

				// Broadcast response completion over IPC
				ipcServer?.broadcast({
					action: "bulk_verification_response",
					requestId,
					data: {
						guildId: guild.guildId,
						...stats,
					},
				});

				logger.info(
					`[Guild ${guild.guildId}] Scheduled verification completed: ${stats.processed} processed, ${stats.updated} updated, ${stats.errors} errors.`,
				);
			} else {
				const remainingHours = (
					(intervalMs - elapsedMs) /
					(60 * 60 * 1000)
				).toFixed(1);
				logger.info(
					`[Guild ${guild.guildId}] Verification cron not due yet. Next run in ~${remainingHours}h (Interval: ${intervalHours}h).`,
				);
			}
		}

		finishLog();
	} catch (error) {
		logger.error("Error running background verification worker:", error);
	}
}

/**
 * Starts the periodic verification worker.
 */
export function startVerification(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: 3600, // Runs hourly check
		initialDelayMs: options?.initialDelayMs,
		handler: runVerificationWorker,
	});
}
