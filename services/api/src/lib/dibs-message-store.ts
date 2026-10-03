import { db, eq, systemStates } from "@sentinel/database";
import type { DibsMessageRef } from "@sentinel/schemas";
import { Logger, resolveSubversiveFactionId } from "@sentinel/utils";

const logger = new Logger("API", "DibsMessageStore");

/**
 * Single systemStates row holding every dibs Discord message we have posted.
 *
 * Kept in systemStates rather than a dedicated table so no schema migration is
 * required. This ledger is the source of truth for channel maintenance: it lets
 * the sweeper delete messages the API still tracks after a restart, and lets the
 * manager delete tracked messages for targets whose in-memory record is gone.
 */
const DIBS_MESSAGE_LEDGER_ID = "subversive:dibs_message_ledger";

interface DibsMessageLedger {
	/** Keyed by Discord message id. */
	messages: Record<string, DibsMessageRef>;
	updatedAt?: string;
}

const EMPTY_LEDGER: DibsMessageLedger = { messages: {} };

class DibsMessageStore {
	private cache: DibsMessageLedger | null = null;
	private writeQueue: Promise<void> = Promise.resolve();

	private async readLedger(): Promise<DibsMessageLedger> {
		if (this.cache) return this.cache;

		try {
			const [entry] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, DIBS_MESSAGE_LEDGER_ID));

			const data = entry?.data as DibsMessageLedger | undefined;
			this.cache = {
				messages: data?.messages ?? {},
				updatedAt: data?.updatedAt,
			};
		} catch (err) {
			logger.warn("Failed to read dibs message ledger:", err);
			this.cache = { ...EMPTY_LEDGER };
		}

		return this.cache;
	}

	private async persistLedger(ledger: DibsMessageLedger): Promise<void> {
		const data: DibsMessageLedger = {
			messages: ledger.messages,
			updatedAt: new Date().toISOString(),
		};

		// Update the cache first so reads stay correct even if the database write
		// fails (transient DB outage, or a test environment without a database).
		this.cache = data;

		try {
			await db
				.insert(systemStates)
				.values({
					id: DIBS_MESSAGE_LEDGER_ID,
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
			logger.warn("Failed to persist dibs message ledger:", err);
		}
	}

	/**
	 * Serializes mutations so concurrent posts cannot clobber each other.
	 */
	private enqueue(mutate: (ledger: DibsMessageLedger) => void): Promise<void> {
		this.writeQueue = this.writeQueue.then(async () => {
			const ledger = await this.readLedger();
			mutate(ledger);
			await this.persistLedger(ledger);
		});
		return this.writeQueue;
	}

	/**
	 * Records a posted dibs message so it can be cleaned up later.
	 */
	async track(params: {
		targetId: number;
		factionId?: number;
		channelId: string;
		messageId: string;
	}): Promise<void> {
		await this.enqueue((ledger) => {
			ledger.messages[params.messageId] = {
				targetId: params.targetId,
				factionId: params.factionId
					? resolveSubversiveFactionId(params.factionId)
					: undefined,
				channelId: params.channelId,
				messageId: params.messageId,
				createdAt: Date.now(),
			};
		});
	}

	/**
	 * Forgets a message once it has been deleted from Discord.
	 */
	async forget(messageId: string): Promise<void> {
		await this.enqueue((ledger) => {
			delete ledger.messages[messageId];
		});
	}

	/**
	 * Forgets every message belonging to a target (e.g. after a repost).
	 */
	async forgetTarget(targetId: number): Promise<void> {
		await this.enqueue((ledger) => {
			for (const [messageId, ref] of Object.entries(ledger.messages)) {
				if (ref.targetId === targetId) delete ledger.messages[messageId];
			}
		});
	}

	/**
	 * Returns all tracked messages, optionally scoped to one faction.
	 */
	async list(factionId?: number | null): Promise<DibsMessageRef[]> {
		const ledger = await this.readLedger();
		const all = Object.values(ledger.messages);
		if (factionId === undefined || factionId === null) return all;
		const scoped = resolveSubversiveFactionId(factionId);
		return all.filter((ref) => (ref.factionId ?? scoped) === scoped);
	}

	/**
	 * Returns tracked messages for a channel, optionally filtered by age.
	 */
	async listForChannel(
		channelId: string,
		maxAgeMs?: number,
	): Promise<DibsMessageRef[]> {
		const all = await this.list();
		const cutoff =
			typeof maxAgeMs === "number"
				? Date.now() - maxAgeMs
				: Number.NEGATIVE_INFINITY;
		return all.filter(
			(ref) => ref.channelId === channelId && ref.createdAt <= cutoff,
		);
	}

	/**
	 * Awaits all queued mutations. Used by tests and callers that need the
	 * ledger to be settled before reading it.
	 */
	async flush(): Promise<void> {
		await this.writeQueue;
	}

	/**
	 * Clears the in-memory cache (tests / forced reload).
	 */
	invalidate(): void {
		this.cache = null;
	}
}

export const dibsMessageStore = new DibsMessageStore();
