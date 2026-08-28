import {
	and,
	count,
	db,
	eq,
	inArray,
	isNull,
	ledgerEvents,
	personalLogs,
	sql,
	stockLedgers,
	systemStates,
	tornItems,
	tornStocks,
	userStocks,
} from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";
import { getPersonalKey, tornApi } from "@sentinel/torn-api";
import { extractItemMarketPrice, Logger } from "@sentinel/utils";
import { schedulerEvents } from "../../lib/events";
import { getActiveIpcServer } from "../../lib/ipc/server";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "personal:stocks_ledger";
const STATE_ID = "personal:stocks_ledger";
const CADENCE_SEC = 86400; // 24 hours daily reconciliation check

const logger = new Logger("Scheduler", "StocksLedger");

export const STOCK_ACTIVITY_LOG_IDS = [5510, 5511, 5520, 5521];
export const STOCK_GAIN_LOG_IDS = [
	5530, 5531, 5532, 5533, 5534, 5535, 5536, 5537,
];

const STOCK_GAIN_LOG_ID_SET = new Set<number>(STOCK_GAIN_LOG_IDS);
const STOCK_ACTIVITY_LOG_ID_SET = new Set<number>(STOCK_ACTIVITY_LOG_IDS);

export type UserLog = TornSchema<"UserLog">;
export type StockLedgerEntry = typeof stockLedgers.$inferSelect;

export type StocksLedgerState = {
	status: "idle" | "running" | "completed" | "error";
	totalIndexedLogs: number;
	lastProcessedTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
};

const DEFAULT_STATE: StocksLedgerState = {
	status: "idle",
	totalIndexedLogs: 0,
	lastProcessedTimestamp: null,
	lastError: null,
	updatedAt: new Date().toISOString(),
};

let isSyncingUserStocks = false;
let pendingSync = false;

/**
 * Loads the stocks ledger state from SQLite system_states.
 */
export async function loadStocksLedgerState(): Promise<StocksLedgerState> {
	try {
		const record = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, STATE_ID),
		});

		if (record?.data && typeof record.data === "object") {
			return {
				...DEFAULT_STATE,
				...(record.data as Partial<StocksLedgerState>),
				updatedAt: new Date().toISOString(),
			};
		}
	} catch (error) {
		logger.error("Failed to load Stocks Ledger state:", error);
	}
	return { ...DEFAULT_STATE };
}

/**
 * Persists the stocks ledger state to SQLite system_states atomically and broadcasts via IPC.
 */
export async function persistStocksLedgerState(
	state: StocksLedgerState,
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
				action: "stocks_ledger_state_updated",
				data: state,
			});
		}
	} catch (error) {
		logger.error("Failed to persist Stocks Ledger state:", error);
	}
}

export type TornStockHolding = {
	id: number;
	shares: number;
	transactions?: unknown;
	bonus?: unknown;
};

type UserStocksApiResponse = {
	stocks?: TornStockHolding[] | Record<string, TornStockHolding>;
};

/**
 * Synchronizes user stock positions from Torn API (`/user/stocks`) to `user_stocks`.
 */
export async function syncUserStocks(): Promise<void> {
	const keyEntry = await getPersonalKey();
	if (!keyEntry) {
		logger.warn("No personal API key available to sync user stocks.");
		return;
	}

	try {
		const res = (await tornApi.getPersonal("/user", {
			queryParams: { selections: ["stocks"] },
		})) as UserStocksApiResponse;

		if (res.stocks) {
			const stocksArray: TornStockHolding[] = Array.isArray(res.stocks)
				? res.stocks
				: Object.values(res.stocks);

			const now = new Date();
			for (const stock of stocksArray) {
				const stockIdStr = String(stock.id);
				await db
					.insert(userStocks)
					.values({
						id: stockIdStr,
						shares: stock.shares,
						transactions: stock.transactions ?? null,
						bonus: stock.bonus ?? null,
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: userStocks.id,
						set: {
							shares: stock.shares,
							transactions: stock.transactions ?? null,
							bonus: stock.bonus ?? null,
							updatedAt: now,
						},
					});
			}

			logger.info(
				`Synced ${stocksArray.length} active UserStocks from Torn API.`,
			);
		}
	} catch (err) {
		logger.error("Failed to sync user stocks data:", err);
	}
}

/**
 * Debounced activity trigger to sync active user stock positions.
 */
export async function parseStockActivityLog(): Promise<void> {
	if (isSyncingUserStocks) {
		pendingSync = true;
		return;
	}

	isSyncingUserStocks = true;
	try {
		do {
			pendingSync = false;
			await syncUserStocks();
		} while (pendingSync);
	} finally {
		isSyncingUserStocks = false;
	}
}

/**
 * Parses an individual stock gain log into `stock_ledgers` and `ledger_events`.
 */
export async function parseStockGainLog(log: UserLog): Promise<boolean> {
	const rawPayload = log.data ?? log;
	const logData =
		typeof rawPayload === "string"
			? (JSON.parse(rawPayload) as Record<string, unknown>)
			: (rawPayload as Record<string, unknown>) || {};

	const inner =
		typeof logData.data === "object" && logData.data !== null
			? (logData.data as Record<string, unknown>)
			: logData;

	const rawStockId = inner.stock ?? logData.stock;
	if (rawStockId === undefined || rawStockId === null) return false;

	const stockId = Number(rawStockId);
	if (Number.isNaN(stockId) || stockId <= 0) return false;

	const tornStockRecord = await db.query.tornStocks.findFirst({
		where: eq(tornStocks.id, String(stockId)),
	});

	const rawBonus = tornStockRecord?.bonus;
	const rawMarket = tornStockRecord?.market;
	const parsedBonus =
		typeof rawBonus === "string"
			? (JSON.parse(rawBonus) as Record<string, unknown>)
			: (rawBonus as Record<string, unknown> | undefined);

	const parsedMarket =
		typeof rawMarket === "string"
			? (JSON.parse(rawMarket) as Record<string, unknown>)
			: (rawMarket as Record<string, unknown> | undefined);

	const stockBonus =
		parsedBonus ??
		(parsedMarket?.benefit as Record<string, unknown> | undefined) ??
		(parsedMarket?.bonus as Record<string, unknown> | undefined) ??
		{};

	if (stockBonus.passive) return false;

	const userStockRecord = await db.query.userStocks.findFirst({
		where: eq(userStocks.id, String(stockId)),
	});

	if (userStockRecord) {
		const reqShares = Number(stockBonus.requirement || 0);
		if (reqShares > 0 && userStockRecord.shares < reqShares) {
			return false;
		}

		const rawTxs = userStockRecord.transactions;
		const txs: Array<{ timestamp?: number }> = Array.isArray(rawTxs)
			? (rawTxs as Array<{ timestamp?: number }>)
			: typeof rawTxs === "string"
				? (JSON.parse(rawTxs) as Array<{ timestamp?: number }>)
				: rawTxs && typeof rawTxs === "object"
					? (Object.values(rawTxs) as Array<{ timestamp?: number }>)
					: [];

		let oldestTx = Number.MAX_SAFE_INTEGER;
		for (const tx of txs) {
			if (typeof tx.timestamp === "number" && tx.timestamp < oldestTx) {
				oldestTx = tx.timestamp;
			}
		}

		const logTimestampSec =
			typeof log.timestamp === "number" ? log.timestamp : 0;
		if (oldestTx !== Number.MAX_SAFE_INTEGER && logTimestampSec < oldestTx) {
			return false;
		}
	}

	let valueReceived = 0;
	let itemId: number | undefined;

	if (inner.money || logData.money) {
		valueReceived = Number(inner.money ?? logData.money);
	} else if (
		(inner.item && typeof inner.item === "object") ||
		(logData.item && typeof logData.item === "object")
	) {
		const itemObj = (inner.item ?? logData.item) as Record<string, unknown>;
		const itemIds = Object.keys(itemObj);
		if (itemIds.length > 0 && itemIds[0] !== undefined) {
			const firstItemId = itemIds[0];
			itemId = Number(firstItemId);
			const qty = Number(itemObj[firstItemId] ?? 1);

			const itemRecord = await db.query.tornItems.findFirst({
				where: eq(tornItems.id, String(itemId)),
			});
			const itemMarketPrice = extractItemMarketPrice(itemRecord?.data);
			valueReceived = qty * itemMarketPrice;
		}
	}

	const logIdStr = String(log.id);
	const logTimestampSec = typeof log.timestamp === "number" ? log.timestamp : 0;
	const logTimestamp = new Date(logTimestampSec * 1000);
	const now = new Date();
	const logDetails = log.details as { id?: number } | undefined;
	const rawLogCode = (log as unknown as { log?: number }).log;
	const logTypeCode = Number(logDetails?.id ?? rawLogCode ?? 0);

	// 1. Record in stock_ledgers
	await db
		.insert(stockLedgers)
		.values({
			id: logIdStr,
			timestamp: logTimestamp,
			stockId,
			logType: logTypeCode,
			value: valueReceived,
			itemId: itemId ?? null,
			createdAt: now,
		})
		.onConflictDoUpdate({
			target: stockLedgers.id,
			set: {
				timestamp: logTimestamp,
				stockId,
				logType: logTypeCode,
				value: valueReceived,
				itemId: itemId ?? null,
			},
		});

	// 2. Record in ledger_events
	const assetsAffected = itemId
		? [
				{
					assetId: String(itemId),
					quantityChange: 1,
					costBasisImpact: valueReceived,
				},
			]
		: [];

	const eventId = `ledger_ev_${logIdStr}`;
	await db
		.insert(ledgerEvents)
		.values({
			id: eventId,
			logId: logIdStr,
			timestamp: logTimestamp,
			type: "stock_dividend",
			categoryId: 8,
			transactionName: "Stock Benefit Block Dividend",
			assetsAffected,
			cashFlow: inner.money || logData.money ? valueReceived : 0,
			realizedPnl: valueReceived,
			rawLog: log as unknown as Record<string, unknown>,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: ledgerEvents.id,
			set: {
				logId: logIdStr,
				timestamp: logTimestamp,
				type: "stock_dividend",
				categoryId: 8,
				transactionName: "Stock Benefit Block Dividend",
				assetsAffected,
				cashFlow: inner.money || logData.money ? valueReceived : 0,
				realizedPnl: valueReceived,
				rawLog: log as unknown as Record<string, unknown>,
				updatedAt: now,
			},
		});

	return true;
}

/**
 * Ingests and parses an array of UserLog events.
 * Dispatches activity logs to sync stock holdings, and gain logs into `stock_ledgers`.
 */
export async function processStockLogsBatch(
	logs: UserLog[],
): Promise<{ processed: number; skipped: number }> {
	if (logs.length === 0) return { processed: 0, skipped: 0 };

	let processed = 0;
	let skipped = 0;
	let hasActivityLogs = false;

	for (const log of logs) {
		const logDetails = log.details ?? {};
		const rawLogCode = (log as unknown as { log?: number }).log;
		const logTypeCode = (logDetails as { id?: number }).id ?? rawLogCode ?? 0;

		if (STOCK_ACTIVITY_LOG_ID_SET.has(logTypeCode)) {
			logger.info(
				`Processing stock activity log #${log.id} (Log ID: ${logTypeCode})`,
			);
			hasActivityLogs = true;
			processed++;
		} else if (STOCK_GAIN_LOG_ID_SET.has(logTypeCode)) {
			const success = await parseStockGainLog(log);
			if (success) {
				processed++;
			} else {
				skipped++;
			}
		} else {
			skipped++;
		}
	}

	if (hasActivityLogs) {
		parseStockActivityLog().catch((err) => {
			logger.error("Error running debounced stock activity log sync:", err);
		});
	}

	return { processed, skipped };
}

/**
 * Reconciles historical stock logs from `personal_logs` into `stock_ledgers` and `ledger_events`.
 * Non-destructive: preserves existing records and fills in any unindexed stock gain logs.
 * Uses an anti-join query (LEFT JOIN ... WHERE stock_ledgers.id IS NULL) to reliably find
 * missed records regardless of timestamp ordering or event stutters.
 */
export async function reconcileHistoricalStockLogs(options?: {
	forceReplay?: boolean;
	wipeAndRebuild?: boolean;
}): Promise<{ replayed: number }> {
	const finishReconciliation = logger.time();
	const state = await loadStocksLedgerState();

	state.status = "running";
	await persistStocksLedgerState(state);

	try {
		logger.info("Starting Stocks Ledger reconciliation from personal_logs...");

		if (options?.wipeAndRebuild) {
			await db.delete(stockLedgers).run();
			await db
				.delete(ledgerEvents)
				.where(eq(ledgerEvents.type, "stock_dividend"))
				.run();
			state.lastProcessedTimestamp = null;
			state.totalIndexedLogs = 0;
		}

		await syncUserStocks();

		let logsToProcess: Array<{
			id: string;
			data: unknown;
			log: number;
			timestamp: Date;
			title: string | null;
			category: string | null;
		}>;

		if (options?.forceReplay || options?.wipeAndRebuild) {
			const historicalLogs = await db
				.select({
					id: personalLogs.id,
					data: personalLogs.data,
					log: personalLogs.log,
					timestamp: personalLogs.timestamp,
					title: personalLogs.title,
					category: personalLogs.category,
				})
				.from(personalLogs)
				.where(inArray(personalLogs.log, STOCK_GAIN_LOG_IDS))
				.orderBy(personalLogs.timestamp)
				.all();
			logsToProcess = historicalLogs;
		} else {
			const missingLogs = await db
				.select({
					id: personalLogs.id,
					data: personalLogs.data,
					log: personalLogs.log,
					timestamp: personalLogs.timestamp,
					title: personalLogs.title,
					category: personalLogs.category,
				})
				.from(personalLogs)
				.leftJoin(stockLedgers, eq(personalLogs.id, stockLedgers.id))
				.where(
					and(
						inArray(personalLogs.log, STOCK_GAIN_LOG_IDS),
						isNull(stockLedgers.id),
					),
				)
				.orderBy(personalLogs.timestamp)
				.all();
			logsToProcess = missingLogs;
		}

		if (logsToProcess.length === 0) {
			logger.info(
				"Stocks Ledger is already up to date. No missing stock gain logs found.",
			);
			state.status = "completed";
			state.lastError = null;
			await persistStocksLedgerState(state);
			finishReconciliation();
			return { replayed: 0 };
		}

		logger.info(
			`Found ${logsToProcess.length} unindexed stock gain log records in personal_logs. Processing...`,
		);

		let replayed = 0;
		for (const pLog of logsToProcess) {
			const userLogObj: UserLog = {
				id: String(pLog.id),
				timestamp: Math.floor(new Date(pLog.timestamp).getTime() / 1000),
				data: pLog.data as unknown as Record<string, never>,
				details: {
					id: pLog.log,
					title: pLog.title ?? "",
					category: pLog.category ?? "",
				},
				params: {},
			};

			const success = await parseStockGainLog(userLogObj);
			if (success) {
				replayed++;
			}
		}

		const totalStats = await db
			.select({ count: count(stockLedgers.id) })
			.from(stockLedgers)
			.get();

		state.totalIndexedLogs =
			totalStats?.count ?? state.totalIndexedLogs + replayed;
		state.status = "completed";
		state.lastError = null;
		await persistStocksLedgerState(state);

		logger.info(
			`Stocks Ledger reconciliation completed successfully. Total logs indexed: ${state.totalIndexedLogs}`,
		);
		finishReconciliation();
		return { replayed };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		state.status = "error";
		state.lastError = errorMessage;
		await persistStocksLedgerState(state);
		logger.error("Failed to reconcile Stocks Ledger:", error);
		return { replayed: 0 };
	}
}

/**
 * Aggregates total value and count per stock ID.
 */
export async function getStocksTotals(stockId?: number): Promise<
	Array<{
		stockId: number;
		totalValue: number;
		count: number;
	}>
> {
	const whereClause =
		stockId !== undefined ? eq(stockLedgers.stockId, stockId) : undefined;

	const groups = await db
		.select({
			stockId: stockLedgers.stockId,
			totalValue: sql<number>`COALESCE(sum(${stockLedgers.value}), 0)`,
			count: count(stockLedgers.id),
		})
		.from(stockLedgers)
		.where(whereClause)
		.groupBy(stockLedgers.stockId)
		.all();

	return groups.map((g) => ({
		stockId: g.stockId,
		totalValue: Number(g.totalValue),
		count: Number(g.count),
	}));
}

/**
 * Re-initializes the Stocks Ledger by wiping existing stock_ledgers & stock_dividend ledger_events
 * and regenerating all records from personal_logs.
 */
export async function reinitializeStocksLedger(): Promise<{
	replayed: number;
}> {
	return await reconcileHistoricalStockLogs({
		forceReplay: true,
		wipeAndRebuild: true,
	});
}

/**
 * Worker periodic handler for daily reconciliation check.
 */
export async function runStocksLedgerSync(): Promise<void> {
	await reconcileHistoricalStockLogs();
}

/**
 * Starts the Stocks Ledger worker:
 * 1. Listens for real-time `logs_inserted` stream events.
 * 2. Runs daily reconciliation maintenance runner.
 */
export function startStocksLedger(options?: WorkerStartOptions): void {
	// 1. Live stream processing
	schedulerEvents.on("logs_inserted", (logs: UserLog[]) => {
		processStockLogsBatch(logs).catch((err) => {
			logger.error("Error processing real-time stock logs batch:", err);
		});
	});

	// 2. Register daily runner with initial staggered delay
	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: CADENCE_SEC,
		initialDelayMs: options?.initialDelayMs,
		handler: runStocksLedgerSync,
	});
}
