import { db, eq, systemStates } from "@sentinel/database";
import { Logger } from "@sentinel/utils";
// Type-only import: erased at runtime, so this stays free of a module cycle.
import type { MercActiveTargetAlert } from "../workers/merc/merc-contract-worker";

const logger = new Logger("Scheduler", "MercStateStore");

/**
 * Single systemStates row holding the mercenary target manager's live state.
 *
 * The manager keeps everything in RAM: which targets are posted, who claimed
 * them, and — the part users notice — the hospital-exit baseline the 60-second
 * RW immunity is counted from. A scheduler redeploy (every deploy restarts it)
 * used to reset all of that: mercenaries lost their claims, duplicate alerts
 * were posted next to the orphaned originals, and targets already out of
 * hospital lost their immunity lock, so mercs were told a target was attackable
 * while Torn still had them immune.
 *
 * Kept in systemStates rather than a dedicated table so no schema migration is
 * required, matching the dibs record ledger.
 */
const MERC_STATE_ID = "merc:active_state";

/** Hospital bookkeeping for one target, keyed `contractId:targetId`. */
export interface MercHospitalRecord {
	wasInHospital: boolean;
	hospitalUntil: number | null;
	/** Epoch seconds at which the target was last seen out of hospital. */
	hospitalExitTime?: number;
	lastSeenHospSec: number;
}

/** The comparable payload, without the timestamp metadata. */
interface MercStatePayload {
	alerts: MercActiveTargetAlert[];
	/** Entries are [key, record] pairs so the shape survives JSON. */
	hospitalTracker: Array<[string, MercHospitalRecord]>;
	offlineTracker: Array<[string, number]>;
}

export interface MercStateSnapshot extends MercStatePayload {
	updatedAt?: string;
}

class MercStateStore {
	/**
	 * Serialized form of the payload last written or read. A string rather than
	 * the objects themselves: the manager mutates loaded alerts in place on every
	 * tick, so comparing against held references would compare an object with
	 * itself and skip every write.
	 */
	private lastKnownJson: string | null = null;
	private writeQueue: Promise<void> = Promise.resolve();

	/**
	 * Reads the persisted state. Returns null when nothing was ever written or the
	 * row cannot be read, so the caller starts from a clean board.
	 */
	async load(): Promise<MercStateSnapshot | null> {
		try {
			const [entry] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, MERC_STATE_ID));

			const data = entry?.data as MercStateSnapshot | undefined;
			if (!data || !Array.isArray(data.alerts)) {
				this.lastKnownJson = null;
				return null;
			}

			const snapshot: MercStateSnapshot = {
				alerts: data.alerts,
				hospitalTracker: Array.isArray(data.hospitalTracker)
					? data.hospitalTracker
					: [],
				offlineTracker: Array.isArray(data.offlineTracker)
					? data.offlineTracker
					: [],
				updatedAt: data.updatedAt,
			};
			this.lastKnownJson = MercStateStore.serialize(snapshot);
			return snapshot;
		} catch (err) {
			logger.warn("Failed to read persisted merc state:", err);
			this.lastKnownJson = null;
			return null;
		}
	}

	/**
	 * Persists the state. The write is skipped when the payload is unchanged, so
	 * the per-tick bookkeeping cannot turn into a write per cycle.
	 */
	async save(payload: MercStatePayload): Promise<void> {
		const serialized = MercStateStore.serialize(payload);
		if (this.lastKnownJson === serialized) return;

		this.writeQueue = this.writeQueue.then(async () => {
			// Track the payload before awaiting the write so a failed write does not
			// turn into a retry storm on every cycle.
			this.lastKnownJson = serialized;

			const row: MercStateSnapshot = {
				...payload,
				updatedAt: new Date().toISOString(),
			};

			try {
				await db
					.insert(systemStates)
					.values({
						id: MERC_STATE_ID,
						init: true,
						data: row as unknown as Record<string, unknown>,
						createdAt: new Date(),
						updatedAt: new Date(),
					})
					.onConflictDoUpdate({
						target: systemStates.id,
						set: {
							data: row as unknown as Record<string, unknown>,
							updatedAt: new Date(),
						},
					});
			} catch (err) {
				logger.warn("Failed to persist merc state:", err);
			}
		});

		return this.writeQueue;
	}

	/** Comparable form of a payload; `updatedAt` is metadata and excluded. */
	private static serialize(payload: MercStatePayload): string {
		return JSON.stringify({
			alerts: payload.alerts,
			hospitalTracker: payload.hospitalTracker,
			offlineTracker: payload.offlineTracker,
		});
	}

	/** Awaits queued writes (tests and graceful shutdown). */
	async flush(): Promise<void> {
		await this.writeQueue;
	}

	/** Forgets the last payload so the next write is not skipped (tests). */
	invalidate(): void {
		this.lastKnownJson = null;
	}
}

export const mercStateStore = new MercStateStore();
