import net from "node:net";
import { Logger } from "@sentinel/utils";
import { IPC_SOCKET_PATHS, IpcClient } from "@sentinel/utils/ipc";
import { broadcastPersonalBountiesState } from "../routes/ws-personal-bounties";
import { broadcastWarUpdate } from "../routes/ws-subversive-war";
import {
	type CurrentWarInfo,
	type RankedWarOpponent,
	subversiveTargetCache,
} from "./subversive-target-cache";
import { subversiveWarEventManager } from "./subversive-war-events";

const logger = new Logger("API", "SchedulerIPC");

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
			if (message.action === "personal_bounties_updated" && message.data) {
				broadcastPersonalBountiesState(message.data);
			}
			if (message.action === "subversive_war_updated" && message.data) {
				const payload = message.data as {
					war?: CurrentWarInfo;
					opponents?: RankedWarOpponent[];
				};
				if (payload.war) {
					subversiveTargetCache.setWarState(payload.war);
				}
				if (Array.isArray(payload.opponents)) {
					subversiveTargetCache.setWarOpponents(payload.opponents);
				}
				broadcastWarUpdate();
				subversiveWarEventManager.notifyUpdate();
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

/**
 * Dispatches an IPC request to the Scheduler to clear the in-memory evaluated ranked wars cache.
 */
export async function notifySchedulerResetRecruitment(): Promise<boolean> {
	try {
		const delivered = await notifySchedulerAction(
			"reset_subversive_recruitment",
		);
		if (!delivered) {
			logger.warn(
				"Could not reach scheduler via IPC to clear recruitment war cache.",
			);
		}
		return delivered;
	} catch (err) {
		logger.error("Failed to send recruitment cache reset IPC:", err);
		return false;
	}
}

/**
 * Dispatches a defeat event to the Scheduler so a defeated/hospitalized target
 * is instantly moved out of readyTargets in worker memory.
 */
export async function notifyBountyDefeated(
	targetId: number,
	outcome?: string,
): Promise<boolean> {
	try {
		return await notifySchedulerAction("personal_bounty_defeated", {
			targetId,
			outcome,
		});
	} catch (err) {
		logger.warn("Failed to notify scheduler of bounty defeat:", err);
		return false;
	}
}
