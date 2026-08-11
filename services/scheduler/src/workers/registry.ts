import { Logger } from "@sentinel/utils";
import { startVerification } from "./bot/verification";
import { startPondSimulation } from "./fyp/pond-simulation";
import { startSystemMaintenance } from "./system/maintenance";
import { startTornAbroadStocks } from "./torn/abroad-stocks";
import { startTornReferences } from "./torn/references";
import { startTornTerritoryActivity } from "./torn/territory-activity";
import { startTornTerritoryData } from "./torn/territory-data";

const logger = new Logger("WorkerRegistry");

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
	startPondSimulation,
	startTornTerritoryData,
	startTornReferences,
	startTornAbroadStocks,
	startTornTerritoryActivity,
	startVerification,
];

const DEFAULT_STAGGER_MS = 2500;

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
