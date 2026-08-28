import net from "node:net";
import { Logger } from "@sentinel/utils";
import { IPC_SOCKET_PATHS, IpcClient } from "@sentinel/utils/ipc";
import { broadcastBattlestatsLedgerState } from "../routes/ws-battlestats-ledger";
import { broadcastCrimeLedgerState } from "../routes/ws-crime-ledger";
import { broadcastStockLedgerState } from "../routes/ws-stocks-ledger";

const logger = new Logger("API", "SchedulerIPC");

/** Worker registry name of the personal log manager worker in the scheduler. */
export const LOG_MANAGER_WORKER_NAME = "personal:log_manager";

let ipcClient: IpcClient | null = null;

/**
 * Initializes a background IPC client that receives state broadcast events
 * from the scheduler and forwards them to active WebSockets.
 */
export function initSchedulerIpcListener(): void {
	if (ipcClient) return;
	try {
		ipcClient = new IpcClient(IPC_SOCKET_PATHS.worker, (msg: unknown) => {
			if (!msg || typeof msg !== "object") return;
			const message = msg as {
				action?: string;
				data?: Record<string, unknown>;
			};
			if (message.action === "crime_ledger_state_updated" && message.data) {
				broadcastCrimeLedgerState(message.data);
			}
			if (
				(message.action === "battlestats_ledger_state_updated" ||
					message.action === "gym_ledger_state_updated") &&
				message.data
			) {
				broadcastBattlestatsLedgerState(message.data);
			}
			if (message.action === "stocks_ledger_state_updated" && message.data) {
				broadcastStockLedgerState(message.data);
			}
		});
	} catch (err) {
		logger.warn(
			"Failed to initialize background IPC client for scheduler events:",
			err,
		);
	}
}

/**
 * Sends a fire-and-forget IPC message to the Scheduler over its Unix domain
 * socket. Resolves `true` if the message was delivered, `false` if the
 * scheduler is offline or did not acknowledge within the timeout. Failure is
 * non-fatal: the scheduler still picks up DB-persisted state/jobs on its next
 * cadence.
 */
function notifySchedulerAction(
	action: string,
	data?: Record<string, unknown>,
	timeoutMs = 1000,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const client = net.createConnection(IPC_SOCKET_PATHS.worker);

		const finish = (delivered: boolean) => {
			if (settled) return;
			settled = true;
			client.destroy();
			resolve(delivered);
		};

		const timeout = setTimeout(() => finish(false), timeoutMs);

		client.on("connect", () => {
			client.write(
				`${JSON.stringify({ action, ...(data ? { data } : {}) })}\n`,
				() => {
					clearTimeout(timeout);
					finish(true);
				},
			);
		});

		client.on("error", () => {
			clearTimeout(timeout);
			finish(false);
		});
	});
}

/**
 * Sends a fire-and-forget `force_run_worker` IPC message to the Scheduler.
 * The scheduler sets `forceRun` on the worker schedule row and immediately
 * triggers the active in-memory runner.
 */
export function notifySchedulerForceRun(
	workerName: string,
	timeoutMs = 1000,
): Promise<boolean> {
	return notifySchedulerAction("force_run_worker", { workerName }, timeoutMs);
}

/**
 * Requests the Scheduler to reset the Log Manager state through the worker
 * itself. The worker applies the reset atomically at the start of its next
 * sync cycle (preserving backfill cursors), so it is race-safe even while a
 * cycle is currently executing. The DB-persisted reset written by the API acts
 * as a fallback if the scheduler is offline.
 */
export async function requestLogManagerReset(): Promise<boolean> {
	try {
		const delivered = await notifySchedulerAction("reset_log_manager");
		if (!delivered) {
			logger.warn(
				"Could not reach scheduler via IPC; log manager reset will apply on its next startup/cadence from persisted state.",
			);
		}
		return delivered;
	} catch (err) {
		logger.error("Failed to send log manager reset IPC:", err);
		return false;
	}
}

/**
 * Nudges the scheduler to run a log manager sync cycle immediately
 * (forward poll + backfill burst + pending resync job processing).
 */
export async function triggerLogManagerSync(): Promise<boolean> {
	try {
		const delivered = await notifySchedulerForceRun(LOG_MANAGER_WORKER_NAME);
		if (!delivered) {
			logger.warn(
				"Could not reach scheduler via IPC; log manager will pick up state on its next cadence.",
			);
		}
		return delivered;
	} catch (err) {
		logger.error("Failed to send log manager IPC trigger:", err);
		return false;
	}
}

/**
 * Dispatches an IPC request to the Scheduler to re-initialize the crime ledger:
 * wipes crime_logs and regenerates all records from personal_logs.
 */
export async function requestCrimeLedgerReinitialize(): Promise<boolean> {
	try {
		const delivered = await notifySchedulerAction("reinitialize_crime_ledger");
		if (!delivered) {
			logger.warn(
				"Could not reach scheduler via IPC; crime ledger reinitialization will run on scheduler startup.",
			);
		}
		return delivered;
	} catch (err) {
		logger.error("Failed to send crime ledger reinitialization IPC:", err);
		return false;
	}
}

/**
 * Dispatches an IPC request to the Scheduler to re-initialize the battlestats ledger:
 * wipes battlestats_ledgers and regenerates all records from personal_logs.
 */
export async function requestBattlestatsLedgerReinitialize(): Promise<boolean> {
	try {
		const delivered = await notifySchedulerAction(
			"reinitialize_battlestats_ledger",
		);
		if (!delivered) {
			logger.warn(
				"Could not reach scheduler via IPC; battlestats ledger reinitialization will run on scheduler startup.",
			);
		}
		return delivered;
	} catch (err) {
		logger.error(
			"Failed to send battlestats ledger reinitialization IPC:",
			err,
		);
		return false;
	}
}

export const requestGymLedgerReinitialize =
	requestBattlestatsLedgerReinitialize;

/**
 * Dispatches an IPC request to the Scheduler to re-initialize the stocks ledger:
 * wipes stock_ledgers & stock_dividend ledger_events and regenerates all records from personal_logs.
 */
export async function requestStocksLedgerReinitialize(): Promise<boolean> {
	try {
		const delivered = await notifySchedulerAction("reinitialize_stocks_ledger");
		if (!delivered) {
			logger.warn(
				"Could not reach scheduler via IPC; stocks ledger reinitialization will run on scheduler startup.",
			);
		}
		return delivered;
	} catch (err) {
		logger.error("Failed to send stocks ledger reinitialization IPC:", err);
		return false;
	}
}

/**
 * Dispatches an IPC request to the Scheduler to initialize / snapshot wealth tracking.
 */
export async function requestWealthInit(timestamp?: number): Promise<boolean> {
	try {
		const delivered = await notifySchedulerAction(
			"reinitialize_wealth",
			timestamp !== undefined ? { timestamp } : undefined,
		);
		if (!delivered) {
			logger.warn(
				"Could not reach scheduler via IPC; wealth initialization will run on scheduler startup.",
			);
		}
		return delivered;
	} catch (err) {
		logger.error("Failed to send wealth initialization IPC:", err);
		return false;
	}
}
