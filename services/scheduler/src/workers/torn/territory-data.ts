import { db, territoryBlueprints } from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import {
	getNextUtcTargetTimestamp,
	startEventDrivenRunner,
} from "../../lib/scheduler";
import type { WorkerStartOptions } from "../registry";

const WORKER_NAME = "torn:territory_data";
const logger = new Logger(WORKER_NAME);

type SingleTerritory = TornSchema<"TornTerritory">;

/**
 * Core extraction and bulk dump engine for territory blueprints.
 * Executes multi-key parallel batch requests across offsets via centralized tornApi.
 */
async function fetchAndDumpData(): Promise<number> {
	const finishLog = logger.time();

	try {
		const limit = 250;
		const estimatedTotal = 4500;
		const pageCount = Math.ceil(estimatedTotal / limit);
		const offsets = Array.from({ length: pageCount }, (_, i) => i * limit);

		// Execute parallel batch requests across all offsets using central key pool & rate limiter
		const responses = (await tornApi.executeBatch(
			"/torn/territory",
			offsets,
			(offset) => ({ queryParams: { offset, limit } }),
		)) as TornSchema<"TornTerritoriesResponse">[];

		const territories: SingleTerritory[] = responses.flatMap(
			(res) => res.territory || [],
		);

		if (territories.length === 0) {
			logger.warn("Received empty territories response from Torn API.");
			return getNextUtcTargetTimestamp(3, 0);
		}

		logger.info(
			`Fetched ${territories.length} territory blueprints across ${offsets.length} parallel requests. Dumping to SQLite...`,
		);

		// Bulk database transaction in chunks of 500
		const chunkSize = 500;
		const now = new Date();

		for (let i = 0; i < territories.length; i += chunkSize) {
			const chunk = territories.slice(i, i + chunkSize);

			await db.transaction(async (tx) => {
				for (const item of chunk) {
					await tx
						.insert(territoryBlueprints)
						.values({
							id: item.id,
							sector: item.sector,
							size: item.size,
							density: item.density,
							slots: item.slots,
							data: item,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoUpdate({
							target: territoryBlueprints.id,
							set: {
								sector: item.sector,
								size: item.size,
								density: item.density,
								slots: item.slots,
								data: item,
								updatedAt: now,
							},
						});
				}
			});
		}

		logger.info(
			`Successfully upserted ${territories.length} territory blueprints to SQLite.`,
		);
		finishLog();

		return getNextUtcTargetTimestamp(3, 0);
	} catch (error) {
		logger.error("Failed to execute territory blueprint extraction:", error);
		return getNextUtcTargetTimestamp(3, 0);
	}
}

/**
 * Starts the event-driven territory data sync worker scheduled to run daily at 03:00 UTC.
 */
export function startTornTerritoryData(options?: WorkerStartOptions): void {
	startEventDrivenRunner({
		worker: WORKER_NAME,
		defaultCadenceSeconds: 86400,
		initialDelayMs: options?.initialDelayMs,
		handler: fetchAndDumpData,
	});
}
