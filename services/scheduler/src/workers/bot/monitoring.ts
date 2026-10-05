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
 * The monitoring configuration is human-timescale data: it changes when an admin
 * toggles a module or points a faction at a revives channel. Re-reading both
 * tables on every 60s cycle was pure overhead, so the resolved monitor list is
 * memoised. The TTL is short enough that a config change takes effect within a
 * minute anyway, matching the worker's own cadence.
 */
const MONITOR_CONFIG_TTL_MS = 60_000;
let cachedTargetMonitors:
	| (typeof guildMonitoredFactions.$inferSelect)[]
	| null = null;
let cachedTargetMonitorsAt = 0;

/** Test seam: drops the memoised monitor configuration. */
export function clearMonitoringConfigCache(): void {
	cachedTargetMonitors = null;
	cachedTargetMonitorsAt = 0;
}

async function loadTargetMonitors(): Promise<
	(typeof guildMonitoredFactions.$inferSelect)[]
> {
	const now = Date.now();
	if (
		cachedTargetMonitors &&
		now - cachedTargetMonitorsAt < MONITOR_CONFIG_TTL_MS
	) {
		return cachedTargetMonitors;
	}

	const guilds = await db.query.guildConfigs.findMany({
		where: eq(guildConfigs.moduleMonitoring, true),
	});

	const activeGuildIds = new Set(
		guilds
			.filter((guild) => isTargetGuild(guild.guildId))
			.map((g) => g.guildId),
	);

	if (activeGuildIds.size === 0) {
		cachedTargetMonitors = [];
		cachedTargetMonitorsAt = now;
		return cachedTargetMonitors;
	}

	// Find all active monitors with a configured revives channel
	const monitors = await db.query.guildMonitoredFactions.findMany({
		where: and(
			eq(guildMonitoredFactions.revivesEnabled, true),
			isNotNull(guildMonitoredFactions.revivesChannelId),
		),
	});

	cachedTargetMonitors = monitors.filter((m) => activeGuildIds.has(m.guildId));
	cachedTargetMonitorsAt = now;
	return cachedTargetMonitors;
}

/**
 * Periodically checks for target guilds with `moduleMonitoring` enabled and active
 * monitored factions with configured channels, then triggers bot Discord embeds updates.
 */
export async function runFactionMonitoringWorker(): Promise<void> {
	const finishLog = logger.time();

	try {
		const targetMonitors = await loadTargetMonitors();

		if (targetMonitors.length === 0) {
			finishLog();
			return;
		}

		logger.info(
			`Dispatching revives monitoring sync for ${targetMonitors.length} active faction monitor(s) across ${new Set(targetMonitors.map((m) => m.guildId)).size} guild(s)...`,
		);

		const ipcServer = getActiveIpcServer();
		if (!ipcServer) {
			logger.warn(
				"Scheduler IPC server not initialized; could not dispatch sync_faction_monitoring.",
			);
			finishLog();
			return;
		}

		// Fetched as one batch rather than awaited one faction at a time: the
		// sequential loop made one cycle as long as the sum of every fetch, so a
		// dozen monitored factions could never finish inside the cadence.
		// `executeBatchSettled` resolves the key pool once and keeps a per-faction
		// failure from aborting the rest of the batch.
		const results = await tornApi.executeBatchSettled(
			"/faction/{id}/members",
			targetMonitors,
			(monitor) => ({ pathParams: { id: monitor.factionId } }),
		);

		for (let i = 0; i < results.length; i++) {
			const monitor = targetMonitors[i];
			if (!monitor) continue;

			const result = results[i];
			if (!result || result.status === "rejected") {
				logger.error(
					`Failed to fetch live members for monitored faction ${monitor.factionId} (guild ${monitor.guildId}):`,
					result?.status === "rejected" ? result.reason : "unknown error",
				);
				continue;
			}

			const res = result.value as FactionMembersResponse;
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
