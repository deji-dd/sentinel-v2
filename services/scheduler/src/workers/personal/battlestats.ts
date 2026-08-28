import {
	and,
	battlestatsLedgers,
	count,
	db,
	eq,
	inArray,
	isNull,
	personalLogs,
	sql,
	systemStates,
} from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";
import {
	Logger,
	parseStatGainFromLog,
	STAT_GAIN_LOG_ID_SET,
	STAT_GAIN_LOG_IDS,
	type StatType,
} from "@sentinel/utils";
import { schedulerEvents } from "../../lib/events";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "personal:battlestats_ledger";
const STATE_ID = "personal:battlestats_ledger";
const CADENCE_SEC = 86400; // 24 hours daily reconciliation check

const logger = new Logger("Scheduler", "BattlestatsLedger");

export type UserLog = TornSchema<"UserLog">;
export type BattlestatsLedgerEntry = typeof battlestatsLedgers.$inferSelect;

export type BattlestatsLedgerState = {
	status: "idle" | "running" | "completed" | "error";
	totalIndexedLogs: number;
	lastProcessedTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
};

const DEFAULT_STATE: BattlestatsLedgerState = {
	status: "idle",
	totalIndexedLogs: 0,
	lastProcessedTimestamp: null,
	lastError: null,
	updatedAt: new Date().toISOString(),
};

/**
 * Loads the battlestats ledger state from SQLite system_states.
 */
export async function loadBattlestatsLedgerState(): Promise<BattlestatsLedgerState> {
	try {
		const record = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, STATE_ID),
		});

		if (record?.data) {
			return {
				...DEFAULT_STATE,
				...(record.data as Partial<BattlestatsLedgerState>),
				updatedAt: new Date().toISOString(),
			};
		}
	} catch (error) {
		logger.error("Failed to load Battlestats Ledger state:", error);
	}
	return { ...DEFAULT_STATE };
}

export const loadGymLedgerState = loadBattlestatsLedgerState;

/**
 * Persists the battlestats ledger state to SQLite system_states atomically and broadcasts via IPC.
 */
export async function persistBattlestatsLedgerState(
	state: BattlestatsLedgerState,
): Promise<void> {
	state.updatedAt = new Date().toISOString();
	try {
		const isCompleted = state.status === "completed";
		await db
			.insert(systemStates)
			.values({
				id: STATE_ID,
				init: isCompleted,
				data: state,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: {
					init: isCompleted,
					data: state,
					updatedAt: new Date(),
				},
			});

		const ipcServer = getActiveIpcServer();
		if (ipcServer) {
			ipcServer.broadcast({
				action: "battlestats_ledger_state_updated",
				data: state,
			});
			ipcServer.broadcast({
				action: "gym_ledger_state_updated",
				data: state,
			});
		}
	} catch (error) {
		logger.error("Failed to persist Battlestats Ledger state:", error);
	}
}

export const persistGymLedgerState = persistBattlestatsLedgerState;

/**
 * Ingests and parses an array of UserLog events directly into SQLite `gym_ledgers`.
 * Fully idempotent using SQLite insert on conflict update.
 */
export async function processBattlestatsLogsBatch(
	logs: UserLog[],
): Promise<{ processed: number; skipped: number }> {
	if (logs.length === 0) return { processed: 0, skipped: 0 };

	const now = new Date();
	const rowsToUpsert: Array<typeof battlestatsLedgers.$inferInsert> = [];

	for (const log of logs) {
		const logDetails = log.details ?? {};
		const rawLogCode = (log as unknown as { log?: number }).log;
		const logTypeCode = (logDetails as { id?: number }).id ?? rawLogCode ?? 0;

		if (!STAT_GAIN_LOG_ID_SET.has(logTypeCode)) {
			continue;
		}

		logger.info(
			`Processing battlestats gain log #${log.id} (Log ID: ${logTypeCode})`,
		);

		const parsed = parseStatGainFromLog(log);
		if (!parsed) continue;

		const logIdStr = String(log.id);
		const logTimestamp = new Date(log.timestamp * 1000);

		rowsToUpsert.push({
			id: logIdStr,
			timestamp: logTimestamp,
			statType: parsed.statType,
			source: parsed.source,
			trains: parsed.trains,
			energyUsed: parsed.energyUsed,
			statGained: parsed.statGained,
			statBefore: parsed.statBefore,
			statAfter: parsed.statAfter,
			createdAt: now,
			updatedAt: now,
		});
	}

	if (rowsToUpsert.length === 0) {
		return { processed: 0, skipped: logs.length };
	}

	// Batch upsert rows inside an atomic transaction
	await db.transaction(
		async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
			for (const row of rowsToUpsert) {
				await tx
					.insert(battlestatsLedgers)
					.values(row)
					.onConflictDoUpdate({
						target: battlestatsLedgers.id,
						set: {
							timestamp: row.timestamp,
							statType: row.statType,
							source: row.source,
							trains: row.trains,
							energyUsed: row.energyUsed,
							statGained: row.statGained,
							statBefore: row.statBefore,
							statAfter: row.statAfter,
							updatedAt: row.updatedAt,
						},
					});
			}
		},
	);

	return {
		processed: rowsToUpsert.length,
		skipped: logs.length - rowsToUpsert.length,
	};
}

export const processGymLogsBatch = processBattlestatsLogsBatch;

/**
 * Reconciles historical battlestats logs from `personal_logs` into `gym_ledgers`.
 * Non-destructive: preserves existing records and fills in any unindexed battlestats logs.
 * Uses an anti-join query (LEFT JOIN ... WHERE gym_ledgers.id IS NULL) to reliably find
 * any missed/dropped records regardless of timestamp ordering or event stutters.
 */
export async function reconcileHistoricalBattlestatsLogs(options?: {
	forceReplay?: boolean;
	wipeAndRebuild?: boolean;
}): Promise<{ replayed: number }> {
	const finishReconciliation = logger.time();
	const state = await loadBattlestatsLedgerState();

	state.status = "running";
	await persistBattlestatsLedgerState(state);

	try {
		logger.info(
			"Starting Battlestats Ledger reconciliation from personal_logs...",
		);

		if (options?.wipeAndRebuild) {
			await db.delete(battlestatsLedgers).run();
			state.lastProcessedTimestamp = null;
			state.totalIndexedLogs = 0;
		}

		let logsToProcess: Array<{
			id: string;
			data: unknown;
			log: number;
			timestamp: Date;
		}>;

		if (options?.forceReplay || options?.wipeAndRebuild) {
			// Full replay: fetch all matching personal logs
			const historicalLogs = await db
				.select({
					id: personalLogs.id,
					data: personalLogs.data,
					log: personalLogs.log,
					timestamp: personalLogs.timestamp,
				})
				.from(personalLogs)
				.where(inArray(personalLogs.log, STAT_GAIN_LOG_IDS))
				.orderBy(personalLogs.timestamp)
				.all();
			logsToProcess = historicalLogs;
		} else {
			// Anti-join: query only unindexed personal_logs (immune to timestamp drift or stutter windows)
			const missingLogs = await db
				.select({
					id: personalLogs.id,
					data: personalLogs.data,
					log: personalLogs.log,
					timestamp: personalLogs.timestamp,
				})
				.from(personalLogs)
				.leftJoin(
					battlestatsLedgers,
					eq(personalLogs.id, battlestatsLedgers.id),
				)
				.where(
					and(
						inArray(personalLogs.log, STAT_GAIN_LOG_IDS),
						isNull(battlestatsLedgers.id),
					),
				)
				.orderBy(personalLogs.timestamp)
				.all();
			logsToProcess = missingLogs;
		}

		if (logsToProcess.length === 0) {
			logger.info(
				"Battlestats Ledger is already up to date. No missing logs found.",
			);
			state.status = "completed";
			state.lastError = null;
			await persistBattlestatsLedgerState(state);
			finishReconciliation();
			return { replayed: 0 };
		}

		logger.info(
			`Found ${logsToProcess.length} unindexed battlestats log records in personal_logs. Processing into battlestats_ledgers...`,
		);

		const now = new Date();
		let replayed = 0;
		const chunkSize = 500;

		for (let i = 0; i < logsToProcess.length; i += chunkSize) {
			const chunk = logsToProcess.slice(i, i + chunkSize);
			const rowsToUpsert: Array<typeof battlestatsLedgers.$inferInsert> = [];

			for (const pLog of chunk) {
				logger.info(
					`Processing historical battlestats log #${pLog.id} (Log ID: ${pLog.log})`,
				);
				const parsed = parseStatGainFromLog({
					id: pLog.id,
					log: pLog.log,
					data: pLog.data,
					timestamp: Math.floor(new Date(pLog.timestamp).getTime() / 1000),
				});
				if (!parsed) continue;

				rowsToUpsert.push({
					id: pLog.id,
					timestamp: new Date(pLog.timestamp),
					statType: parsed.statType,
					source: parsed.source,
					trains: parsed.trains,
					energyUsed: parsed.energyUsed,
					statGained: parsed.statGained,
					statBefore: parsed.statBefore,
					statAfter: parsed.statAfter,
					createdAt: now,
					updatedAt: now,
				});
			}

			if (rowsToUpsert.length > 0) {
				await db
					.insert(battlestatsLedgers)
					.values(rowsToUpsert)
					.onConflictDoUpdate({
						target: battlestatsLedgers.id,
						set: {
							timestamp: sql`excluded.timestamp`,
							statType: sql`excluded.stat_type`,
							source: sql`excluded.source`,
							trains: sql`excluded.trains`,
							energyUsed: sql`excluded.energy_used`,
							statGained: sql`excluded.stat_gained`,
							statBefore: sql`excluded.stat_before`,
							statAfter: sql`excluded.stat_after`,
							updatedAt: sql`excluded.updated_at`,
						},
					});

				replayed += rowsToUpsert.length;
			}
		}

		// Count total indexed records
		const totalStats = await db
			.select({ count: count(battlestatsLedgers.id) })
			.from(battlestatsLedgers)
			.get();

		state.totalIndexedLogs =
			totalStats?.count ?? state.totalIndexedLogs + replayed;
		state.status = "completed";
		state.lastError = null;
		await persistBattlestatsLedgerState(state);

		logger.info(
			`Battlestats Ledger reconciliation completed successfully. Total logs indexed: ${state.totalIndexedLogs}`,
		);
		finishReconciliation();
		return { replayed };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		state.status = "error";
		state.lastError = errorMessage;
		await persistBattlestatsLedgerState(state);
		logger.error("Failed to reconcile Battlestats Ledger:", error);
		return { replayed: 0 };
	}
}

export const reconcileHistoricalGymLogs = reconcileHistoricalBattlestatsLogs;

/**
 * Aggregates total stat gain, trains, energy used, and count per stat type.
 */
export async function getBattlestatsTotals(statType?: StatType): Promise<
	Array<{
		statType: string;
		totalGained: number;
		trains: number;
		energyUsed: number;
		count: number;
	}>
> {
	const whereClause =
		statType !== undefined
			? eq(battlestatsLedgers.statType, statType)
			: undefined;

	const groups = await db
		.select({
			statType: battlestatsLedgers.statType,
			totalGained: sql<number>`COALESCE(sum(${battlestatsLedgers.statGained}), 0)`,
			trains: sql<number>`COALESCE(sum(${battlestatsLedgers.trains}), 0)`,
			energyUsed: sql<number>`COALESCE(sum(${battlestatsLedgers.energyUsed}), 0)`,
			count: count(battlestatsLedgers.id),
		})
		.from(battlestatsLedgers)
		.where(whereClause)
		.groupBy(battlestatsLedgers.statType)
		.all();

	return groups.map((g) => ({
		statType: g.statType,
		totalGained: Number(g.totalGained),
		trains: Number(g.trains),
		energyUsed: Number(g.energyUsed),
		count: Number(g.count),
	}));
}

export const getGymTotals = getBattlestatsTotals;

/**
 * Re-initializes the Battlestats Ledger by wiping existing records and regenerating all records from personal_logs.
 */
export async function reinitializeBattlestatsLedger(): Promise<{
	replayed: number;
}> {
	return await reconcileHistoricalBattlestatsLogs({
		forceReplay: true,
		wipeAndRebuild: true,
	});
}

export const reinitializeGymLedger = reinitializeBattlestatsLedger;

/**
 * Worker periodic handler for daily reconciliation check.
 */
export async function runBattlestatsLedgerSync(): Promise<void> {
	await reconcileHistoricalBattlestatsLogs();
}

/**
 * Starts the Battlestats Ledger worker:
 * 1. Listens for real-time `logs_inserted` stream events for zero-delay live indexing.
 * 2. Runs daily reconciliation maintenance runner.
 */
export function startBattlestatsLedger(options?: WorkerStartOptions): void {
	// 1. Live stream processing
	schedulerEvents.on("logs_inserted", (logs: UserLog[]) => {
		processBattlestatsLogsBatch(logs).catch((err) => {
			logger.error("Error processing real-time battlestats logs batch:", err);
		});
	});

	// 2. Register daily runner with initial staggered delay
	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: CADENCE_SEC,
		initialDelayMs: options?.initialDelayMs,
		handler: runBattlestatsLedgerSync,
	});
}

export const startGymLedger = startBattlestatsLedger;
