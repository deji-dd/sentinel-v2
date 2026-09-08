import { db, eq, systemStates } from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { ScheduledRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import { syncTeamMemberStats } from "./member-stats-sync";

const logger = new Logger("Scheduler", "ElimsMemberStatsWorker");
const ELIMS_CONFIG_ID = "elims:guild_config";
const STAT_ROLES_CONFIG_ID = "elims:stat_roles";

/**
 * Periodically syncs guild members with the configured team role:
 * 1. Discovers new members with the role and fetches their Torn ID & FFScouter stats.
 * 2. Prunes any records in elims_member_stats for members who no longer possess the role.
 * 3. Instructs the Discord bot via IPC to auto-assign bracket roles based on current battle stats.
 */
export async function runElimsMemberStatsCycle(): Promise<void> {
	try {
		const [existingConfig] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_CONFIG_ID));

		const configData = existingConfig?.data as
			| {
					guildId?: string;
					teamRoleId?: string | null;
					autoSyncTeamStats?: boolean;
			  }
			| undefined;

		if (!configData?.guildId) {
			logger.debug(
				"No elimination guild configured. Skipping automated stats sync.",
			);
			return;
		}

		if (configData.autoSyncTeamStats === false) {
			logger.debug("Automated team stats sync is explicitly disabled.");
			return;
		}

		if (!configData.teamRoleId) {
			logger.debug(
				"No team role ID configured for elimination guild. Skipping sync.",
			);
			return;
		}

		logger.info(
			`Executing automated member stats sync for guild ${configData.guildId} (role: ${configData.teamRoleId})...`,
		);

		// 1. Sync member stats & auto-prune members who no longer hold the role
		const syncResult = await syncTeamMemberStats({
			guildId: configData.guildId,
			roleId: configData.teamRoleId,
		});

		logger.info(
			`Automated stats sync complete: ${syncResult.total} members in role, ${syncResult.newProcessed} processed, ${syncResult.resolved} resolved, ${syncResult.ffScouterHits} stat hits.`,
		);

		// 2. Fetch stat bracket mappings and trigger Discord bot role assignments
		const [existingRolesConfig] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, STAT_ROLES_CONFIG_ID));

		const rolesData = existingRolesConfig?.data as
			| { mappings?: Record<string, string> }
			| undefined;

		if (rolesData?.mappings && Object.keys(rolesData.mappings).length > 0) {
			logger.info("Triggering automated stat bracket role assignments...");
			const ipcServer = getActiveIpcServer();
			if (ipcServer) {
				ipcServer.broadcast({
					action: "elims_assign_stat_roles",
					data: {
						guildId: configData.guildId,
						roleMappings: rolesData.mappings,
					},
				});
			}
		}
	} catch (err) {
		logger.error("Error in automated member stats cycle:", err);
	}
}

export const startElimsMemberStatsWorker: WorkerStarter = (options?: {
	initialDelayMs?: number;
}) => {
	const runner = new ScheduledRunner({
		worker: "elims_member_stats_worker",
		defaultCadenceSeconds: 900, // 15 minutes
		initialDelayMs: options?.initialDelayMs ?? 5000,
		handler: runElimsMemberStatsCycle,
	});

	runner.start().catch((err) => {
		logger.error("Failed to start Elims Member Stats worker:", err);
	});
};
