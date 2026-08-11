import { db, eq, guildConfigs } from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { startEventDrivenRunner } from "../../lib/scheduler";
import { runBulkGuildVerification } from "../../lib/verification";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "bot:verification";
const logger = new Logger(WORKER_NAME);

/**
 * Periodically checks for guilds with `verifyCron` enabled and triggers verification runs.
 */
export async function runVerificationWorker(): Promise<void> {
	const finishLog = logger.time();

	try {
		const guilds = await db.query.guildConfigs.findMany({
			where: eq(guildConfigs.verifyCron, true),
		});

		const activeGuilds = guilds.filter((guild) =>
			guild.enabledModules.includes("verification"),
		);

		const now = new Date();

		for (const guild of activeGuilds) {
			const intervalMs = (guild.verifyCronInterval || 24) * 60 * 60 * 1000;
			const lastRun = guild.lastVerifyCronAt?.getTime() || 0;

			if (now.getTime() - lastRun >= intervalMs) {
				await db
					.update(guildConfigs)
					.set({
						lastVerifyCronAt: now,
						updatedAt: now,
					})
					.where(eq(guildConfigs.guildId, guild.guildId));

				// Execute optimized bulk verification sweep for the guild
				logger.info(
					`Running cron verification sweep for guild ${guild.guildId}...`,
				);
				const stats = await runBulkGuildVerification(guild.guildId, "cron");
				logger.info(
					`Cron verification completed for guild ${guild.guildId}: ${stats.processed} processed, ${stats.updated} updated, ${stats.errors} errors.`,
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
