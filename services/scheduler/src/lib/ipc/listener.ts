import type { IpcMessage } from "@sentinel/schemas";
import { Logger } from "@sentinel/utils";
import { IPC_SOCKET_PATHS, IpcServer } from "@sentinel/utils/ipc";
import {
	handleGuildMembersResponse,
	requestGuildMembersFromBot,
} from "./handlers/bot";
import {
	handleElimsFetchMemberStats,
	handleElimsResolveUser,
	handleElimsStartWorkers,
	handleElimsStopWorkers,
	handleElimsSyncTeams,
	handleElimsVerifyKey,
} from "./handlers/elimination";
import {
	handleBulkVerificationRequest,
	handleVerificationRequest,
} from "./handlers/verification";
import {
	handleForceRunWorker,
	handleReinitializeBattlestatsLedger,
	handleReinitializeCrimeLedger,
	handleReinitializeStocksLedger,
	handleReinitializeWealth,
	handleResetLogManager,
} from "./handlers/worker-controls";
import { setActiveIpcServer } from "./server";
import type { IpcActionHandler } from "./types";

export { requestGuildMembersFromBot };

const logger = new Logger("SchedulerIPC");

/**
 * Dispatch registry mapping incoming IPC action names to their modular domain handlers.
 */
const ACTION_HANDLERS: Record<string, IpcActionHandler> = {
	// Verification
	verification_request: handleVerificationRequest,
	bulk_verification_request: handleBulkVerificationRequest,

	// Bot RPC callbacks
	guild_members_response: handleGuildMembersResponse,

	// Elimination RPCs & Worker Lifecycle
	elims_resolve_user_request: handleElimsResolveUser,
	elims_verify_key_request: handleElimsVerifyKey,
	elims_fetch_member_stats_request: handleElimsFetchMemberStats,
	elims_sync_teams_request: handleElimsSyncTeams,
	elims_stop_workers: handleElimsStopWorkers,
	elims_start_workers: handleElimsStartWorkers,

	// Worker Controls & Historical Ledger Rebuilds
	reset_log_manager: handleResetLogManager,
	reinitialize_crime_ledger: handleReinitializeCrimeLedger,
	reinitialize_battlestats_ledger: handleReinitializeBattlestatsLedger,
	reinitialize_gym_ledger: handleReinitializeBattlestatsLedger,
	reinitialize_stocks_ledger: handleReinitializeStocksLedger,
	reinitialize_wealth: handleReinitializeWealth,
	force_run_worker: handleForceRunWorker,
};

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

			const handler = ACTION_HANDLERS[message.action];
			if (handler) {
				try {
					await handler({ message, server: ipcServer });
				} catch (err) {
					logger.error(`Error handling IPC action '${message.action}':`, err);
				}
			} else {
				logger.debug(`Unhandled IPC action received: ${message.action}`);
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
