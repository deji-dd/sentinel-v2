import {
	and,
	db,
	eq,
	guildConfigs,
	guildMonitoredFactions,
	isNotNull,
	isTargetGuild,
} from "@sentinel/database";
import type { FactionMembersResponse } from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "bot:monitoring";
const logger = new Logger("Scheduler", "Monitoring");

/**
 * Periodically checks for target guilds with `moduleMonitoring` enabled and active
 * monitored factions with configured channels, then triggers bot Discord embeds updates.
 */
export async function runFactionMonitoringWorker(): Promise<void> {
	const finishLog = logger.time();

	try {
		const guilds = await db.query.guildConfigs.findMany({
			where: eq(guildConfigs.moduleMonitoring, true),
		});

		const activeGuilds = guilds.filter((guild) => isTargetGuild(guild.guildId));

		if (activeGuilds.length === 0) {
			finishLog();
			return;
		}

		const activeGuildIds = new Set(activeGuilds.map((g) => g.guildId));

		// Find all active monitors with a configured revives channel
		const monitors = await db.query.guildMonitoredFactions.findMany({
			where: and(
				eq(guildMonitoredFactions.revivesEnabled, true),
				isNotNull(guildMonitoredFactions.revivesChannelId),
			),
		});

		const targetMonitors = monitors.filter((m) =>
			activeGuildIds.has(m.guildId),
		);

		if (targetMonitors.length === 0) {
			finishLog();
			return;
		}

		logger.info(
			`Dispatching revives monitoring sync for ${targetMonitors.length} active faction monitor(s) across ${activeGuilds.length} guild(s)...`,
		);

		const ipcServer = getActiveIpcServer();
		if (!ipcServer) {
			logger.warn(
				"Scheduler IPC server not initialized; could not dispatch sync_faction_monitoring.",
			);
			finishLog();
			return;
		}

		for (const monitor of targetMonitors) {
			try {
				const res = (await tornApi.get("/faction/{id}/members", {
					pathParams: { id: monitor.factionId },
				})) as FactionMembersResponse;

				ipcServer.broadcast({
					action: "sync_faction_monitoring",
					data: {
						guildId: monitor.guildId,
						monitorId: monitor.id,
						factionId: monitor.factionId,
						factionName: monitor.factionName || `Faction ${monitor.factionId}`,
						members: res.members ?? [],
					},
				});
			} catch (err) {
				logger.error(
					`Failed to fetch live members for monitored faction ${monitor.factionId} (guild ${monitor.guildId}):`,
					err,
				);
			}
		}

		finishLog();
	} catch (error) {
		logger.error("Error running background faction monitoring worker:", error);
	}
}

/**
 * Starts the periodic faction monitoring worker (every 60 seconds).
 */
export function startFactionMonitoring(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: 60, // 1 minute interval as requested
		initialDelayMs: options?.initialDelayMs,
		handler: runFactionMonitoringWorker,
	});
}
