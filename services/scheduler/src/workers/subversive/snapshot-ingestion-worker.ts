import { db, sql, subversiveTargetFinderTargets } from "@sentinel/database";
import { tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import {
	getNextSubversiveUserKey,
	hasActiveSubversiveKeys,
} from "./subversive-key-pool";

const logger = new Logger("SubversiveSnapshotIngestionWorker");

/**
 * Parses a simple CSV string into rows of string arrays.
 */
function parseCsv(csvText: string): string[][] {
	const lines = csvText.split(/\r?\n/);
	const rows: string[][] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// Split by comma; values in Torn snapshots do not contain escaped commas
		rows.push(trimmed.split(",").map((col) => col.trim()));
	}

	return rows;
}

/**
 * Downloads and processes the daily Torn active players snapshot CSV.
 */
export async function ingestDailyUserSnapshot(): Promise<number> {
	const activeKeys = await hasActiveSubversiveKeys();
	if (!activeKeys) {
		logger.debug(
			"No active Subversive user keys enrolled. Snapshot ingestion worker dormant.",
		);
		return 0;
	}

	const key = await getNextSubversiveUserKey();
	if (!key) return 0;

	try {
		await tornApi.rateLimiter.waitIfNeeded(key.userId);

		const url = `https://api.torn.com/v2/user/snapshot?key=${encodeURIComponent(key.apiKey)}`;
		const res = await fetch(url, {
			headers: {
				Accept: "text/csv, text/plain, */*",
				"User-Agent": "Sentinel/2.0 (Target Ingestion)",
			},
		});

		if (!res.ok) {
			logger.warn(
				`Failed to fetch /user/snapshot from Torn API (HTTP ${res.status}).`,
			);
			return 0;
		}

		const csvText = await res.text();
		if (!csvText || csvText.includes('"error"')) {
			logger.warn(`Invalid snapshot CSV response: ${csvText.slice(0, 100)}`);
			return 0;
		}

		const rows = parseCsv(csvText);
		if (rows.length <= 1) {
			logger.info("Snapshot CSV returned empty or only header.");
			return 0;
		}

		const header = rows[0] ?? [];
		const idIdx = header.indexOf("id");
		const nameIdx = header.indexOf("name");
		const signedUpIdx = header.indexOf("signed_up");
		const levelIdx = header.indexOf("level");
		const factionIdx = header.indexOf("faction");
		const fedIdx = header.indexOf("fed");

		if (idIdx === -1 || signedUpIdx === -1) {
			logger.error("Required columns missing from snapshot CSV.");
			return 0;
		}

		const now = Date.now();
		const candidates: Array<{
			targetId: number;
			name: string;
			level: number;
			factionId: number | null;
			daysOld: number;
			isFactionless: boolean;
			isInactive: boolean;
			inHospital: boolean;
			estimatedBs: number;
			estimatedScore: number;
			status: string;
			updatedAt: Date;
		}> = [];

		for (let i = 1; i < rows.length; i++) {
			const row = rows[i];
			if (!row) continue;

			const idStr = row[idIdx];
			if (!idStr) continue;
			const targetId = Number.parseInt(idStr, 10);
			if (!targetId || Number.isNaN(targetId)) continue;

			// Check fed status
			const fed = fedIdx !== -1 ? row[fedIdx] : "0";
			if (fed && fed !== "0") continue;

			// Check account age (must be at least 14 days old)
			const signedUpStr = row[signedUpIdx] ?? "";
			let daysOld = 0;
			const signedUpTime = Number.parseInt(signedUpStr, 10);
			if (!Number.isNaN(signedUpTime) && signedUpTime > 0) {
				daysOld = Math.floor((now / 1000 - signedUpTime) / 86400);
			} else {
				const parsedDate = Date.parse(signedUpStr);
				if (!Number.isNaN(parsedDate)) {
					daysOld = Math.floor((now - parsedDate) / 86400000);
				}
			}

			if (daysOld < 14) continue;

			const name = (nameIdx !== -1 ? row[nameIdx] : "") || `Player ${targetId}`;
			const levelStr = levelIdx !== -1 ? row[levelIdx] : "1";
			const level = Number.parseInt(levelStr ?? "1", 10) || 1;

			const factionStr = factionIdx !== -1 ? row[factionIdx] : "";
			const factionIdParsed = Number.parseInt(factionStr ?? "0", 10);
			const factionId =
				!Number.isNaN(factionIdParsed) && factionIdParsed > 0
					? factionIdParsed
					: null;
			const isFactionless = factionId === null;

			candidates.push({
				targetId,
				name,
				level,
				factionId,
				daysOld,
				isFactionless,
				isInactive: false,
				inHospital: false,
				estimatedBs: 0,
				estimatedScore: 0,
				status: "okay",
				updatedAt: new Date(now),
			});
		}

		logger.info(
			`Parsed ${candidates.length} valid eligible target candidates from snapshot. Upserting in batches...`,
		);

		// Batch upsert in chunks of 500
		const BATCH_SIZE = 500;
		let insertedTotal = 0;

		for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
			const chunk = candidates.slice(i, i + BATCH_SIZE);
			await db
				.insert(subversiveTargetFinderTargets)
				.values(chunk)
				.onConflictDoUpdate({
					target: subversiveTargetFinderTargets.targetId,
					set: {
						name: sql`excluded.name`,
						level: sql`excluded.level`,
						factionId: sql`excluded.faction_id`,
						daysOld: sql`excluded.days_old`,
						isFactionless: sql`excluded.is_factionless`,
						updatedAt: sql`excluded.updated_at`,
					},
				});
			insertedTotal += chunk.length;
		}

		logger.info(
			`Successfully ingested ${insertedTotal} targets from daily snapshot.`,
		);
		return insertedTotal;
	} catch (error) {
		logger.error("Failed to ingest daily player snapshot:", error);
		return 0;
	}
}

export const startSubversiveSnapshotIngestionWorker: WorkerStarter =
	(options?: { initialDelayMs?: number }) => {
		startEventDrivenRunner({
			worker: "subversive:snapshot_ingestion_worker",
			defaultCadenceSeconds: 86400, // Once every 24 hours
			initialDelayMs: options?.initialDelayMs ?? 30000,
			handler: async () => {
				await ingestDailyUserSnapshot();
			},
		});
	};
