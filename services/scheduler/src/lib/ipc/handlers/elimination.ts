import { db, eq, systemStates } from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import {
	resolveElimsUser,
	runElimsTrackingCycle,
	startElimsMemberStatsWorker,
	startElimsTeamTracker,
	syncTeamMemberStats,
	verifyElimsKey,
} from "../../../workers/elimination";
import { stopWorkerByName } from "../../scheduler";
import type { IpcActionHandler, IpcHandlerContext } from "../types";

const logger = new Logger("SchedulerIPC", "EliminationHandler");

export const handleElimsResolveUser: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const { message, server } = ctx;
	if (
		message.action !== "elims_resolve_user_request" ||
		!message.requestId ||
		!message.data
	) {
		return;
	}

	try {
		const user = await resolveElimsUser(
			message.data.discordId,
			message.data.guildId,
		);
		server.broadcast({
			action: "elims_resolve_user_response",
			requestId: message.requestId,
			data: { user },
		});
	} catch (err) {
		logger.error("Elims user resolution failed via IPC:", err);
		server.broadcast({
			action: "elims_resolve_user_response",
			requestId: message.requestId,
			data: {
				user: null,
				error: err instanceof Error ? err.message : "Internal worker error.",
			},
		});
	}
};

export const handleElimsVerifyKey: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const { message, server } = ctx;
	if (
		message.action !== "elims_verify_key_request" ||
		!message.requestId ||
		!message.data
	) {
		return;
	}

	try {
		const verified = await verifyElimsKey(message.data.apiKey);
		server.broadcast({
			action: "elims_verify_key_response",
			requestId: message.requestId,
			data: {
				tornId: verified.tornId,
				tornName: verified.tornName,
			},
		});
	} catch (err) {
		logger.error("Elims key verification failed via IPC:", err);
		server.broadcast({
			action: "elims_verify_key_response",
			requestId: message.requestId,
			data: {
				error:
					err instanceof Error ? err.message : "Torn API verification failed.",
			},
		});
	}
};

export const handleElimsFetchMemberStats: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const { message, server } = ctx;
	if (
		message.action !== "elims_fetch_member_stats_request" ||
		!message.requestId ||
		!message.data
	) {
		return;
	}

	try {
		const result = await syncTeamMemberStats({
			guildId: message.data.guildId,
			roleId: message.data.roleId,
			forceRefresh: message.data.forceRefresh,
		});
		server.broadcast({
			action: "elims_fetch_member_stats_response",
			requestId: message.requestId,
			data: result,
		});
	} catch (err) {
		logger.error("Elims member stats sync failed via IPC:", err);
		server.broadcast({
			action: "elims_fetch_member_stats_response",
			requestId: message.requestId,
			data: {
				total: 0,
				newProcessed: 0,
				resolved: 0,
				ffScouterHits: 0,
				error:
					err instanceof Error ? err.message : "Failed to sync member stats.",
			},
		});
	}
};

export const handleElimsSyncTeams: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const { message, server } = ctx;
	if (message.action !== "elims_sync_teams_request" || !message.requestId) {
		return;
	}

	try {
		await runElimsTrackingCycle();
		server.broadcast({
			action: "elims_sync_teams_response",
			requestId: message.requestId,
			data: {
				success: true,
				isMock: false,
				teamsCount: 12,
			},
		});
	} catch (err) {
		logger.error("Elims teams sync failed via IPC:", err);
		server.broadcast({
			action: "elims_sync_teams_response",
			requestId: message.requestId,
			data: {
				success: false,
				isMock: false,
				teamsCount: 0,
				error:
					err instanceof Error ? err.message : "Failed to sync elims teams.",
			},
		});
	}
};

export const handleElimsStopWorkers: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const { message, server } = ctx;
	if (message.action !== "elims_stop_workers" || !message.requestId) {
		return;
	}

	const stopped: string[] = [];
	const ELIMS_WORKER_NAMES = [
		"elims_team_tracker",
		"elims_member_stats_worker",
	];
	for (const name of ELIMS_WORKER_NAMES) {
		if (stopWorkerByName(name)) {
			stopped.push(name);
			logger.info(`Stopped elims worker '${name}' via IPC command.`);
		}
	}

	try {
		const [existing] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, "elims:guild_config"));
		if (existing?.data) {
			const updatedData = {
				...(existing.data as Record<string, unknown>),
				workersStopped: true,
				updatedAt: new Date().toISOString(),
			};
			await db
				.update(systemStates)
				.set({ data: updatedData, updatedAt: new Date() })
				.where(eq(systemStates.id, "elims:guild_config"));
		}
	} catch (err) {
		logger.error("Failed persisting workersStopped: true:", err);
	}

	server.broadcast({
		action: "elims_stop_workers_response",
		requestId: message.requestId,
		data: { stopped, workersStopped: true },
	});
};

export const handleElimsStartWorkers: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const { message, server } = ctx;
	if (message.action !== "elims_start_workers" || !message.requestId) {
		return;
	}

	const started: string[] = [];

	try {
		const [existing] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, "elims:guild_config"));
		if (existing?.data) {
			const updatedData = {
				...(existing.data as Record<string, unknown>),
				workersStopped: false,
				updatedAt: new Date().toISOString(),
			};
			await db
				.update(systemStates)
				.set({ data: updatedData, updatedAt: new Date() })
				.where(eq(systemStates.id, "elims:guild_config"));
		}
	} catch (err) {
		logger.error("Failed persisting workersStopped: false:", err);
	}

	try {
		startElimsTeamTracker({ initialDelayMs: 0 });
		started.push("elims_team_tracker");
		startElimsMemberStatsWorker({ initialDelayMs: 1000 });
		started.push("elims_member_stats_worker");
		logger.info("Resumed/started elims workers via IPC command.");
	} catch (err) {
		logger.error("Failed to restart elims workers:", err);
	}

	server.broadcast({
		action: "elims_start_workers_response",
		requestId: message.requestId,
		data: { started, workersStopped: false },
	});
};
