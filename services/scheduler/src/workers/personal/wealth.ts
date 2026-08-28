import {
	companyDailyProfits,
	count,
	db,
	eq,
	gte,
	ledgerEvents,
	personalLogs,
	sql,
	systemStates,
	tornItems,
} from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";
import { extractItemMarketPrice, Logger } from "@sentinel/utils";
import { schedulerEvents } from "../../lib/events";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "personal:wealth";
const STATE_ID = "personal:wealth";
const CADENCE_SEC = 3600; // Hourly reconciliation sync

const logger = new Logger("Scheduler", "Wealth");
export type UserLog = TornSchema<"UserLog">;

export type WealthBreakdown = {
	totalInflow: number;
	totalOutflow: number;
	netProfit: number;
	crimesInflow: number;
	stocksInflow: number;
	companyInflow: number;
	companyOutflow: number;
	otherInflow: number;
};

export type WealthState = {
	init: boolean;
	initTimestamp: number | null; // Cutoff timestamp in seconds; logs prior to this are ignored
	status: "idle" | "running" | "completed" | "error";
	lastSyncTimestamp: number | null;
	lastError: string | null;
	updatedAt: string;
	totals: WealthBreakdown;
	totalEventsIndexed: number;
};

const DEFAULT_BREAKDOWN: WealthBreakdown = {
	totalInflow: 0,
	totalOutflow: 0,
	netProfit: 0,
	crimesInflow: 0,
	stocksInflow: 0,
	companyInflow: 0,
	companyOutflow: 0,
	otherInflow: 0,
};

const DEFAULT_WEALTH_STATE: WealthState = {
	init: false,
	initTimestamp: null,
	status: "idle",
	lastSyncTimestamp: null,
	lastError: null,
	updatedAt: new Date().toISOString(),
	totals: { ...DEFAULT_BREAKDOWN },
	totalEventsIndexed: 0,
};

let inMemoryState: WealthState = { ...DEFAULT_WEALTH_STATE };

/**
 * Loads the wealth tracking state from SQLite system_states.
 */
export async function loadWealthState(): Promise<WealthState> {
	try {
		const record = await db.query.systemStates.findFirst({
			where: eq(systemStates.id, STATE_ID),
		});

		if (record?.data && typeof record.data === "object") {
			const saved = record.data as Partial<WealthState>;
			inMemoryState = {
				...DEFAULT_WEALTH_STATE,
				...saved,
				init: Boolean(record.init ?? saved.init),
				totals: {
					...DEFAULT_BREAKDOWN,
					...(saved.totals ?? {}),
				},
				updatedAt: new Date().toISOString(),
			};
		} else {
			inMemoryState = { ...DEFAULT_WEALTH_STATE };
		}
	} catch (error) {
		logger.error("Failed to load Wealth state:", error);
		inMemoryState = { ...DEFAULT_WEALTH_STATE };
	}
	return { ...inMemoryState };
}

import { getActiveIpcServer } from "../../lib/ipc/server";

/**
 * Persists the wealth state to SQLite system_states.
 */
export async function persistWealthState(state: WealthState): Promise<void> {
	state.updatedAt = new Date().toISOString();
	inMemoryState = { ...state };

	try {
		const now = new Date();
		await db
			.insert(systemStates)
			.values({
				id: STATE_ID,
				init: state.init,
				data: state,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: systemStates.id,
				set: {
					init: state.init,
					data: state,
					updatedAt: now,
				},
			});

		const ipc = getActiveIpcServer();
		if (ipc) {
			ipc.broadcast({
				action: "wealth_state_updated",
				data: state,
			});
		}
	} catch (error) {
		logger.error("Failed to persist Wealth state:", error);
	}
}

export function getWealthState(): WealthState {
	return { ...inMemoryState };
}

import { assets } from "@sentinel/database";
import { getPersonalKey, tornApi } from "@sentinel/torn-api";

/**
 * Fetches all unique item categories dynamically from `torn_items` in SQLite.
 */
export async function getUniqueItemCategories(): Promise<string[]> {
	const allItems = await db
		.select({ data: tornItems.data })
		.from(tornItems)
		.all();

	const categoriesSet = new Set<string>();
	for (const item of allItems) {
		if (item.data && typeof item.data === "object") {
			const itemObj = item.data as Record<string, unknown>;
			const cat = (itemObj.type ?? itemObj.category) as string | undefined;
			if (cat && typeof cat === "string" && cat.trim().length > 0) {
				categoriesSet.add(cat.trim());
			}
		}
	}

	return Array.from(categoriesSet).sort();
}

/**
 * Initializes or resets Wealth tracking with a full baseline snapshot of inventory,
 * bazaar, display items, points, and wallet from Torn API into the `assets` table.
 */
export async function initWealthTracking(
	startTimestampSec?: number,
): Promise<WealthState> {
	const currentSec = Math.floor(Date.now() / 1000);
	const initTimestamp = startTimestampSec ?? currentSec;
	const startTime = performance.now();

	const state: WealthState = {
		init: true,
		initTimestamp,
		status: "running",
		lastSyncTimestamp: currentSec,
		lastError: null,
		updatedAt: new Date().toISOString(),
		totals: { ...DEFAULT_BREAKDOWN },
		totalEventsIndexed: 0,
	};
	await persistWealthState(state);

	try {
		const keyEntry = await getPersonalKey();
		if (!keyEntry) {
			logger.warn(
				"No personal API key found. Initializing with empty baseline.",
			);
			state.status = "completed";
			await persistWealthState(state);
			return state;
		}

		logger.info("Snapshotting baseline assets from Torn API...");

		// 1. Wipe previous baseline assets and ledger events
		await db.delete(assets).all();
		await db.delete(ledgerEvents).all();

		// 2. Fetch baseline data from /user (money, bazaar, display)
		const userRes = (await tornApi.get("/user", {
			apiKey: keyEntry.apiKey,
			userId: keyEntry.userId,
			queryParams: { selections: ["money", "bazaar", "display"] },
		})) as Record<string, unknown>;

		const bazaar = (userRes.bazaar as Array<Record<string, unknown>>) ?? [];
		const display = (userRes.display as Array<Record<string, unknown>>) ?? [];
		const moneyData = (userRes.money as Record<string, unknown>) ?? {};
		const pointsCount = Number(moneyData.points ?? 0);
		const walletCash = Number(moneyData.wallet ?? 0);

		// 3. Pre-fetch Item Market Prices for baseline valuation
		const itemPriceMap = await fetchItemPricesMap();

		// 4. Fetch Inventory across all dynamic categories from DB
		const categories = await getUniqueItemCategories();
		let inventoryItems: Array<Record<string, unknown>> = [];
		for (const cat of categories) {
			try {
				const invRes = (await tornApi.get("/user/inventory", {
					apiKey: keyEntry.apiKey,
					userId: keyEntry.userId,
					queryParams: { cat: cat as never, limit: 250 },
				})) as Record<string, unknown>;

				const invPayload = invRes.inventory as {
					items?: Array<Record<string, unknown>>;
				};
				if (invPayload?.items && Array.isArray(invPayload.items)) {
					inventoryItems = inventoryItems.concat(invPayload.items);
				}
			} catch {
				// Category empty or skipped
			}
		}

		let totalBaselineAssetsValue = 0;
		const now = new Date();

		// Helper to insert items into assets table
		const insertBaselineItems = async (
			rawList: Array<Record<string, unknown>>,
			location: "inventory" | "bazaar" | "display",
		) => {
			for (const raw of rawList) {
				const itemId = Number(raw.id ?? raw.ID ?? 0);
				const itemUid = raw.uid ? Number(raw.uid) : null;
				const qty = Number(raw.amount ?? raw.quantity ?? 1);
				if (!itemId) continue;

				const marketPrice = itemPriceMap.get(String(itemId)) ?? 0;
				const totalCostBasis = marketPrice * qty;
				totalBaselineAssetsValue += totalCostBasis;

				if (itemUid) {
					const assetKey = `uid_${itemUid}`;
					await db
						.insert(assets)
						.values({
							id: assetKey,
							type: "item",
							assetId: String(itemId),
							quantity: 1,
							movingAverageCost: marketPrice,
							totalCostBasis: marketPrice,
							location,
							owner: "personal",
							origin: "baseline_init",
							realizedPnl: 0,
							lastUpdated: now,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: assets.id,
							set: {
								quantity: 1,
								movingAverageCost: marketPrice,
								totalCostBasis: marketPrice,
								location,
								updatedAt: now,
							},
						});
				} else {
					const assetKey = `item_${itemId}_${location}`;
					const existing = await db
						.select()
						.from(assets)
						.where(eq(assets.id, assetKey))
						.get();

					if (existing) {
						const newQty = existing.quantity + qty;
						const newCost = newQty * marketPrice;
						await db
							.update(assets)
							.set({
								quantity: newQty,
								totalCostBasis: newCost,
								movingAverageCost: marketPrice,
								updatedAt: now,
							})
							.where(eq(assets.id, assetKey));
					} else {
						await db.insert(assets).values({
							id: assetKey,
							type: "item",
							assetId: String(itemId),
							quantity: qty,
							movingAverageCost: marketPrice,
							totalCostBasis,
							location,
							owner: "personal",
							origin: "baseline_init",
							realizedPnl: 0,
							lastUpdated: now,
							createdAt: now,
							updatedAt: now,
						});
					}
				}
			}
		};

		// 5. Ingest all inventory, bazaar, and display items
		await insertBaselineItems(inventoryItems, "inventory");
		await insertBaselineItems(bazaar, "bazaar");
		await insertBaselineItems(display, "display");

		// 6. Ingest Points
		if (pointsCount > 0) {
			const pointRate = itemPriceMap.get("points") ?? 30000;
			const pointsValue = pointsCount * pointRate;
			totalBaselineAssetsValue += pointsValue;

			const pointsKey = "item_points_inventory";
			await db
				.insert(assets)
				.values({
					id: pointsKey,
					type: "point",
					assetId: "points",
					quantity: pointsCount,
					movingAverageCost: pointRate,
					totalCostBasis: pointsValue,
					location: "inventory",
					owner: "personal",
					origin: "baseline_init",
					realizedPnl: 0,
					lastUpdated: now,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoUpdate({
					target: assets.id,
					set: {
						quantity: pointsCount,
						movingAverageCost: pointRate,
						totalCostBasis: pointsValue,
						updatedAt: now,
					},
				});
		}

		// 7. Write Day Zero Initial Ledger Event
		const logDate = new Date(initTimestamp * 1000);
		await db
			.insert(ledgerEvents)
			.values({
				id: `ledger_ev_init_${initTimestamp}`,
				logId: "init",
				timestamp: logDate,
				type: "init",
				categoryId: 1,
				transactionName: "Wealth Engine Baseline Snapshot",
				assetsAffected: [],
				cashFlow: walletCash,
				realizedPnl: totalBaselineAssetsValue,
				rawLog: {
					wallet: walletCash,
					points: pointsCount,
					totalAssetValuation: totalBaselineAssetsValue,
					inventoryCount: inventoryItems.length,
					bazaarCount: bazaar.length,
					displayCount: display.length,
				},
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: ledgerEvents.id,
				set: {
					cashFlow: walletCash,
					realizedPnl: totalBaselineAssetsValue,
					updatedAt: now,
				},
			});

		state.status = "completed";
		await persistWealthState(state);

		const elapsedSec = ((performance.now() - startTime) / 1000).toFixed(2);
		logger.info(
			`Successfully snapshotted baseline wealth. Value imported: $${totalBaselineAssetsValue.toLocaleString()} in ${elapsedSec}s`,
		);
	} catch (error) {
		logger.error("Failed to snapshot baseline wealth:", error);
		state.status = "error";
		state.lastError = error instanceof Error ? error.message : String(error);
		await persistWealthState(state);
	}

	return state;
}

/**
 * Universal Item Extractor from Torn Log Data Payloads.
 * Handles arrays, single objects, dictionary maps, numeric ID, and points.
 */
export function extractItemsFromLogData(data: Record<string, unknown>): Array<{
	id: string | number;
	qty: number;
	uid?: number | null;
}> {
	const items: Array<{
		id: string | number;
		qty: number;
		uid?: number | null;
	}> = [];
	if (!data) return items;

	// Case 1: items: [{ id/item, qty/amount, uid }]
	if (Array.isArray(data.items)) {
		for (const it of data.items as Record<string, unknown>[]) {
			if (it && (it.id || it.item)) {
				items.push({
					id: (it.id ?? it.item) as string | number,
					qty: Number(it.quantity ?? it.qty ?? it.amount ?? 1),
					uid: it.uid ? Number(it.uid) : null,
				});
			}
		}
	} else if (Array.isArray(data.item)) {
		for (const it of data.item as Record<string, unknown>[]) {
			if (it && (it.id || it.item)) {
				items.push({
					id: (it.id ?? it.item) as string | number,
					qty: Number(it.quantity ?? it.qty ?? it.amount ?? 1),
					uid: it.uid ? Number(it.uid) : null,
				});
			}
		}
	} else if (data.items_gained && typeof data.items_gained === "object") {
		for (const [itemId, qty] of Object.entries(
			data.items_gained as Record<string, unknown>,
		)) {
			items.push({ id: itemId, qty: Number(qty ?? 1) });
		}
	} else if (
		data.item &&
		typeof data.item === "object" &&
		!Array.isArray(data.item)
	) {
		for (const [itemId, qty] of Object.entries(
			data.item as Record<string, unknown>,
		)) {
			items.push({ id: itemId, qty: Number(qty ?? 1) });
		}
	} else if (typeof data.item === "number" || typeof data.item === "string") {
		items.push({
			id: data.item as string | number,
			qty: Number(data.quantity ?? data.amount ?? 1),
		});
	}

	if (data.points && typeof data.points === "number") {
		items.push({ id: "points", qty: data.points });
	}

	return items;
}

/**
 * Universal Money Flow Extractor from Torn Log Data Payloads.
 * Returns direct cash gain (+) or cash loss (-).
 */
export function extractMoneyFlow(data: Record<string, unknown>): number {
	if (!data) return 0;

	// Money gained / received
	const moneyGained = Number(
		data.money_gained ?? data.money_won ?? data.profit ?? 0,
	);
	if (moneyGained > 0) return moneyGained;

	// Generic money property
	if (data.money !== undefined) {
		return Number(data.money);
	}

	// Money lost / spent
	const moneyLost = Number(data.money_lost ?? data.cost ?? data.loss ?? 0);
	if (moneyLost > 0) return -moneyLost;

	return 0;
}

/**
 * Pre-fetches item market prices into an in-memory map for fast lookups.
 */
export async function fetchItemPricesMap(): Promise<Map<string, number>> {
	const allItems = await db
		.select({ id: tornItems.id, data: tornItems.data })
		.from(tornItems)
		.all();

	const map = new Map<string, number>();
	for (const item of allItems) {
		if (item.data) {
			const price = extractItemMarketPrice(item.data);
			map.set(String(item.id), price);
		}
	}
	map.set("points", 30000); // Standard Torn points valuation fallback
	return map;
}

// Log ID Classification Maps
const CRIME_LOG_IDS = new Set([
	9010, 9015, 9020, 9025, 9027, 9030, 9050, 9051, 9052, 9053, 9055, 9056, 9060,
	9065, 9070, 9071, 9072, 9073, 9150, 9154, 9155, 9158, 9160, 9163, 9165, 9190,
	9191,
]);

const STOCK_LOG_IDS = new Set([1000, 1001, 1002, 1003, 1004, 1005]);
const BAZAAR_ITEM_SALE_IDS = new Set([1220, 1221, 1222, 1223, 1225]);
const TRADE_LOG_IDS = new Set([4430, 4440, 4441, 4445, 4446]);

/**
 * Parses an individual user log and writes financial transaction to `ledger_events`
 * if it occurred at or after the `initTimestamp`.
 */
export async function processWealthLog(
	log: UserLog,
	initTimestampSec: number,
	itemPrices: Map<string, number>,
): Promise<{ processed: boolean; value: number }> {
	const logTimestampSec = Number(log.timestamp);
	if (logTimestampSec < initTimestampSec) {
		return { processed: false, value: 0 };
	}

	const rawLogCode = (log as unknown as { log?: number }).log;
	const logDetails = log.details ?? {};
	const logTypeCode = Number(
		(logDetails as { id?: number }).id ?? rawLogCode ?? 0,
	);
	const rawPayload = (log.data ?? log) as Record<string, unknown>;

	const cashFlow = extractMoneyFlow(rawPayload);
	const extractedItems = extractItemsFromLogData(rawPayload);

	let itemsValue = 0;
	let costBasisConsumed = 0;
	const assetsAffected = [];

	const isItemSale = BAZAAR_ITEM_SALE_IDS.has(logTypeCode);
	const isCrimeReward = CRIME_LOG_IDS.has(logTypeCode);
	const isTrade = TRADE_LOG_IDS.has(logTypeCode);

	for (const item of extractedItems) {
		const isUid = !!(item.uid && typeof item.uid !== "boolean");
		const assetKey = isUid ? `uid_${item.uid}` : `item_${item.id}_inventory`;

		const existing = await db
			.select()
			.from(assets)
			.where(eq(assets.id, assetKey))
			.get();

		const systemPrice = itemPrices.get(String(item.id)) ?? 0;

		if (isItemSale) {
			// Item was sold: consume existing cost basis
			const mac = existing?.movingAverageCost ?? systemPrice;
			const consumed = mac * item.qty;
			costBasisConsumed += consumed;

			if (existing) {
				const newQty = Math.max(0, existing.quantity - item.qty);
				const newCost = newQty * mac;
				await db
					.update(assets)
					.set({
						quantity: newQty,
						totalCostBasis: newCost,
						updatedAt: new Date(),
					})
					.where(eq(assets.id, assetKey));
			}

			assetsAffected.push({
				assetId: String(item.id),
				quantityChange: -item.qty,
				costBasisImpact: -consumed,
			});
		} else {
			// Item was acquired: Crime drop has $0 cost basis; otherwise systemPrice or purchase cost
			const costPerUnit = isCrimeReward ? 0 : systemPrice;
			const addedCostBasis = costPerUnit * item.qty;
			itemsValue += addedCostBasis;

			if (existing) {
				const newQty = existing.quantity + item.qty;
				const newCost = existing.totalCostBasis + addedCostBasis;
				const newMac = newQty > 0 ? newCost / newQty : 0;
				await db
					.update(assets)
					.set({
						quantity: newQty,
						totalCostBasis: newCost,
						movingAverageCost: newMac,
						updatedAt: new Date(),
					})
					.where(eq(assets.id, assetKey));
			} else {
				await db.insert(assets).values({
					id: assetKey,
					type: String(item.id) === "points" ? "point" : "item",
					assetId: String(item.id),
					quantity: item.qty,
					movingAverageCost: costPerUnit,
					totalCostBasis: addedCostBasis,
					location: "inventory",
					owner: "personal",
					origin: isCrimeReward ? "crime_reward" : "log_ingest",
					realizedPnl: 0,
					lastUpdated: new Date(),
					createdAt: new Date(),
					updatedAt: new Date(),
				});
			}

			assetsAffected.push({
				assetId: String(item.id),
				quantityChange: item.qty,
				costBasisImpact: addedCostBasis,
			});
		}
	}

	// Realized P&L:
	// If selling item: Cash received minus Cost Basis consumed (e.g. $100k cash - $0 MAC = +$100k profit)
	// If crime reward: Cash received + 0 cost basis item
	// Otherwise: Cash Flow + Item Valuation
	const realizedPnl = isItemSale
		? cashFlow - costBasisConsumed
		: isCrimeReward
			? cashFlow
			: cashFlow + itemsValue;

	// If no financial money or item impact, skip
	if (realizedPnl === 0 && cashFlow === 0 && assetsAffected.length === 0) {
		return { processed: false, value: 0 };
	}

	// Classify transaction category
	let eventType = "other_income";
	let categoryId = 1;
	const title =
		logDetails.title ?? (log as unknown as { title?: string }).title;
	let transactionName = title ?? "Financial Transaction";

	if (isCrimeReward) {
		eventType = "crime_reward";
		categoryId = 7;
		transactionName = (rawPayload.crime_action as string) ?? "Crime Reward";
	} else if (STOCK_LOG_IDS.has(logTypeCode)) {
		eventType = "stock_dividend";
		categoryId = 8;
		transactionName = "Stock Dividend";
	} else if (isItemSale) {
		eventType = "bazaar_sale";
		categoryId = 2;
		transactionName = "Bazaar / Item Sale";
	} else if (isTrade) {
		eventType = "trade";
		categoryId = 6;
		transactionName = "Trade / Barter Exchange";
	} else if (realizedPnl > 0) {
		eventType = "inflow";
		categoryId = 1;
	} else {
		eventType = "loss";
		categoryId = 1;
	}

	const logIdStr = String(log.id);
	const eventId = `ledger_ev_${logIdStr}`;
	const logDate = new Date(logTimestampSec * 1000);
	const now = new Date();

	await db
		.insert(ledgerEvents)
		.values({
			id: eventId,
			logId: logIdStr,
			timestamp: logDate,
			type: eventType,
			categoryId,
			transactionName,
			assetsAffected,
			cashFlow,
			realizedPnl,
			rawLog: log as unknown as Record<string, unknown>,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: ledgerEvents.id,
			set: {
				logId: logIdStr,
				timestamp: logDate,
				type: eventType,
				categoryId,
				transactionName,
				assetsAffected,
				cashFlow,
				realizedPnl,
				updatedAt: now,
			},
		});

	return { processed: true, value: realizedPnl };
}

/**
 * Re-aggregates wealth totals from `ledger_events` and `company_daily_profits`
 * starting strictly from the `initTimestamp`.
 */
export async function recalculateWealthTotals(
	initTimestampSec: number,
): Promise<WealthBreakdown> {
	const initDate = new Date(initTimestampSec * 1000);

	const eventTotals = await db
		.select({
			type: ledgerEvents.type,
			totalPnl: sql<number>`COALESCE(sum(${ledgerEvents.realizedPnl}), 0)`,
			count: count(ledgerEvents.id),
		})
		.from(ledgerEvents)
		.where(gte(ledgerEvents.timestamp, initDate))
		.groupBy(ledgerEvents.type)
		.all();

	let crimesInflow = 0;
	let stocksInflow = 0;
	let otherInflow = 0;
	let totalInflow = 0;
	let totalOutflow = 0;

	for (const row of eventTotals) {
		const pnl = Number(row.totalPnl);
		if (row.type === "crime_reward") {
			crimesInflow += pnl;
		} else if (row.type === "stock_dividend") {
			stocksInflow += pnl;
		} else if (pnl > 0) {
			otherInflow += pnl;
		} else if (pnl < 0) {
			totalOutflow += Math.abs(pnl);
		}
	}

	// Company daily profits since initDate
	const companyRows = await db
		.select({
			inflow: sql<number>`COALESCE(sum(${companyDailyProfits.inflow}), 0)`,
			outflow: sql<number>`COALESCE(sum(${companyDailyProfits.outflow}), 0)`,
		})
		.from(companyDailyProfits)
		.where(gte(companyDailyProfits.timestamp, initDate))
		.get();

	const companyInflow = Number(companyRows?.inflow ?? 0);
	const companyOutflow = Number(companyRows?.outflow ?? 0);

	totalInflow = crimesInflow + stocksInflow + otherInflow + companyInflow;
	totalOutflow += companyOutflow;
	const netProfit = totalInflow - totalOutflow;

	return {
		totalInflow,
		totalOutflow,
		netProfit,
		crimesInflow,
		stocksInflow,
		companyInflow,
		companyOutflow,
		otherInflow,
	};
}

/**
 * Handles incoming real-time logs stream from `log-manager`.
 */
export async function handleIncomingWealthLogs(logs: UserLog[]): Promise<void> {
	const state = getWealthState();
	if (!state.init || state.initTimestamp === null) {
		return;
	}

	const initTimestamp = state.initTimestamp;
	const validLogs = logs.filter((l) => Number(l.timestamp) >= initTimestamp);
	if (validLogs.length === 0) return;

	state.status = "running";
	try {
		const itemPrices = await fetchItemPricesMap();
		let processedCount = 0;

		for (const log of validLogs) {
			const res = await processWealthLog(log, initTimestamp, itemPrices);
			if (res.processed) processedCount++;
		}

		state.totals = await recalculateWealthTotals(initTimestamp);
		state.totalEventsIndexed += processedCount;
		state.status = "completed";
		state.lastSyncTimestamp = Math.floor(Date.now() / 1000);
		state.lastError = null;
		await persistWealthState(state);
	} catch (err) {
		logger.error("Error processing incoming wealth logs:", err);
		state.status = "error";
		state.lastError = err instanceof Error ? err.message : String(err);
		await persistWealthState(state);
	}
}

/**
 * Reconciles wealth transactions from `personal_logs` where `timestamp >= initTimestamp`.
 */
export async function reconcileWealthTracker(): Promise<void> {
	const state = await loadWealthState();
	if (!state.init || state.initTimestamp === null) {
		return;
	}

	logger.info(
		`Reconciling wealth tracking starting from anchor: ${state.initTimestamp} (${new Date(state.initTimestamp * 1000).toISOString()})...`,
	);

	state.status = "running";
	await persistWealthState(state);

	try {
		const initDate = new Date(state.initTimestamp * 1000);
		const logsToProcess = await db
			.select({
				id: personalLogs.id,
				data: personalLogs.data,
				log: personalLogs.log,
				timestamp: personalLogs.timestamp,
				title: personalLogs.title,
			})
			.from(personalLogs)
			.where(gte(personalLogs.timestamp, initDate))
			.orderBy(personalLogs.timestamp)
			.all();

		if (logsToProcess.length > 0) {
			const itemPrices = await fetchItemPricesMap();
			for (const raw of logsToProcess) {
				const userLog: UserLog = {
					id: raw.id as unknown as string,
					log: raw.log,
					timestamp: Math.floor(new Date(raw.timestamp).getTime() / 1000),
					data: raw.data as Record<string, unknown>,
					title: raw.title ?? undefined,
				} as unknown as UserLog;

				await processWealthLog(userLog, state.initTimestamp, itemPrices);
			}
		}

		state.totals = await recalculateWealthTotals(state.initTimestamp);
		state.status = "completed";
		state.lastSyncTimestamp = Math.floor(Date.now() / 1000);
		state.lastError = null;
		await persistWealthState(state);
		logger.info("Wealth reconciliation completed successfully.");
	} catch (err) {
		logger.error("Failed to reconcile wealth tracker:", err);
		state.status = "error";
		state.lastError = err instanceof Error ? err.message : String(err);
		await persistWealthState(state);
	}
}

/**
 * Starts the Wealth Worker:
 * 1. Loads persisted state from DB.
 * 2. Listens to `logs_inserted` stream events for live tracking.
 * 3. Registers hourly reconciliation maintenance runner.
 */
export function startWealthModule(options?: WorkerStartOptions): void {
	loadWealthState()
		.then(async (state) => {
			// If not yet initialized, auto-initialize on boot if an API key is available
			if (!state.init || state.initTimestamp === null) {
				const key = await getPersonalKey();
				if (key) {
					logger.info(
						"Wealth tracking not yet initialized. Auto-snapshotting baseline assets on boot...",
					);
					await initWealthTracking();
				}
			}
		})
		.catch((err) => {
			logger.error("Failed to load initial wealth state:", err);
		});

	// Also auto-initialize when log backfill finishes if still uninitialized
	schedulerEvents.on("log_backfill_completed", async () => {
		const state = getWealthState();
		if (!state.init || state.initTimestamp === null) {
			logger.info(
				"Log backfill completed. Auto-snapshotting wealth baseline...",
			);
			await initWealthTracking();
		}
	});

	// 1. Live stream processing from log-manager
	schedulerEvents.on("logs_inserted", (logs: UserLog[]) => {
		handleIncomingWealthLogs(logs).catch((err) => {
			logger.error("Error processing live wealth logs stream:", err);
		});
	});

	// 2. Periodic reconciliation runner
	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: CADENCE_SEC,
		initialDelayMs: options?.initialDelayMs,
		handler: reconcileWealthTracker,
	});
}
