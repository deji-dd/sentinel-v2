import {
	and,
	db,
	eq,
	inArray,
	mercActiveAlerts,
	mercHospitalTrackers,
	mercOfflineTrackers,
	normalizeMercContractMode,
} from "@sentinel/database";
import { Logger } from "@sentinel/utils";

// Type-only import: erased at runtime, so this stays free of a module cycle.
import type { MercActiveTargetAlert } from "../workers/merc/merc-contract-worker";

const logger = new Logger("Scheduler", "MercStateStore");

/**
 * The mercenary target manager's live state: which targets are posted, who
 * claimed them, and — the part users notice — the hospital-exit baseline the
 * 60-second ranked-war immunity is counted from.
 *
 * The manager keeps everything in RAM. A scheduler redeploy (every deploy
 * restarts it) used to reset all of it: mercenaries lost their claims, duplicate
 * alerts were posted next to the orphaned originals, and targets already out of
 * hospital lost their immunity lock, so mercs were told a target was attackable
 * while Torn still had them immune.
 *
 * This previously lived in one `system_states` JSON object — the alerts list
 * plus both tracker maps — rewritten in full whenever anything changed. Each
 * collection is now its own table keyed by `contractId:targetId`, matching the
 * maps the worker holds in memory, and `save` writes only the entries that
 * actually changed.
 */
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

/**
 * Splits a `contractId:targetId` tracker key.
 *
 * Split on the last colon: contract ids are free-form strings, and only the
 * trailing segment is guaranteed to be the numeric target id.
 */
function splitTrackerKey(
	key: string,
): { contractId: string; targetId: number } | null {
	const separator = key.lastIndexOf(":");
	if (separator <= 0) return null;
	const contractId = key.slice(0, separator);
	const targetId = Number(key.slice(separator + 1));
	if (!Number.isFinite(targetId)) return null;
	return { contractId, targetId };
}

class MercStateStore {
	/**
	 * Serialized form of the payload last written or read. A string rather than
	 * the objects themselves: the manager mutates loaded alerts in place on every
	 * tick, so comparing against held references would compare an object with
	 * itself and skip every write.
	 */
	private lastKnownJson: string | null = null;

	/**
	 * Per-collection views of the last write, so `save` can diff row by row.
	 *
	 * Safe to hold in memory because this store is the only writer of these three
	 * tables — unlike the config tables, there is no second process to race with.
	 */
	private lastAlerts = new Map<string, string>();
	private lastHospital = new Map<string, string>();
	private lastOffline = new Map<string, string>();

	private writeQueue: Promise<void> = Promise.resolve();

	/**
	 * Reads the persisted state. Returns null when nothing was ever written or the
	 * row cannot be read, so the caller starts from a clean board.
	 */
	async load(): Promise<MercStateSnapshot | null> {
		try {
			const [alertRows, hospitalRows, offlineRows] = await Promise.all([
				db.select().from(mercActiveAlerts),
				db.select().from(mercHospitalTrackers),
				db.select().from(mercOfflineTrackers),
			]);

			if (
				alertRows.length === 0 &&
				hospitalRows.length === 0 &&
				offlineRows.length === 0
			) {
				this.resetTracking();
				return null;
			}

			const alerts: MercActiveTargetAlert[] = alertRows.map(alertRowToPayload);

			const hospitalTracker: Array<[string, MercHospitalRecord]> =
				hospitalRows.map((row) => [
					`${row.contractId}:${row.targetId}`,
					{
						wasInHospital: row.wasInHospital,
						hospitalUntil: row.hospitalUntil,
						...(row.hospitalExitTime !== null
							? { hospitalExitTime: row.hospitalExitTime }
							: {}),
						lastSeenHospSec: row.lastSeenHospSec,
					},
				]);

			const offlineTracker: Array<[string, number]> = offlineRows.map((row) => [
				`${row.contractId}:${row.targetId}`,
				row.lastSeenAt,
			]);

			this.trackPayload({ alerts, hospitalTracker, offlineTracker });
			return { alerts, hospitalTracker, offlineTracker };
		} catch (err) {
			logger.warn("Failed to read persisted merc state:", err);
			this.resetTracking();
			return null;
		}
	}

	/**
	 * Persists the state, writing only the entries that changed.
	 *
	 * The write is skipped entirely when the payload is unchanged, so the
	 * per-tick bookkeeping cannot turn into a write per cycle.
	 */
	async save(payload: MercStatePayload): Promise<void> {
		const serialized = MercStateStore.serialize(payload);
		if (this.lastKnownJson === serialized) return;

		// The diff below is against what this process last saw, so an unloaded
		// store would treat every existing row as "unknown" and silently fail to
		// delete entries the payload dropped. Load once first so the comparison is
		// against the database, which preserves the replace-the-whole-state
		// semantics the single JSON row had.
		if (this.lastKnownJson === null) {
			await this.load();
		}

		const nextAlerts = new Map<string, string>();
		const alertsToUpsert: MercActiveTargetAlert[] = [];
		for (const alert of payload.alerts) {
			const key = `${alert.contractId}:${alert.targetId}`;
			const value = JSON.stringify(alert);
			nextAlerts.set(key, value);
			if (this.lastAlerts.get(key) !== value) alertsToUpsert.push(alert);
		}
		const alertsToDelete = [...this.lastAlerts.keys()].filter(
			(key) => !nextAlerts.has(key),
		);

		const nextHospital = new Map<string, string>();
		const hospitalToUpsert: Array<[string, MercHospitalRecord]> = [];
		for (const [key, record] of payload.hospitalTracker) {
			const value = JSON.stringify(record);
			nextHospital.set(key, value);
			if (this.lastHospital.get(key) !== value) {
				hospitalToUpsert.push([key, record]);
			}
		}
		const hospitalToDelete = [...this.lastHospital.keys()].filter(
			(key) => !nextHospital.has(key),
		);

		const nextOffline = new Map<string, string>();
		const offlineToUpsert: Array<[string, number]> = [];
		for (const [key, seenAt] of payload.offlineTracker) {
			const value = String(seenAt);
			nextOffline.set(key, value);
			if (this.lastOffline.get(key) !== value) {
				offlineToUpsert.push([key, seenAt]);
			}
		}
		const offlineToDelete = [...this.lastOffline.keys()].filter(
			(key) => !nextOffline.has(key),
		);

		const nothingChanged =
			alertsToUpsert.length === 0 &&
			alertsToDelete.length === 0 &&
			hospitalToUpsert.length === 0 &&
			hospitalToDelete.length === 0 &&
			offlineToUpsert.length === 0 &&
			offlineToDelete.length === 0;
		if (nothingChanged) {
			this.lastKnownJson = serialized;
			return;
		}

		this.writeQueue = this.writeQueue.then(async () => {
			// Track the payload before awaiting the write so a failed write does not
			// turn into a retry storm on every cycle.
			this.lastKnownJson = serialized;
			this.lastAlerts = nextAlerts;
			this.lastHospital = nextHospital;
			this.lastOffline = nextOffline;

			const now = new Date();

			try {
				await db.transaction(async (tx) => {
					if (alertsToDelete.length > 0) {
						await tx
							.delete(mercActiveAlerts)
							.where(alertKeyFilter(alertsToDelete));
					}
					for (const alert of alertsToUpsert) {
						const values = alertToRow(alert);
						await tx
							.insert(mercActiveAlerts)
							.values({ ...values, createdAt: now })
							.onConflictDoUpdate({
								target: [
									mercActiveAlerts.contractId,
									mercActiveAlerts.targetId,
								],
								set: { ...values, updatedAt: now },
							});
					}

					if (hospitalToDelete.length > 0) {
						for (const key of hospitalToDelete) {
							const parts = splitTrackerKey(key);
							if (!parts) continue;
							await tx
								.delete(mercHospitalTrackers)
								.where(
									and(
										eq(mercHospitalTrackers.contractId, parts.contractId),
										eq(mercHospitalTrackers.targetId, parts.targetId),
									),
								);
						}
					}
					for (const [key, record] of hospitalToUpsert) {
						const parts = splitTrackerKey(key);
						if (!parts) continue;
						const values = {
							contractId: parts.contractId,
							targetId: parts.targetId,
							wasInHospital: record.wasInHospital,
							hospitalUntil: record.hospitalUntil,
							hospitalExitTime: record.hospitalExitTime ?? null,
							lastSeenHospSec: record.lastSeenHospSec,
						};
						await tx
							.insert(mercHospitalTrackers)
							.values({ ...values, createdAt: now })
							.onConflictDoUpdate({
								target: [
									mercHospitalTrackers.contractId,
									mercHospitalTrackers.targetId,
								],
								set: { ...values, updatedAt: now },
							});
					}

					if (offlineToDelete.length > 0) {
						for (const key of offlineToDelete) {
							const parts = splitTrackerKey(key);
							if (!parts) continue;
							await tx
								.delete(mercOfflineTrackers)
								.where(
									and(
										eq(mercOfflineTrackers.contractId, parts.contractId),
										eq(mercOfflineTrackers.targetId, parts.targetId),
									),
								);
						}
					}
					for (const [key, seenAt] of offlineToUpsert) {
						const parts = splitTrackerKey(key);
						if (!parts) continue;
						const values = {
							contractId: parts.contractId,
							targetId: parts.targetId,
							lastSeenAt: seenAt,
						};
						await tx
							.insert(mercOfflineTrackers)
							.values({ ...values, createdAt: now })
							.onConflictDoUpdate({
								target: [
									mercOfflineTrackers.contractId,
									mercOfflineTrackers.targetId,
								],
								set: { ...values, updatedAt: now },
							});
					}
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

	/** Records a payload as the last-written one, for diffing. */
	private trackPayload(payload: MercStatePayload): void {
		this.lastKnownJson = MercStateStore.serialize(payload);
		this.lastAlerts = new Map(
			payload.alerts.map((alert) => [
				`${alert.contractId}:${alert.targetId}`,
				JSON.stringify(alert),
			]),
		);
		this.lastHospital = new Map(
			payload.hospitalTracker.map(([key, record]) => [
				key,
				JSON.stringify(record),
			]),
		);
		this.lastOffline = new Map(
			payload.offlineTracker.map(([key, seenAt]) => [key, String(seenAt)]),
		);
	}

	private resetTracking(): void {
		this.lastKnownJson = null;
		this.lastAlerts = new Map();
		this.lastHospital = new Map();
		this.lastOffline = new Map();
	}

	/** Awaits queued writes (tests and graceful shutdown). */
	async flush(): Promise<void> {
		await this.writeQueue;
	}

	/** Forgets the last payload so the next write is not skipped (tests). */
	invalidate(): void {
		this.resetTracking();
	}
}

/** Deletes alert rows for the given `contractId:targetId` keys. */
function alertKeyFilter(keys: string[]) {
	const parsed = keys
		.map(splitTrackerKey)
		.filter((parts): parts is { contractId: string; targetId: number } =>
			Boolean(parts),
		);
	if (parsed.length === 0) {
		// Nothing parseable: match no rows rather than deleting the table.
		return inArray(mercActiveAlerts.contractId, []);
	}
	return and(
		inArray(
			mercActiveAlerts.contractId,
			parsed.map((parts) => parts.contractId),
		),
		inArray(
			mercActiveAlerts.targetId,
			parsed.map((parts) => parts.targetId),
		),
	);
}

function alertToRow(
	alert: MercActiveTargetAlert,
): typeof mercActiveAlerts.$inferInsert {
	return {
		contractId: alert.contractId,
		targetId: alert.targetId,
		guildId: alert.guildId,
		channelName: alert.channelName,
		targetName: alert.targetName,
		targetLevel: alert.targetLevel,
		estimatedBs: alert.estimatedBs,
		status: alert.status,
		claimedByDiscordId: alert.claimedBy?.discordId ?? null,
		claimedByDiscordTag: alert.claimedBy?.discordTag ?? null,
		claimedByTornId: alert.claimedBy?.tornId ?? null,
		claimedByTornName: alert.claimedBy?.tornName ?? null,
		claimedAt: alert.claimedAt ?? null,
		messageId: alert.messageId ?? null,
		lastAlertAt: alert.lastAlertAt,
		isStrickenEligible: alert.isStrickenEligible,
		mode: normalizeMercContractMode(alert.mode),
		hospitalUntil: alert.hospitalUntil ?? null,
		rwCooldownUntil: alert.rwCooldownUntil ?? null,
		wasInHospital: alert.wasInHospital ?? null,
		hospitalExitTime: alert.hospitalExitTime ?? null,
		lockStartedAt: alert.lockStartedAt ?? null,
	};
}

function alertRowToPayload(
	row: typeof mercActiveAlerts.$inferSelect,
): MercActiveTargetAlert {
	const hasClaimant =
		row.claimedByDiscordId !== null || row.claimedByTornId !== null;

	return {
		contractId: row.contractId,
		targetId: row.targetId,
		guildId: row.guildId,
		channelName: row.channelName,
		targetName: row.targetName,
		targetLevel: row.targetLevel,
		estimatedBs: row.estimatedBs,
		status: row.status === "claimed" ? "claimed" : "open",
		// `MercClaimant` requires both Discord fields; the worker only ever sets
		// them together, so a row with neither reads back as unclaimed.
		...(hasClaimant
			? {
					claimedBy: {
						discordId: row.claimedByDiscordId ?? "",
						discordTag: row.claimedByDiscordTag ?? "",
						...(row.claimedByTornId !== null
							? { tornId: row.claimedByTornId }
							: {}),
						...(row.claimedByTornName !== null
							? { tornName: row.claimedByTornName }
							: {}),
					},
				}
			: {}),
		...(row.claimedAt !== null ? { claimedAt: row.claimedAt } : {}),
		...(row.messageId !== null ? { messageId: row.messageId } : {}),
		lastAlertAt: row.lastAlertAt,
		isStrickenEligible: row.isStrickenEligible,
		mode: normalizeMercContractMode(row.mode),
		hospitalUntil: row.hospitalUntil,
		rwCooldownUntil: row.rwCooldownUntil,
		...(row.wasInHospital !== null ? { wasInHospital: row.wasInHospital } : {}),
		...(row.hospitalExitTime !== null
			? { hospitalExitTime: row.hospitalExitTime }
			: {}),
		...(row.lockStartedAt !== null ? { lockStartedAt: row.lockStartedAt } : {}),
	} as MercActiveTargetAlert;
}

export const mercStateStore = new MercStateStore();
