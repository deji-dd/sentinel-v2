import { db, travelDestinations } from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "torn:abroad_stocks";
const logger = new Logger(WORKER_NAME);

// Cadence: Run every 5 minutes (300 seconds) to track YATA item depletion
const CADENCE_SEC = 300;

type YataStockItem = {
	id: number;
	name: string;
	quantity: number;
	cost: number;
};

type YataCountryData = {
	update: number;
	country: string;
	stocks: YataStockItem[];
};

type YataExportResponse = {
	stocks?: Record<string, YataCountryData>;
};

export type TravelStockHistoryPoint = {
	timestamp: number;
	quantity: number;
};

export type TravelStockItem = {
	id: number;
	name: string;
	quantity: number;
	cost: number;
	history: TravelStockHistoryPoint[];
};

/**
 * Polls YATA travel export every 5 minutes and updates SQLite `travel_destinations` records.
 * Uses a single SQLite transaction to batch all destination upserts atomically.
 */
export async function runTravelSync(): Promise<void> {
	const finishLog = logger.time();

	try {
		const res = await fetch("https://yata.yt/api/v1/travel/export/");
		if (!res.ok) {
			throw new Error(`YATA API HTTP ${res.status}: ${res.statusText}`);
		}

		const data = (await res.json()) as YataExportResponse;
		const stocksMap = data.stocks;

		if (!stocksMap || Object.keys(stocksMap).length === 0) {
			logger.warn("No travel stocks data received from YATA export API.");
			return;
		}

		const nowTimestamp = Date.now();

		// Fetch existing destinations from database
		const existingDestinations = await db.query.travelDestinations.findMany();
		const existingMap = new Map(
			existingDestinations.map((d) => {
				const rawStocks = d.stocks;
				const stocksList: TravelStockItem[] = Array.isArray(rawStocks)
					? (rawStocks as TravelStockItem[])
					: typeof rawStocks === "string"
						? (JSON.parse(rawStocks) as TravelStockItem[])
						: [];
				return [d.id, stocksList];
			}),
		);

		const now = new Date();
		const upsertRows = Object.entries(stocksMap).map(
			([countryCode, countryData]) => {
				const existingStocks = existingMap.get(countryCode) ?? [];
				const existingStockMap = new Map(
					existingStocks.map((s) => [s.id, s.history ?? []]),
				);

				const updatedStocks: TravelStockItem[] = countryData.stocks.map(
					(item) => {
						const history = existingStockMap.get(item.id) ?? [];
						const updatedHistory = [
							...history,
							{ timestamp: nowTimestamp, quantity: item.quantity },
						];

						return {
							id: item.id,
							name: item.name,
							quantity: item.quantity,
							cost: item.cost,
							history: updatedHistory,
						};
					},
				);

				return {
					id: countryCode,
					name: countryData.country ?? countryCode,
					stocks: updatedStocks,
					createdAt: now,
					updatedAt: now,
				};
			},
		);

		// Execute all upserts in 1 single atomic SQLite transaction
		await db.transaction(async (tx) => {
			for (const row of upsertRows) {
				await tx
					.insert(travelDestinations)
					.values(row)
					.onConflictDoUpdate({
						target: travelDestinations.id,
						set: {
							name: row.name,
							stocks: row.stocks,
							updatedAt: row.updatedAt,
						},
					});
			}
		});

		logger.info(
			`Successfully batch-synced ${upsertRows.length} travel destinations into SQLite.`,
		);

		finishLog();
	} catch (error) {
		logger.error("Failed to execute travel sync:", error);
	}
}

/**
 * Initializes and starts the travel sync background worker.
 */
export function startTornAbroadStocks(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: CADENCE_SEC,
		initialDelayMs: options?.initialDelayMs,
		handler: runTravelSync,
	});
}
