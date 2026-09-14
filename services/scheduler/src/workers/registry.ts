import { Logger } from "@sentinel/utils";
import { startFactionMonitoring } from "./bot/monitoring";
import { startVerification } from "./bot/verification";
import {
	startElimsMemberStatsWorker,
	startElimsTeamTracker,
} from "./elimination";
import { startBattlestatsLedger } from "./personal/battlestats";
import { startCompanySync } from "./personal/company";
import { startCrimesLedger } from "./personal/crimes";
import { startLogManager } from "./personal/log-manager";
import { startPersonalReferenceSync } from "./personal/references";
import { startPersonalStateSync } from "./personal/states";
import { startStocksLedger } from "./personal/stocks";
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

export type WorkerDefinition = {
	id: string;
	description: string;
	start: WorkerStarter;
	enabled?: boolean;
};

/**
 * Declarative registry of all background workers.
 */
export const REGISTERED_WORKERS: WorkerDefinition[] = [
	{
		id: "system:maintenance",
		description:
			"Daily table retention pruning and personal ledger historical reconciliation sweeps",
		start: startSystemMaintenance,
	},
	{
		id: "torn:territory_data",
		description: "Daily territory blueprints extraction via Torn API",
		start: startTornTerritoryData,
	},
	{
		id: "torn:references",
		description:
			"Daily static reference sync (items, crimes, properties, gyms, stocks)",
		start: startTornReferences,
	},
	{
		id: "torn:abroad_stocks",
		description:
			"5-minute YATA abroad stock export poll and 24h history updater",
		start: startTornAbroadStocks,
	},
	{
		id: "torn:territory_activity",
		description: "15-second high-frequency territory and war assault monitor",
		start: startTornTerritoryActivity,
	},
	{
		id: "bot:verification",
		description: "Hourly target guild verification and Discord role sync",
		start: startVerification,
	},
	{
		id: "bot:monitoring",
		description: "1-minute faction member hospital and state monitor",
		start: startFactionMonitoring,
	},
	{
		id: "personal:log_manager",
		description:
			"1-minute continuous personal log ingestion and backfill engine",
		start: startLogManager,
	},
	{
		id: "personal:state_sync",
		description: "5-minute personal states, cooldowns, and travel monitor",
		start: startPersonalStateSync,
	},
	{
		id: "personal:reference_sync",
		description: "Daily personal perks and gym unlock calculation",
		start: startPersonalReferenceSync,
	},
	{
		id: "personal:crimes_ledger",
		description: "Real-time crime log listener and historical indexer",
		start: startCrimesLedger,
	},
	{
		id: "personal:battlestats_ledger",
		description: "Real-time gym log listener and historical indexer",
		start: startBattlestatsLedger,
	},
	{
		id: "personal:stocks_ledger",
		description: "Real-time stock gain log listener and user holding tracker",
		start: startStocksLedger,
	},
	{
		id: "personal:company_sync",
		description: "Company daily profit sync and pay event listener",
		start: startCompanySync,
	},
	{
		id: "elims:team_tracker",
		description: "30-second live elimination team score and attack poller",
		start: startElimsTeamTracker,
	},
	{
		id: "elims:member_stats_worker",
		description: "15-minute elimination team member attack stat calculator",
		start: startElimsMemberStatsWorker,
	},
];

const DEFAULT_STAGGER_MS = 500;

function getDisabledWorkerIds(): Set<string> {
	const raw = process.env.DISABLED_WORKERS?.trim();
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

/**
 * Starts all registered background workers with a staggered boot delay
 * to prevent initial CPU and memory spikes.
 */
export async function startRegisteredWorkers(options?: {
	staggerMs?: number;
}): Promise<number> {
	const staggerMs = options?.staggerMs ?? DEFAULT_STAGGER_MS;
	const disabledIds = getDisabledWorkerIds();

	const activeWorkers = REGISTERED_WORKERS.filter((worker) => {
		if (worker.enabled === false || disabledIds.has(worker.id)) {
			logger.warn(`Worker '${worker.id}' is disabled. Skipping boot.`);
			return false;
		}
		return true;
	});

	if (activeWorkers.length === 0) {
		logger.info("No background workers currently active in worker registry.");
		return 0;
	}

	logger.info(
		`Starting ${activeWorkers.length} workers with ${staggerMs}ms stagger delay...`,
	);

	let started = 0;
	for (const worker of activeWorkers) {
		const initialDelayMs = started * staggerMs;
		worker.start({ initialDelayMs });
		started++;
	}

	return started;
}
