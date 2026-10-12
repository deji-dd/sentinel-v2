import {
	db,
	inArray,
	type NewSubversiveDibsRecordRow,
	subversiveDibsRecords,
} from "@sentinel/database";
import type { DibsClaimant, DibsRecord, DibsStatus } from "@sentinel/schemas";
import { Logger } from "@sentinel/utils";

const logger = new Logger("API", "DibsRecordStore");

/**
 * The active dibs board, one row per dibbed target in `subversive_dibs_records`.
 *
 * The board itself lives in RAM for the hot 1-second evaluation loop, but RAM
 * does not survive a deploy: before this was persisted, restarting the API
 * container dropped every claim and left the rebuilt records open, so members
 * lost dibs they were holding. It also emptied the sweeper's live set, which
 * then deleted those targets' Discord callouts as orphans.
 *
 * This previously lived as a single `system_states` row holding every record as
 * one JSON array, rewritten in full on every change — O(n) write amplification
 * on a value that grows with the board. `save` now diffs the incoming board
 * against what it last wrote and touches only the rows that actually changed,
 * which is what keeps it cheap: the manager calls `save` on a timer with the
 * whole board, and in the common case nothing has changed at all.
 */
class DibsRecordStore {
	/**
	 * Serialized form of each record as of the last write, keyed by target id.
	 *
	 * Deliberately strings rather than the record objects: the manager mutates
	 * loaded records in place (lock timers, hospital-until syncs), so comparing
	 * against held references would compare an object with itself and conclude
	 * that nothing had changed.
	 */
	private lastKnown = new Map<string, string>();
	private writeQueue: Promise<void> = Promise.resolve();

	/**
	 * Reads the persisted board. Returns an empty list when nothing was ever
	 * written, or when the read fails — the caller still starts from a clean
	 * board rather than failing to boot.
	 */
	async load(): Promise<DibsRecord[]> {
		try {
			const rows = await db.select().from(subversiveDibsRecords);
			const records = rows.map(rowToDibsRecord);
			this.lastKnown = new Map(
				records.map((record) => [
					String(record.targetId),
					JSON.stringify(record),
				]),
			);
			return records;
		} catch (err) {
			logger.warn("Failed to read persisted dibs records:", err);
			this.lastKnown = new Map();
			return [];
		}
	}

	/**
	 * Persists the board by applying only the differences from the last write.
	 *
	 * Rows for targets no longer on the board are deleted, changed and new
	 * records are upserted, and untouched records cost nothing. A completely
	 * unchanged board performs no query at all.
	 */
	async save(records: DibsRecord[]): Promise<void> {
		const next = new Map<string, string>();
		const toUpsert: DibsRecord[] = [];

		for (const record of records) {
			const key = String(record.targetId);
			const serialized = JSON.stringify(record);
			next.set(key, serialized);
			if (this.lastKnown.get(key) !== serialized) {
				toUpsert.push(record);
			}
		}

		const toDelete = [...this.lastKnown.keys()].filter((key) => !next.has(key));

		if (toUpsert.length === 0 && toDelete.length === 0) return;

		// Track the board before awaiting the write so a failure does not become
		// a retry storm on every evaluation cycle.
		this.lastKnown = next;

		this.writeQueue = this.writeQueue.then(async () => {
			try {
				await db.transaction(async (tx) => {
					if (toDelete.length > 0) {
						await tx
							.delete(subversiveDibsRecords)
							.where(
								inArray(subversiveDibsRecords.targetId, toDelete.map(Number)),
							);
					}

					// One statement per changed record. The board is small (tens of
					// live dibs) and only changed records reach here, so this stays
					// well inside a single transaction.
					for (const record of toUpsert) {
						const values = dibsRecordToRow(record);
						await tx
							.insert(subversiveDibsRecords)
							.values(values)
							.onConflictDoUpdate({
								target: subversiveDibsRecords.targetId,
								set: {
									factionId: values.factionId,
									targetName: values.targetName,
									targetLevel: values.targetLevel,
									estimatedBs: values.estimatedBs,
									fairFight: values.fairFight,
									hospitalUntil: values.hospitalUntil,
									status: values.status,
									claimedByTornId: values.claimedByTornId,
									claimedByTornName: values.claimedByTornName,
									claimedByDiscordId: values.claimedByDiscordId,
									claimedByDiscordTag: values.claimedByDiscordTag,
									claimedByPlatform: values.claimedByPlatform,
									claimedAt: values.claimedAt,
									discordMessageId: values.discordMessageId,
									discordChannelId: values.discordChannelId,
									exitHospAt: values.exitHospAt,
									recordCreatedAt: values.recordCreatedAt,
									updatedAt: new Date(),
								},
							});
					}
				});
			} catch (err) {
				logger.warn("Failed to persist dibs records:", err);
			}
		});

		return this.writeQueue;
	}

	/**
	 * Awaits queued writes. Used by tests and by callers that must know the
	 * board is durable before continuing.
	 */
	async flush(): Promise<void> {
		await this.writeQueue;
	}

	/** Forgets the last-written board so the next save is not skipped (tests). */
	invalidate(): void {
		this.lastKnown = new Map();
	}
}

/** Flattens a board record into its row, turning `undefined` into NULL. */
function dibsRecordToRow(record: DibsRecord): NewSubversiveDibsRecordRow {
	return {
		targetId: record.targetId,
		factionId: record.factionId ?? null,
		targetName: record.targetName,
		targetLevel: record.targetLevel,
		estimatedBs: record.estimatedBs,
		fairFight: record.fairFight,
		hospitalUntil: record.hospitalUntil,
		status: record.status,
		claimedByTornId: record.claimedBy?.tornId ?? null,
		claimedByTornName: record.claimedBy?.tornName ?? null,
		claimedByDiscordId: record.claimedBy?.discordId ?? null,
		claimedByDiscordTag: record.claimedBy?.discordTag ?? null,
		claimedByPlatform: record.claimedBy?.platform ?? null,
		claimedAt: record.claimedAt ?? null,
		discordMessageId: record.discordMessageId ?? null,
		discordChannelId: record.discordChannelId ?? null,
		exitHospAt: record.exitHospAt ?? null,
		recordCreatedAt: record.createdAt,
	};
}

/** Rebuilds a board record from its row, restoring optional fields as absent. */
function rowToDibsRecord(
	row: typeof subversiveDibsRecords.$inferSelect,
): DibsRecord {
	const hasClaimant =
		row.claimedByPlatform !== null ||
		row.claimedByTornId !== null ||
		row.claimedByTornName !== null ||
		row.claimedByDiscordId !== null ||
		row.claimedByDiscordTag !== null;

	// `DibsClaimant.platform` is mandatory in the type and every caller that
	// assigns a claim supplies it, so the fallback below is only reachable for a
	// hand-written row.
	const claimedBy: DibsClaimant | undefined = hasClaimant
		? {
				tornId: row.claimedByTornId ?? undefined,
				tornName: row.claimedByTornName ?? undefined,
				discordId: row.claimedByDiscordId ?? undefined,
				discordTag: row.claimedByDiscordTag ?? undefined,
				platform: row.claimedByPlatform === "script" ? "script" : "discord",
			}
		: undefined;

	return {
		targetId: row.targetId,
		factionId: row.factionId ?? undefined,
		targetName: row.targetName,
		targetLevel: row.targetLevel,
		estimatedBs: row.estimatedBs,
		fairFight: row.fairFight,
		hospitalUntil: row.hospitalUntil,
		status: (row.status === "claimed" ? "claimed" : "open") as DibsStatus,
		claimedBy,
		claimedAt: row.claimedAt ?? undefined,
		discordMessageId: row.discordMessageId ?? undefined,
		discordChannelId: row.discordChannelId ?? undefined,
		exitHospAt: row.exitHospAt ?? undefined,
		createdAt: row.recordCreatedAt,
	};
}

export const dibsRecordStore = new DibsRecordStore();
