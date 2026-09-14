import { db, workerSchedules } from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { reinitializeBattlestatsLedger } from "../../../workers/personal/battlestats";
import { reinitializeCrimeLedger } from "../../../workers/personal/crimes";
import { requestResetLogManager } from "../../../workers/personal/log-manager";
import { reinitializeStocksLedger } from "../../../workers/personal/stocks";
import { initWealthTracking } from "../../../workers/personal/wealth";
import { resetRecruitmentCache } from "../../../workers/subversive/recruitment-worker";
import { triggerWorkerByName } from "../../scheduler";
import type { IpcActionHandler, IpcHandlerContext } from "../types";

const logger = new Logger("SchedulerIPC", "WorkerControls");

export const handleResetSubversiveRecruitment: IpcActionHandler = () => {
	logger.info(
		"Received reset_subversive_recruitment IPC command. Clearing evaluated wars cache...",
	);
	resetRecruitmentCache();
};

export const handleResetLogManager: IpcActionHandler = () => {
	requestResetLogManager();
	logger.info("Queued Log Manager state reset request.");

	const triggered = triggerWorkerByName("personal:log_manager");
	if (triggered) {
		logger.info("Triggered Log Manager runner to apply the reset immediately.");
	} else {
		logger.warn(
			"Log Manager runner not active; reset will apply on its next cycle after startup.",
		);
	}
};

export const handleReinitializeCrimeLedger: IpcActionHandler = () => {
	logger.info(
		"Received reinitialize_crime_ledger IPC command. Running full rebuild in scheduler...",
	);
	reinitializeCrimeLedger().catch((err) => {
		logger.error("Error executing crime ledger reinitialization:", err);
	});
};

export const handleReinitializeBattlestatsLedger: IpcActionHandler = () => {
	logger.info(
		"Received reinitialize_battlestats_ledger IPC command. Running full rebuild in scheduler...",
	);
	reinitializeBattlestatsLedger().catch((err) => {
		logger.error("Error executing battlestats ledger reinitialization:", err);
	});
};

export const handleReinitializeStocksLedger: IpcActionHandler = () => {
	logger.info(
		"Received reinitialize_stocks_ledger IPC command. Running full rebuild in scheduler...",
	);
	reinitializeStocksLedger().catch((err) => {
		logger.error("Error executing stocks ledger reinitialization:", err);
	});
};

export const handleReinitializeWealth: IpcActionHandler = (
	ctx: IpcHandlerContext,
) => {
	const message = ctx.message;
	const data =
		"data" in message
			? (message.data as { timestamp?: number } | undefined)
			: undefined;
	const initTs = data?.timestamp;
	logger.info(
		`Received reinitialize_wealth IPC command with timestamp: ${initTs ?? "now"}. Running full baseline snapshot in scheduler...`,
	);
	initWealthTracking(initTs).catch((err) => {
		logger.error("Error executing wealth initialization:", err);
	});
};

export const handleForceRunWorker: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const message = ctx.message;
	if (!("data" in message) || !message.data) return;
	const data = message.data as { workerName?: string };
	const workerName = data.workerName;
	if (!workerName) return;

	try {
		await db
			.insert(workerSchedules)
			.values({ id: workerName, forceRun: true })
			.onConflictDoUpdate({
				target: workerSchedules.id,
				set: { forceRun: true },
			});

		logger.info(`Set forceRun = true for worker '${workerName}'.`);

		const triggered = triggerWorkerByName(workerName);
		if (triggered) {
			logger.info(
				`Triggered active in-memory runner for '${workerName}' immediately.`,
			);
		}
	} catch (err) {
		logger.error(`Failed to force trigger worker '${workerName}':`, err);
	}
};
