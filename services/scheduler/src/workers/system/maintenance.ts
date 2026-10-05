import {
	db,
	elimsTeamAttacks,
	elimsTeamSnapshots,
	eq,
	factionAttackLogs,
	inArray,
	lt,
	type PgColumn,
	type PgTable,
	reconcileTargetGuildsAndModules,
	type SQL,
	systemMetrics,
	travelDestinations,
	verificationLogs,
	warLedgers,
} from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { notifyBotAction } from "@sentinel/utils/ipc";
import { startEventDrivenRunner } from "../../lib/scheduler";
import { reconcileHistoricalBattlestatsLogs } from "../personal/battlestats";
import { reconcileHistoricalCrimeLogs } from "../personal/crimes";
import { reconcileHistoricalStockLogs } from "../personal/stocks";
import type { WorkerStartOptions } from "../registry";
import type { TravelStockItem } from "../torn/abroad-stocks";

const WORKER_NAME = "system:maintenance";
const RETENTION_WORKER_NAME = "system:retention";
const logger = new Logger("Scheduler", "Maintenance");

/**
 * Rows deleted per retention batch.
 *
 * Retention used to run as a single unbounded `DELETE ... RETURNING id` per
 * table, which (a) seq-scanned the table, (b) held one long transaction while
 * the 5-10s attack feed was writing, and (c) materialised every deleted id in
 * this process purely to log a count. Batching bounds each transaction and keeps
 * the process memory flat.
 */
const RETENTION_DELETE_CHUNK = 10_000;

/**
 * Budget for the whole maintenance run. Well above the runner's 5-minute cron
 * default because the run performs five retention sweeps plus three historical
 * ledger reconciliations; a timeout here would start a concurrent second run.
 */
export const MAINTENANCE_TIMEOUT_MS = 30 * 60_000;

/**
 * Deletes rows matching `cutoffFilter` in bounded batches, checking the abort
 * signal between batches so a shutdown or timeout stops promptly instead of
 * leaving an orphaned handler running.
 */
async function deleteInBatches(
	table: PgTable,
	idColumn: PgColumn,
	cutoffFilter: SQL,
	signal?: AbortSignal,
): Promise<number> {
	let total = 0;
	for (;;) {
		if (signal?.aborted) break;

		const rows = await db
			.select({ id: idColumn })
			.from(table)
			.where(cutoffFilter)
			.limit(RETENTION_DELETE_CHUNK);

		if (rows.length === 0) break;

		await db.delete(table).where(
			inArray(
				idColumn,
				rows.map((row) => row.id),
			),
		);
		total += rows.length;

		if (rows.length < RETENTION_DELETE_CHUNK) break;
	}
	return total;
}

/**
 * Daily system cleanup and retention manager.
 * Retains 90 days of completed WarLedger data, 30 days of VerificationLogs, prunes 24-hour stock history windows,
 * and executes off-peak historical ledger reconciliations for stocks, crimes, and battlestats.
 */
async function executeRetentionSweeps(signal?: AbortSignal): Promise<void> {
	const finishSync = logger.time();

	try {
		const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

		// 1. Retain 90 days of completed WarLedger records (prune older finished wars)
		// `end_time < cutoff` alone already excludes NULL (open) wars, so the
		// redundant IS NOT NULL predicate is dropped.
		const prunedWars = await deleteInBatches(
			warLedgers,
			warLedgers.id,
			lt(warLedgers.endTime, ninetyDaysAgo),
			signal,
		);

		if (prunedWars > 0) {
			logger.info(
				`Pruned ${prunedWars} finished WarLedger records older than 90 days.`,
			);
		}

		// 2. Prune VerificationLogs older than 30 days
		const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		const prunedLogs = await deleteInBatches(
			verificationLogs,
			verificationLogs.id,
			lt(verificationLogs.createdAt, thirtyDaysAgo),
			signal,
		);

		if (prunedLogs > 0) {
			logger.info(
				`Pruned ${prunedLogs} VerificationLog records older than 30 days.`,
			);
		}

		// 3. Prune faction attack logs older than 7 days. These back the shared
		//    /faction/attacks feed; the retal window is only 5 minutes and merc hit
		//    dedupe is per-contract, so anything older than a week is dead weight.
		const factionAttackCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
		const prunedAttacks = await deleteInBatches(
			factionAttackLogs,
			factionAttackLogs.id,
			lt(factionAttackLogs.createdAt, factionAttackCutoff),
			signal,
		);

		if (prunedAttacks > 0) {
			logger.info(
				`Pruned ${prunedAttacks} faction attack log records older than 7 days.`,
			);
		}

		// 4. Prune travel destination stock history points older than 24 hours
		const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
		const allDestinations = await db.query.travelDestinations.findMany();
		let prunedStockPointsCount = 0;

		for (const dest of allDestinations) {
			const rawStocks = dest.stocks;
			const stocks: TravelStockItem[] = Array.isArray(rawStocks)
				? (rawStocks as TravelStockItem[])
				: typeof rawStocks === "string"
					? (JSON.parse(rawStocks) as TravelStockItem[])
					: [];

			let destModified = false;
			const updatedStocks = stocks.map((item) => {
				const history = item.history ?? [];
				const freshHistory = history.filter(
					(h) => h.timestamp >= twentyFourHoursAgo,
				);
				const removedCount = history.length - freshHistory.length;
				if (removedCount > 0) {
					destModified = true;
					prunedStockPointsCount += removedCount;
				}
				return {
					...item,
					history: freshHistory,
				};
			});

			if (destModified) {
				await db
					.update(travelDestinations)
					.set({
						stocks: updatedStocks,
						updatedAt: new Date(),
					})
					.where(eq(travelDestinations.id, dest.id));
			}
		}

		if (prunedStockPointsCount > 0) {
			logger.info(
				`Pruned ${prunedStockPointsCount} travel stock history points older than 24 hours.`,
			);
		}

		// 4. Prune system telemetry metrics older than 7 days
		const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
		const prunedMetrics = await deleteInBatches(
			systemMetrics,
			systemMetrics.id,
			lt(systemMetrics.createdAt, sevenDaysAgo),
			signal,
		);

		if (prunedMetrics > 0) {
			logger.info(
				`Pruned ${prunedMetrics} SystemMetrics records older than 7 days.`,
			);
		}

		// 4b. Prune elimination tournament history older than 90 days. Neither
		//     table had any retention: snapshots had accumulated 500k+ rows
		//     (~100MB) and attacks ~690k rows (~188MB), both still read by the
		//     dashboard. 90 days matches the WarLedger window.
		const prunedElimSnapshots = await deleteInBatches(
			elimsTeamSnapshots,
			elimsTeamSnapshots.id,
			lt(elimsTeamSnapshots.capturedAt, ninetyDaysAgo),
			signal,
		);

		if (prunedElimSnapshots > 0) {
			logger.info(
				`Pruned ${prunedElimSnapshots} ElimsTeamSnapshot records older than 90 days.`,
			);
		}

		const prunedElimAttacks = await deleteInBatches(
			elimsTeamAttacks,
			elimsTeamAttacks.id,
			lt(elimsTeamAttacks.detectedAt, ninetyDaysAgo),
			signal,
		);

		if (prunedElimAttacks > 0) {
			logger.info(
				`Pruned ${prunedElimAttacks} ElimsTeamAttack records older than 90 days.`,
			);
		}

		finishSync();
	} catch (error) {
		logger.error("Error executing retention sweeps:", error);
		throw error;
	}
}

/**
 * Off-peak, low-frequency system sweeps that are not retention.
 *
 * These are the slow, unbounded parts: guild/module reconciliation plus the
 * historical ledger reconciliations, each of which loads an entire missing
 * backlog into memory. Kept separate from retention so a slow or failing sweep
 * here can never delay or block the bounded retention deletes.
 */
async function executeSystemSweeps(signal?: AbortSignal): Promise<void> {
	const finishSync = logger.time();

	try {
		if (signal?.aborted) return;

		// 1. Personal ledger historical reconciliation sweeps
		try {
			const stockResult = await reconcileHistoricalStockLogs();
			if (stockResult.replayed > 0) {
				logger.info(
					`Reconciled ${stockResult.replayed} historical stock ledger records during maintenance.`,
				);
			}
		} catch (err) {
			logger.error(
				"Error reconciling historical stock logs during maintenance:",
				err,
			);
		}

		try {
			const crimeResult = await reconcileHistoricalCrimeLogs();
			if (crimeResult.replayed > 0) {
				logger.info(
					`Reconciled ${crimeResult.replayed} historical crime ledger records during maintenance.`,
				);
			}
		} catch (err) {
			logger.error(
				"Error reconciling historical crime logs during maintenance:",
				err,
			);
		}

		try {
			const bsResult = await reconcileHistoricalBattlestatsLogs();
			if (bsResult.replayed > 0) {
				logger.info(
					`Reconciled ${bsResult.replayed} historical battlestats ledger records during maintenance.`,
				);
			}
		} catch (err) {
			logger.error(
				"Error reconciling historical battlestats logs during maintenance:",
				err,
			);
		}

		if (signal?.aborted) return;

		// 2. Guild configuration & module cleanup sweep (reconciles against current env settings)
		try {
			const cleanupResult = await reconcileTargetGuildsAndModules();
			if (cleanupResult.deauthorizedGuilds.length > 0) {
				logger.warn(
					`Maintenance: Deauthorized ${cleanupResult.deauthorizedGuilds.length} stale guild(s) and disabled ${cleanupResult.deactivatedModulesCount} orphaned module(s): [${cleanupResult.deauthorizedGuilds.join(", ")}]`,
				);
			} else {
				logger.info(
					`Maintenance: Verified ${cleanupResult.reconciledGuilds.length} target guild(s) - all active modules aligned with current environment.`,
				);
			}
		} catch (err) {
			logger.error(
				"Error reconciling guild configurations during maintenance:",
				err,
			);
		}

		// 3. Trigger bot to clean up 1-week-old archived mercenary channels
		try {
			void notifyBotAction("cleanup_archived_merc_channels", {
				maxAgeDays: 7,
			});
		} catch (mercErr) {
			logger.warn(
				"Error notifying bot to cleanup archived merc channels:",
				mercErr,
			);
		}

		finishSync();
	} catch (error) {
		logger.error("Error executing system maintenance sweeps:", error);
		throw error;
	}
}

/**
 * Full maintenance pass: retention sweeps followed by the off-peak system sweeps.
 *
 * Retained as the single entry point for callers that want everything, but the
 * scheduler runs the two halves as independent workers — see
 * `startSystemRetention` and `startSystemMaintenance` — so that neither can
 * block or fail the other, and so retention can run far more often than the
 * expensive daily reconciliations.
 */
export async function executeMaintenance(signal?: AbortSignal): Promise<void> {
	await executeRetentionSweeps(signal);
	await executeSystemSweeps(signal);
}

/**
 * Starts the retention worker.
 *
 * Runs every six hours rather than daily so each delete batch is smaller and the
 * 7-day attack-log window stays tight between runs (the previous single daily
 * pass let a full day of rows accumulate before pruning).
 */
export function startSystemRetention(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: RETENTION_WORKER_NAME,
		schedule: { type: "cron", pattern: "0 */6 * * *", timezone: "Etc/UTC" },
		timeoutMs: MAINTENANCE_TIMEOUT_MS,
		initialDelayMs: options?.initialDelayMs,
		handler: async (signal) => {
			await executeRetentionSweeps(signal);
		},
	});
}

/**
 * Starts the off-peak daily system sweep worker (ledger reconciliations and
 * guild/module reconciliation), scheduled for 04:00 UTC.
 */
export function startSystemMaintenance(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "0 4 * * *", timezone: "Etc/UTC" },
		// Explicit generous budget: the default 5-minute cron timeout is shorter
		// than a full reconciliation sweep can take, and on timeout the runner
		// would retry while this handler was still running.
		timeoutMs: MAINTENANCE_TIMEOUT_MS,
		initialDelayMs: options?.initialDelayMs,
		handler: async (signal) => {
			await executeSystemSweeps(signal);
		},
	});
}
