import { Logger } from "@sentinel/utils";
import { startFactionMonitoring } from "./bot/monitoring";
import { startVerification } from "./bot/verification";
import { startBattlestatsLedger } from "./personal/battlestats";
import { startCompanySync } from "./personal/company";
import { startCrimesLedger } from "./personal/crimes";
import { startLogManager } from "./personal/log-manager";
import { startPersonalReferenceSync } from "./personal/references";
import { startPersonalStateSync } from "./personal/states";
import { startStocksLedger } from "./personal/stocks";
// import { startWealthModule } from "./personal/wealth";
import { startSystemMaintenance } from "./system/maintenance";
import { startTornAbroadStocks } from "./torn/abroad-stocks";
import { startTornReferences } from "./torn/references";

import { startTornTerritoryActivity } from "./torn/territory-activity";
import { startTornTerritoryData } from "./torn/territory-data";

const logger = new Logger("Scheduler", "WorkerRegistry");

export type WorkerStartOptions = {
	initialDelayMs?: number;
};

export type WorkerStarter = (options?: WorkerStartOptions) => void;

/**
 * List of registered background worker starter functions.
 * Add workers here in the exact order you want them to boot.
 */
const WORKERS: WorkerStarter[] = [
	startSystemMaintenance,
	startTornTerritoryData,
	startTornReferences,
	startTornAbroadStocks,
	startTornTerritoryActivity,
	startVerification,
	startFactionMonitoring,
	startLogManager,
	startPersonalStateSync,
	startPersonalReferenceSync,
	startCrimesLedger,
	startBattlestatsLedger,
	startStocksLedger,
	startCompanySync,
	// startWealthModule,
];

const DEFAULT_STAGGER_MS = 500;

/**
 * Starts all registered background workers with a staggered boot delay
 * to prevent initial CPU and memory spikes.
 */
export async function startRegisteredWorkers(options?: {
	staggerMs?: number;
}): Promise<number> {
	const staggerMs = options?.staggerMs ?? DEFAULT_STAGGER_MS;

	if (WORKERS.length === 0) {
		logger.info(
			"No background workers currently registered in worker registry.",
		);
		return 0;
	}

	logger.info(
		`Starting ${WORKERS.length} workers with ${staggerMs}ms stagger delay...`,
	);

	let started = 0;
	for (const start of WORKERS) {
		const initialDelayMs = started * staggerMs;
		start({ initialDelayMs });
		started++;
	}

	return started;
}
