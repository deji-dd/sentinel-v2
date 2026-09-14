import {
	and,
	db,
	eq,
	isNotNull,
	lt,
	systemMetrics,
	travelDestinations,
	verificationLogs,
	warLedgers,
} from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { startEventDrivenRunner } from "../../lib/scheduler";
import { reconcileHistoricalBattlestatsLogs } from "../personal/battlestats";
import { reconcileHistoricalCrimeLogs } from "../personal/crimes";
import { reconcileHistoricalStockLogs } from "../personal/stocks";
import type { WorkerStartOptions } from "../registry";
import type { TravelStockItem } from "../torn/abroad-stocks";

const WORKER_NAME = "system:maintenance";
const logger = new Logger("Scheduler", "Maintenance");

/**
 * Daily system cleanup and retention manager.
 * Retains 90 days of completed WarLedger data, 30 days of VerificationLogs, prunes 24-hour stock history windows,
 * and executes off-peak historical ledger reconciliations for stocks, crimes, and battlestats.
 */
export async function executeMaintenance(): Promise<void> {
	const finishSync = logger.time();

	try {
		const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

		// 1. Retain 90 days of completed WarLedger records (prune older finished wars)
		const prunedWars = await db
			.delete(warLedgers)
			.where(
				and(
					isNotNull(warLedgers.endTime),
					lt(warLedgers.endTime, ninetyDaysAgo),
				),
			)
			.returning({ id: warLedgers.id });

		if (prunedWars.length > 0) {
			logger.info(
				`Pruned ${prunedWars.length} finished WarLedger records older than 90 days.`,
			);
		}

		// 2. Prune VerificationLogs older than 30 days
		const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		const prunedLogs = await db
			.delete(verificationLogs)
			.where(lt(verificationLogs.createdAt, thirtyDaysAgo))
			.returning({ id: verificationLogs.id });

		if (prunedLogs.length > 0) {
			logger.info(
				`Pruned ${prunedLogs.length} VerificationLog records older than 30 days.`,
			);
		}

		// 3. Prune travel destination stock history points older than 24 hours
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
		const prunedMetrics = await db
			.delete(systemMetrics)
			.where(lt(systemMetrics.createdAt, sevenDaysAgo))
			.returning({ id: systemMetrics.id });

		if (prunedMetrics.length > 0) {
			logger.info(
				`Pruned ${prunedMetrics.length} SystemMetrics records older than 7 days.`,
			);
		}

		// 5. Personal ledger historical reconciliation sweeps
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

		finishSync();
	} catch (error) {
		logger.error("Error executing system maintenance:", error);
	}
}

/**
 * Starts the automated daily system maintenance worker scheduled to run at 04:00 UTC.
 */
export function startSystemMaintenance(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		schedule: { type: "cron", pattern: "0 4 * * *", timezone: "Etc/UTC" },
		initialDelayMs: options?.initialDelayMs,
		handler: async () => {
			await executeMaintenance();
		},
	});
}
