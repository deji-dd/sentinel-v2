import { db, eq, systemStates } from "@sentinel/database";
import type { DibsRecord } from "@sentinel/schemas";
import { Logger } from "@sentinel/utils";

const logger = new Logger("API", "DibsRecordStore");

/**
 * Single systemStates row holding every active dibs record, claims included.
 *
 * The board itself lives in RAM for the hot 1-second evaluation loop, but RAM
 * does not survive a deploy: before this row existed, restarting the API
 * container dropped every claim and left the rebuilt records open, so members
 * lost dibs they were holding. It also emptied the sweeper's live set, which
 * then deleted those targets' Discord callouts as orphans.
 *
 * Kept in systemStates rather than a dedicated table so no schema migration is
 * required, exactly like the dibs message ledger.
 */
const DIBS_RECORDS_ID = "subversive:dibs_records";

interface DibsRecordsState {
	records: DibsRecord[];
	updatedAt?: string;
}

class DibsRecordStore {
	/**
	 * Serialized form of the payload last written or read.
	 *
	 * Deliberately a string, not the record objects: the manager mutates loaded
	 * records in place (lock timers, hospital-until syncs), so comparing against
	 * held references would compare an object with itself and skip every write.
	 */
	private lastKnownJson: string | null = null;
	private writeQueue: Promise<void> = Promise.resolve();

	/**
	 * Reads the persisted board. Returns an empty list when nothing was ever
	 * written, or when the row cannot be read (the caller still starts clean).
	 */
	async load(): Promise<DibsRecord[]> {
		try {
			const [entry] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, DIBS_RECORDS_ID));

			const data = entry?.data as DibsRecordsState | undefined;
			const records = Array.isArray(data?.records) ? data.records : [];
			this.lastKnownJson = JSON.stringify(records);
			return records;
		} catch (err) {
			logger.warn("Failed to read persisted dibs records:", err);
			this.lastKnownJson = null;
			return [];
		}
	}

	/**
	 * Persists the board. Writes are skipped when the payload is unchanged, so
	 * the lock timer and hospital-until bookkeeping cannot turn into a write per
	 * evaluation cycle.
	 */
	async save(records: DibsRecord[]): Promise<void> {
		// Serialize up front: the caller keeps mutating these records, and the
		// queued write must capture the state as of this call.
		const serialized = JSON.stringify(records);
		if (this.lastKnownJson === serialized) return;

		this.writeQueue = this.writeQueue.then(async () => {
			const data: DibsRecordsState = {
				records,
				updatedAt: new Date().toISOString(),
			};

			// Track the payload before awaiting the write so a failed write does
			// not turn into a retry storm on every evaluation cycle.
			this.lastKnownJson = serialized;

			try {
				await db
					.insert(systemStates)
					.values({
						id: DIBS_RECORDS_ID,
						init: true,
						data: data as unknown as Record<string, unknown>,
						createdAt: new Date(),
						updatedAt: new Date(),
					})
					.onConflictDoUpdate({
						target: systemStates.id,
						set: {
							data: data as unknown as Record<string, unknown>,
							updatedAt: new Date(),
						},
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

	/** Forgets the last payload so the next write is not skipped (tests). */
	invalidate(): void {
		this.lastKnownJson = null;
	}
}

export const dibsRecordStore = new DibsRecordStore();
