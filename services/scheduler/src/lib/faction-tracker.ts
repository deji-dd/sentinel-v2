import { db, eq, factions, inArray } from "@sentinel/database";
import type { TornSchema } from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";

const logger = new Logger("FactionTracker");
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 5; // Max factions to fetch in a single trickle batch

type FactionBasicResponse = TornSchema<"FactionBasicResponse">;
export type FactionRecord = typeof factions.$inferSelect;

// In-memory queue of pending faction IDs waiting to be fetched
const pendingFactionQueue = new Set<number>();
// In-memory set tracking faction IDs currently being fetched in-flight
const inFlightFactionIds = new Set<number>();
// In-memory map caching last known updatedAt timestamp (ms) per faction ID
const trackedFactionTimestamps = new Map<number, number>();

let isProcessingQueue = false;

/**
 * Background worker function that drains the pendingFactionQueue in controlled chunks of 10.
 */
async function processPendingFactionQueue(): Promise<void> {
	if (isProcessingQueue || pendingFactionQueue.size === 0) {
		return;
	}

	isProcessingQueue = true;

	try {
		while (pendingFactionQueue.size > 0) {
			// Extract up to BATCH_SIZE items from the queue
			const batchIds: number[] = [];
			for (const id of pendingFactionQueue) {
				if (batchIds.length >= BATCH_SIZE) break;
				batchIds.push(id);
			}

			// Remove extracted IDs from queue and mark as in-flight
			for (const id of batchIds) {
				pendingFactionQueue.delete(id);
				inFlightFactionIds.add(id);
			}

			logger.info(
				`Processing trickle sync batch for ${batchIds.length} factions (Remaining queue: ${pendingFactionQueue.size})...`,
			);

			try {
				const responses = (await tornApi.executeBatch(
					"/faction/{id}/basic",
					batchIds,
					(factionId) => ({ pathParams: { id: Number(factionId) } }),
				)) as FactionBasicResponse[];

				const validResponses = responses.filter((r) => r?.basic);

				if (validResponses.length > 0) {
					const nowDb = new Date();
					await db.transaction(async (tx) => {
						for (const res of validResponses) {
							const basic = res.basic;
							if (!basic || typeof basic.id !== "number") continue;
							const facId = basic.id;

							await tx
								.insert(factions)
								.values({
									id: facId,
									name: basic.name ?? `Faction ${facId}`,
									tag: basic.tag ?? null,
									tagImage: basic.tag_image ?? null,
									leaderId: basic.leader_id ?? null,
									coLeaderId: basic.co_leader_id ?? null,
									respect: basic.respect ?? 0,
									capacity: basic.capacity ?? 0,
									membersCount:
										typeof basic.members === "number" ? basic.members : 0,
									data: basic,
									createdAt: nowDb,
									updatedAt: nowDb,
								})
								.onConflictDoUpdate({
									target: factions.id,
									set: {
										name: basic.name ?? `Faction ${facId}`,
										tag: basic.tag ?? null,
										tagImage: basic.tag_image ?? null,
										leaderId: basic.leader_id ?? null,
										coLeaderId: basic.co_leader_id ?? null,
										respect: basic.respect ?? 0,
										capacity: basic.capacity ?? 0,
										membersCount:
											typeof basic.members === "number" ? basic.members : 0,
										data: basic,
										updatedAt: nowDb,
									},
								});

							trackedFactionTimestamps.set(facId, Date.now());
						}
					});
				}
			} catch (err) {
				logger.error("Failed to sync faction trickle batch:", err);
			} finally {
				for (const id of batchIds) {
					inFlightFactionIds.delete(id);
				}
			}

			// Small stagger between batches if more items remain in queue
			if (pendingFactionQueue.size > 0) {
				await new Promise((resolve) => setTimeout(resolve, 2500));
			}
		}
	} finally {
		isProcessingQueue = false;
	}
}

/**
 * [POST/SYNC] Submits an array of faction IDs to be checked and stored in the database.
 * Missing or stale (>24h) faction IDs are added to the background trickle queue and processed in controlled batches of 10.
 *
 * @param factionIds Array of numeric Torn Faction IDs
 * @returns Promise resolving to the number of new faction IDs queued for sync
 */
export async function trackFactions(
	factionIds: (number | null | undefined)[],
): Promise<number> {
	const validIds = Array.from(
		new Set(
			factionIds.filter((id): id is number => typeof id === "number" && id > 0),
		),
	);

	if (validIds.length === 0) return 0;

	const now = Date.now();
	const cutoff = now - TWENTY_FOUR_HOURS_MS;

	// Filter out IDs that are already fresh in memory (< 24h), in-flight, or already queued
	const idsNeedingCheck = validIds.filter((id) => {
		if (inFlightFactionIds.has(id) || pendingFactionQueue.has(id)) return false;
		const lastUpdated = trackedFactionTimestamps.get(id);
		return !lastUpdated || lastUpdated < cutoff;
	});

	if (idsNeedingCheck.length === 0) {
		return 0;
	}

	try {
		const existing = await db.query.factions.findMany({
			where: inArray(factions.id, idsNeedingCheck),
		});

		for (const f of existing) {
			trackedFactionTimestamps.set(f.id, f.updatedAt.getTime());
		}

		const existingMap = new Map(
			existing.map((f) => [f.id, f.updatedAt.getTime()]),
		);

		// Exclude IDs already saved in DB < 24h ago
		const idsToQueue = idsNeedingCheck.filter((id) => {
			const lastUpdated = existingMap.get(id);
			return !lastUpdated || lastUpdated < cutoff;
		});

		if (idsToQueue.length === 0) {
			return 0;
		}

		// Enqueue missing/stale IDs into background trickle queue
		for (const id of idsToQueue) {
			pendingFactionQueue.add(id);
		}

		// Trigger queue processing asynchronously in background (non-blocking)
		processPendingFactionQueue().catch((err) => {
			logger.error("Error running processPendingFactionQueue:", err);
		});

		return idsToQueue.length;
	} catch (error) {
		logger.error("Failed to execute trackFactions:", error);
		return 0;
	}
}

/**
 * [GET] Retrieves faction data for a given faction ID.
 * Returns cached DB data if available. If missing or stale (>24h), enqueues for background sync.
 */
export async function getFaction(
	factionId: number,
): Promise<FactionRecord | null> {
	if (!factionId || factionId <= 0) return null;

	const now = Date.now();
	const cutoff = now - TWENTY_FOUR_HOURS_MS;

	// 1. Check SQLite database first
	const existing = await db.query.factions.findFirst({
		where: eq(factions.id, factionId),
	});

	if (existing) {
		trackedFactionTimestamps.set(existing.id, existing.updatedAt.getTime());
		if (existing.updatedAt.getTime() < cutoff) {
			trackFactions([factionId]).catch(() => {});
		}
		return existing;
	}

	// 2. Missing -> Enqueue for background trickle sync and await single item sync if needed
	await trackFactions([factionId]);

	const fresh = await db.query.factions.findFirst({
		where: eq(factions.id, factionId),
	});

	return fresh ?? null;
}

/**
 * [GET BULK] Retrieves faction data for an array of faction IDs from SQLite DB immediately,
 * while queueing any missing/stale factions for background trickle sync.
 */
export async function getFactions(
	factionIds: number[],
): Promise<Map<number, FactionRecord>> {
	const validIds = Array.from(
		new Set(factionIds.filter((id) => typeof id === "number" && id > 0)),
	);

	if (validIds.length === 0) return new Map();

	// Enqueue missing/stale factions asynchronously without blocking caller
	trackFactions(validIds).catch(() => {});

	const records = await db.query.factions.findMany({
		where: inArray(factions.id, validIds),
	});

	return new Map(records.map((r) => [r.id, r]));
}
