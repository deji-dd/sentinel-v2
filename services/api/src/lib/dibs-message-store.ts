import {
	and,
	db,
	eq,
	isNull,
	lte,
	or,
	subversiveDibsMessages,
} from "@sentinel/database";
import type { DibsMessageRef } from "@sentinel/schemas";
import { Logger, resolveSubversiveFactionId } from "@sentinel/utils";

const logger = new Logger("API", "DibsMessageStore");

/**
 * Ledger of every dibs Discord message the API has posted, one row per message
 * in `subversive_dibs_messages`.
 *
 * This is the source of truth for channel maintenance: it lets the sweeper
 * delete messages the API still tracks after a restart, and lets the manager
 * delete tracked messages for targets whose in-memory record is gone.
 *
 * It previously lived as a single `system_states` row holding a JSON object
 * keyed by message id, rewritten in full on every post and every delete. Rows
 * make a post or delete a single-row write, and the by-channel and by-age
 * queries the sweeper runs are index-backed instead of pulling the whole ledger
 * into memory first.
 */
class DibsMessageStore {
	/**
	 * Serializes mutations so that a `flush()` really does mean "every write has
	 * landed".
	 *
	 * Callers fire deletes without awaiting — `deleteDibsMessage` in the manager
	 * does exactly that — and then call `flush()` before reading the ledger.
	 * Tracking the in-flight promise is what keeps that contract: without it a
	 * delete could still be running while a sweep reads the ledger and concludes
	 * a message is still tracked, leaving it undeleted.
	 */
	private writeQueue: Promise<void> = Promise.resolve();

	/** Chains a mutation onto the write queue and returns the settled chain. */
	private enqueue(mutation: () => Promise<void>): Promise<void> {
		this.writeQueue = this.writeQueue.then(mutation, mutation);
		return this.writeQueue;
	}

	/**
	 * Reads tracked messages, optionally scoped to one faction.
	 *
	 * Records that never had a faction recorded are treated as belonging to the
	 * scoped faction, matching how the previous in-memory ledger defaulted them.
	 * Returns an empty list when the read fails, so channel maintenance degrades
	 * to "nothing tracked" rather than throwing into the sweep loop.
	 */
	async list(factionId?: number | null): Promise<DibsMessageRef[]> {
		try {
			const scoped =
				factionId === undefined || factionId === null
					? null
					: resolveSubversiveFactionId(factionId);

			const rows = await db
				.select()
				.from(subversiveDibsMessages)
				.where(
					scoped === null
						? undefined
						: or(
								eq(subversiveDibsMessages.factionId, scoped),
								isNull(subversiveDibsMessages.factionId),
							),
				);

			return rows.map((row) => ({
				targetId: row.targetId,
				factionId: row.factionId ?? undefined,
				channelId: row.channelId,
				messageId: row.messageId,
				createdAt: row.postedAtMs,
			}));
		} catch (err) {
			logger.warn("Failed to read dibs message ledger:", err);
			return [];
		}
	}

	/**
	 * Records a posted dibs message so it can be cleaned up later.
	 *
	 * Re-tracking the same message id overwrites it, matching the previous
	 * behaviour where the ledger entry was replaced wholesale.
	 */
	async track(params: {
		targetId: number;
		factionId?: number;
		channelId: string;
		messageId: string;
	}): Promise<void> {
		return this.enqueue(async () => {
			const now = new Date();
			const postedAtMs = now.getTime();
			const factionId = params.factionId
				? resolveSubversiveFactionId(params.factionId)
				: null;

			try {
				await db
					.insert(subversiveDibsMessages)
					.values({
						messageId: params.messageId,
						targetId: params.targetId,
						factionId,
						channelId: params.channelId,
						postedAtMs,
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: subversiveDibsMessages.messageId,
						set: {
							targetId: params.targetId,
							factionId,
							channelId: params.channelId,
							postedAtMs,
							updatedAt: now,
						},
					});
			} catch (err) {
				logger.warn("Failed to persist dibs message ledger entry:", err);
			}
		});
	}

	/**
	 * Forgets a message once it has been deleted from Discord.
	 *
	 * No-ops when the row is already gone, which is the common case for a sweep
	 * that ran twice.
	 */
	async forget(messageId: string): Promise<void> {
		return this.enqueue(async () => {
			try {
				await db
					.delete(subversiveDibsMessages)
					.where(eq(subversiveDibsMessages.messageId, messageId));
			} catch (err) {
				logger.warn("Failed to forget dibs message:", err);
			}
		});
	}

	/**
	 * Forgets every message belonging to a target (e.g. after a repost).
	 */
	async forgetTarget(targetId: number): Promise<void> {
		return this.enqueue(async () => {
			try {
				await db
					.delete(subversiveDibsMessages)
					.where(eq(subversiveDibsMessages.targetId, targetId));
			} catch (err) {
				logger.warn("Failed to forget dibs messages for target:", err);
			}
		});
	}

	/**
	 * Returns tracked messages for a channel that are at least `maxAgeMs` old.
	 *
	 * Age filtering happens in SQL, so the sweeper no longer has to load the
	 * whole ledger to find the handful of stale callouts in one channel.
	 */
	async listForChannel(
		channelId: string,
		maxAgeMs?: number,
	): Promise<DibsMessageRef[]> {
		try {
			const cutoff =
				typeof maxAgeMs === "number"
					? Date.now() - maxAgeMs
					: Number.NEGATIVE_INFINITY;

			const rows = await db
				.select()
				.from(subversiveDibsMessages)
				.where(
					typeof maxAgeMs === "number"
						? and(
								eq(subversiveDibsMessages.channelId, channelId),
								lte(subversiveDibsMessages.postedAtMs, cutoff),
							)
						: eq(subversiveDibsMessages.channelId, channelId),
				);

			return rows.map((row) => ({
				targetId: row.targetId,
				factionId: row.factionId ?? undefined,
				channelId: row.channelId,
				messageId: row.messageId,
				createdAt: row.postedAtMs,
			}));
		} catch (err) {
			logger.warn("Failed to read dibs message ledger for channel:", err);
			return [];
		}
	}

	/**
	 * Awaits every queued mutation, so a caller that fires a delete with `void`
	 * can still know the ledger has settled before reading it.
	 */
	async flush(): Promise<void> {
		await this.writeQueue;
	}

	/**
	 * Retained for tests that forced a cache reload. There is no cache now — each
	 * read goes to the database — so this is a no-op.
	 */
	invalidate(): void {
		// Intentionally empty: the ledger is no longer cached in memory.
	}
}

export const dibsMessageStore = new DibsMessageStore();
