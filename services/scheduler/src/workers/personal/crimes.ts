import {
	and,
	count,
	crimeActionMappings,
	crimeLogs,
	db,
	eq,
	inArray,
	isNull,
	ledgerEvents,
	personalLogs,
	sql,
	systemStates,
	tornCrimes,
	tornItems,
} from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";
import {
	buildCrimeRulesFromDefinitions,
	calculateCrimeLogValue,
	extractCrimeDataPayload,
	extractItemMarketPrice,
	getCrimeIdFromAction,
	Logger,
} from "@sentinel/utils";
import { schedulerEvents } from "../../lib/events";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "personal:crimes_ledger";
const STATE_ID = "personal:crimes_ledger";
const CADENCE_SEC = 86400; // 24 hours daily reconciliation check

const logger = new Logger("Scheduler", "CrimesLedger");

export const CRIME_LOG_IDS = [
	9010, 9015, 9020, 9025, 9027, 9030, 9050, 9051, 9052, 9053, 9055, 9056, 9060,
	9065, 9070, 9071, 9072, 9073, 9150, 9154, 9155, 9158, 9160, 9163, 9165, 9190,
	9191,
];

const CRIME_LOG_ID_SET = new Set<number>(CRIME_LOG_IDS);

export type UserLog = TornSchema<"UserLog">;
export type CrimeActionMapping = typeof crimeActionMappings.$inferSelect;
export type CrimeLog = typeof crimeLogs.$inferSelect;

export type CrimesLedgerState = {
	status: "idle" | "running" | "completed" | "error";
	totalIndexedCrimes: number;
	lastProcessedTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
};

const DEFAULT_STATE: CrimesLedgerState = {
	status: "idle",
	totalIndexedCrimes: 0,
	lastProcessedTimestamp: null,
	lastError: null,
	updatedAt: new Date().toISOString(),
};

/**
 * Loads the crimes ledger state from SQLite system_states.
 */
export async function loadCrimesLedgerState(): Promise<CrimesLedgerState> {
	try {
		const record = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, STATE_ID),
		});

		if (record?.data) {
			return {
				...DEFAULT_STATE,
				...(record.data as Partial<CrimesLedgerState>),
				updatedAt: new Date().toISOString(),
			};
		}
	} catch (error) {
		logger.error("Failed to load Crimes Ledger state:", error);
	}
	return { ...DEFAULT_STATE };
}

/**
 * Persists the crimes ledger state to SQLite system_states atomically and broadcasts via IPC.
 */
export async function persistCrimesLedgerState(
	state: CrimesLedgerState,
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
				action: "crime_ledger_state_updated",
				data: state,
			});
		}
	} catch (error) {
		logger.error("Failed to persist Crimes Ledger state:", error);
	}
}

/**
 * Loads all Torn item market prices from the SQLite `torn_items` table.
 */
export async function loadItemMarketPrices(): Promise<Map<string, number>> {
	try {
		const items = await db
			.select({
				id: tornItems.id,
				data: tornItems.data,
			})
			.from(tornItems);

		const priceMap = new Map<string, number>();
		for (const it of items) {
			const price = extractItemMarketPrice(it.data);
			if (price > 0) {
				priceMap.set(it.id, price);
			}
		}
		return priceMap;
	} catch (error) {
		logger.error("Failed to load item market prices:", error);
		return new Map();
	}
}

/**
 * Ingests and parses an array of UserLog events directly into SQLite `crime_logs`.
 * Fully idempotent using SQLite insert on conflict update.
 */
export async function processCrimeLogsBatch(
	logs: UserLog[],
): Promise<{ processed: number; skipped: number }> {
	if (logs.length === 0) return { processed: 0, skipped: 0 };

	// 1. Filter only crime-related logs
	const crimeEvents = logs.filter((log) => {
		const logDetails = log.details ?? {};
		const rawLogCode = (log as unknown as { log?: number }).log;
		const logTypeCode = (logDetails as { id?: number }).id ?? rawLogCode ?? 0;
		return CRIME_LOG_ID_SET.has(logTypeCode);
	});

	if (crimeEvents.length === 0) {
		return { processed: 0, skipped: logs.length };
	}

	// 2. Fetch custom crime action mappings for override resolution, item market prices & Torn crime definitions
	const [customMappings, itemPrices, tornCrimesList] = await Promise.all([
		db.select().from(crimeActionMappings),
		loadItemMarketPrices(),
		db
			.select({
				id: tornCrimes.id,
				name: tornCrimes.name,
				data: tornCrimes.data,
			})
			.from(tornCrimes),
	]);
	const customMappingMap = new Map<string, number>(
		customMappings.map((m: CrimeActionMapping) => [
			m.id.toLowerCase(),
			m.crimeId,
		]),
	);

	const dynamicRules = buildCrimeRulesFromDefinitions(
		tornCrimesList.map((tc) => ({
			id: Number(tc.id),
			name: tc.name,
			subcrimes:
				(tc.data as { subcrimes?: Array<{ id: number; name: string }> })
					?.subcrimes ?? [],
		})),
	);

	const now = new Date();
	const rowsToUpsert: Array<{
		id: string;
		crimeId: number;
		action: string;
		nerve: number;
		value: number;
		timestamp: Date;
		createdAt: Date;
		updatedAt: Date;
	}> = [];

	for (const log of crimeEvents) {
		const rawPayload = log.data ?? log;
		const { action, nerve, innerData } = extractCrimeDataPayload(rawPayload);
		if (!action) continue;

		const actionKey = action.toLowerCase();
		const crimeId = customMappingMap.has(actionKey)
			? (customMappingMap.get(actionKey) ?? 0)
			: getCrimeIdFromAction(action, dynamicRules);
		const logValue = calculateCrimeLogValue(innerData, itemPrices);

		const logIdStr = String(log.id);
		const logTimestamp = new Date(log.timestamp * 1000);

		rowsToUpsert.push({
			id: logIdStr,
			crimeId,
			action,
			nerve,
			value: logValue,
			timestamp: logTimestamp,
			createdAt: now,
			updatedAt: now,
		});
	}

	if (rowsToUpsert.length === 0) {
		return { processed: 0, skipped: logs.length };
	}

	// 3. Batch upsert rows inside an atomic transaction (without modifying non-conflicting data)
	await db.transaction(
		async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
			for (const row of rowsToUpsert) {
				await tx
					.insert(crimeLogs)
					.values(row)
					.onConflictDoUpdate({
						target: crimeLogs.id,
						set: {
							crimeId: row.crimeId,
							action: row.action,
							nerve: row.nerve,
							value: row.value,
							timestamp: row.timestamp,
							updatedAt: row.updatedAt,
						},
					});

				if (row.value > 0) {
					const eventId = `ledger_ev_crime_${row.id}`;
					await tx
						.insert(ledgerEvents)
						.values({
							id: eventId,
							logId: row.id,
							timestamp: row.timestamp,
							type: "crime_reward",
							categoryId: 7,
							transactionName: row.action || "Crime Reward",
							assetsAffected: [],
							cashFlow: row.value,
							realizedPnl: row.value,
							rawLog: null,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: ledgerEvents.id,
							set: {
								logId: row.id,
								timestamp: row.timestamp,
								type: "crime_reward",
								categoryId: 7,
								transactionName: row.action || "Crime Reward",
								cashFlow: row.value,
								realizedPnl: row.value,
								updatedAt: now,
							},
						});
				}
			}
		},
	);

	return {
		processed: rowsToUpsert.length,
		skipped: logs.length - rowsToUpsert.length,
	};
}

/**
 * Reconciles historical crime logs from `personal_logs` into `crime_logs`.
 * Non-destructive: preserves existing records and fills in any unindexed crime logs.
 * Uses an anti-join query (LEFT JOIN ... WHERE crime_logs.id IS NULL) to reliably find
 * any missed/dropped records regardless of timestamp ordering or event stutters.
 */
export async function reconcileHistoricalCrimeLogs(options?: {
	forceReplay?: boolean;
	wipeAndRebuild?: boolean;
}): Promise<{ replayed: number }> {
	const finishReconciliation = logger.time();
	const state = await loadCrimesLedgerState();

	state.status = "running";
	await persistCrimesLedgerState(state);

	try {
		logger.info("Starting Crimes Ledger reconciliation from personal_logs...");

		if (options?.wipeAndRebuild) {
			await db.delete(crimeLogs);
			await db
				.delete(ledgerEvents)
				.where(eq(ledgerEvents.type, "crime_reward"));
			state.lastProcessedTimestamp = null;
			state.totalIndexedCrimes = 0;
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
				.where(inArray(personalLogs.log, CRIME_LOG_IDS))
				.orderBy(personalLogs.timestamp);
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
				.leftJoin(crimeLogs, eq(personalLogs.id, crimeLogs.id))
				.where(
					and(inArray(personalLogs.log, CRIME_LOG_IDS), isNull(crimeLogs.id)),
				)
				.orderBy(personalLogs.timestamp);
			logsToProcess = missingLogs;
		}

		if (logsToProcess.length === 0) {
			logger.info(
				"Crimes Ledger is already up to date. No missing crime logs found.",
			);
			state.status = "completed";
			state.lastError = null;
			await persistCrimesLedgerState(state);
			finishReconciliation();
			return { replayed: 0 };
		}

		const [customMappings, itemPrices, tornCrimesList] = await Promise.all([
			db.select().from(crimeActionMappings),
			loadItemMarketPrices(),
			db
				.select({
					id: tornCrimes.id,
					name: tornCrimes.name,
					data: tornCrimes.data,
				})
				.from(tornCrimes),
		]);
		const customMappingMap = new Map<string, number>(
			customMappings.map((m: CrimeActionMapping) => [
				m.id.toLowerCase(),
				m.crimeId,
			]),
		);

		const dynamicRules = buildCrimeRulesFromDefinitions(
			tornCrimesList.map((tc) => ({
				id: Number(tc.id),
				name: tc.name,
				subcrimes:
					(tc.data as { subcrimes?: Array<{ id: number; name: string }> })
						?.subcrimes ?? [],
			})),
		);

		logger.info(
			`Found ${logsToProcess.length} unindexed crime log records in personal_logs. Processing into crime_logs...`,
		);

		const now = new Date();
		let replayed = 0;
		const chunkSize = 500;

		for (let i = 0; i < logsToProcess.length; i += chunkSize) {
			const chunk = logsToProcess.slice(i, i + chunkSize);
			const rowsToUpsert: Array<typeof crimeLogs.$inferInsert> = [];

			for (const pLog of chunk) {
				const rawPayload =
					typeof pLog.data === "string"
						? (JSON.parse(pLog.data) as Record<string, unknown>)
						: pLog.data;
				const { action, nerve, innerData } =
					extractCrimeDataPayload(rawPayload);
				if (!action) continue;

				const actionKey = action.toLowerCase();
				const crimeId = customMappingMap.has(actionKey)
					? (customMappingMap.get(actionKey) ?? 0)
					: getCrimeIdFromAction(action, dynamicRules);
				const logValue = calculateCrimeLogValue(innerData, itemPrices);

				rowsToUpsert.push({
					id: pLog.id,
					crimeId,
					action,
					nerve,
					value: logValue,
					timestamp: new Date(pLog.timestamp),
					createdAt: now,
					updatedAt: now,
				});
			}

			if (rowsToUpsert.length > 0) {
				await db
					.insert(crimeLogs)
					.values(rowsToUpsert)
					.onConflictDoUpdate({
						target: crimeLogs.id,
						set: {
							crimeId: sql`excluded.crime_id`,
							action: sql`excluded.action`,
							nerve: sql`excluded.nerve`,
							value: sql`excluded.value`,
							timestamp: sql`excluded.timestamp`,
							updatedAt: sql`excluded.updated_at`,
						},
					});

				replayed += rowsToUpsert.length;
			}
		}

		// Count total indexed records
		const [totalStats] = await db
			.select({ count: count(crimeLogs.id) })
			.from(crimeLogs);

		state.totalIndexedCrimes =
			totalStats?.count ?? state.totalIndexedCrimes + replayed;
		state.status = "completed";
		state.lastError = null;
		await persistCrimesLedgerState(state);

		logger.info(
			`Crimes Ledger reconciliation completed successfully. Total crime logs indexed: ${state.totalIndexedCrimes}`,
		);
		finishReconciliation();
		return { replayed };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		state.status = "error";
		state.lastError = errorMessage;
		await persistCrimesLedgerState(state);
		logger.error("Failed to reconcile Crimes Ledger:", error);
		return { replayed: 0 };
	}
}

/**
 * High-performance on-demand aggregation query to fetch total nerve spent, monetary value, and count per crime category.
 */
export async function getCrimeTotals(crimeId?: number): Promise<
	Array<{
		crimeId: number;
		nerveSpent: number;
		totalValue: number;
		count: number;
	}>
> {
	const whereClause =
		crimeId !== undefined ? eq(crimeLogs.crimeId, crimeId) : undefined;

	const groups = await db
		.select({
			crimeId: crimeLogs.crimeId,
			nerveSpent: sql<number>`COALESCE(sum(${crimeLogs.nerve}), 0)`,
			totalValue: sql<number>`COALESCE(sum(${crimeLogs.value}), 0)`,
			count: count(crimeLogs.id),
		})
		.from(crimeLogs)
		.where(whereClause)
		.groupBy(crimeLogs.crimeId);

	return groups.map(
		(g: {
			crimeId: number;
			nerveSpent: number;
			totalValue: number;
			count: number;
		}) => ({
			crimeId: g.crimeId,
			nerveSpent: Number(g.nerveSpent),
			totalValue: Number(g.totalValue),
			count: Number(g.count),
		}),
	);
}

/**
 * Re-initializes the Crimes Ledger by wiping existing crime_logs and regenerating all records from personal_logs.
 */
export async function reinitializeCrimeLedger(): Promise<{ replayed: number }> {
	return await reconcileHistoricalCrimeLogs({
		forceReplay: true,
		wipeAndRebuild: true,
	});
}

/**
 * Worker periodic handler for daily reconciliation check.
 */
export async function runCrimesLedgerSync(): Promise<void> {
	await reconcileHistoricalCrimeLogs();
}

/**
 * Starts the Crimes Ledger worker:
 * 1. Listens for real-time `logs_inserted` stream events for zero-delay live indexing.
 * 2. Runs daily reconciliation maintenance runner.
 */
export function startCrimesLedger(options?: WorkerStartOptions): void {
	// 1. Live stream processing
	schedulerEvents.on("logs_inserted", (logs: UserLog[]) => {
		processCrimeLogsBatch(logs).catch((err) => {
			logger.error("Error processing real-time crime logs batch:", err);
		});
	});

	// 2. Register daily runner with initial staggered delay
	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: CADENCE_SEC,
		initialDelayMs: options?.initialDelayMs,
		handler: runCrimesLedgerSync,
	});
}
