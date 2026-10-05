import { and, db, eq, guildConfigs, isTargetGuild } from "@sentinel/database";
import { Logger } from "@sentinel/utils";
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
/**
 * Execution budget for one hourly verification cycle.
 *
 * Each due guild costs a blocking IPC round trip to the bot (10s timeout with 2
 * retries, so ~34.5s worst case) followed by a full member sweep, and guilds are
 * processed sequentially. The runner's 5-minute cron default is too tight for
 * several guilds, and on timeout it would retry while this handler was still
 * running.
 */
export const VERIFICATION_TIMEOUT_MS = 15 * 60_000;

/**
 * Point at which a cycle stops starting new guild sweeps.
 *
 * Guilds left over are picked up by the next hourly run. Stopping cleanly is
 * strictly better than being killed mid-sweep: `lastVerifyCronAt` is only
 * updated after the roster arrives, so an abandoned guild simply retries, while
 * a killed cycle also discards the progress broadcasting for the running guild.
 */
const VERIFICATION_CYCLE_BUDGET_MS = 12 * 60_000;

export async function runVerificationWorker(
	signal?: AbortSignal,
): Promise<void> {
	const finishLog = logger.time();
	const cycleStartedAtMs = Date.now();

	try {
		const guilds = await db.query.guildConfigs.findMany({
			where: and(
				eq(guildConfigs.verifyCron, true),
				eq(guildConfigs.moduleVerification, true),
			),
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
			if (signal?.aborted) {
				logger.warn(
					`Verification cycle aborted before guild ${guild.guildId}; remaining guilds run next cycle.`,
				);
				break;
			}

			if (Date.now() - cycleStartedAtMs >= VERIFICATION_CYCLE_BUDGET_MS) {
				logger.warn(
					`Verification cycle budget (${VERIFICATION_CYCLE_BUDGET_MS}ms) reached; remaining guilds deferred to the next hourly run.`,
				);
				break;
			}

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
		// Propagate so the runner records the failure and applies its backoff.
		throw error;
	}
}

/**
 * Starts the periodic verification worker scheduled to run at the top of every hour.
 */
export function startVerification(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "0 * * * *", timezone: "Etc/UTC" },
		timeoutMs: VERIFICATION_TIMEOUT_MS,
		initialDelayMs: options?.initialDelayMs,
		handler: async (signal) => {
			await runVerificationWorker(signal);
		},
	});
}
