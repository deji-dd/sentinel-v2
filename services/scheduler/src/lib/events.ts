import { EventEmitter } from "node:events";

import type { TornSchema } from "@sentinel/schemas";
import type { FactionAttackEvent } from "../workers/merc/faction-attack-feed-worker";

/**
 * Where a batch of ingested logs came from.
 *
 * - `forward` — the live poll. These are genuinely new events.
 * - `backfill` — the historical walk backwards from now.
 * - `resync` — an explicit operator-requested range repair.
 */
export type LogIngestSource = "forward" | "backfill" | "resync";

export type SchedulerEvents = {
	log_backfill_completed: [];
	log_resync_completed: [];
	/**
	 * Fires after newly observed logs are persisted.
	 *
	 * `source` distinguishes the live forward poll from the historical backfill
	 * and resync paths. Subscribers that index logs into derived tables should
	 * handle every source; subscribers that would make a *live* API call or send
	 * a Discord message must check it, because a backfill page can contain logs
	 * from years ago and reacting to those as if they just happened produces
	 * pointless upstream requests and misleading notifications.
	 */
	logs_inserted: [
		logs: TornSchema<"UserLog">[],
		meta: { source: LogIngestSource },
	];
	company_pay_received: [];
	/**
	 * Fires after newly observed faction attacks have been persisted to
	 * `faction_attack_logs`. Subscribers (merc hit validation, retal tracking)
	 * are fire-and-forget: the emitter does not await them, so a slow consumer
	 * can never stall ingestion.
	 */
	faction_attacks_ingested: [attacks: FactionAttackEvent[]];
	/** Fires after the Subversive ranked war tracking cycle refreshes war state. */
	ranked_war_updated: [];
};

class TypedEventEmitter extends EventEmitter {
	override emit<K extends keyof SchedulerEvents>(
		event: K,
		...args: SchedulerEvents[K]
	): boolean {
		return super.emit(event, ...args);
	}

	override on<K extends keyof SchedulerEvents>(
		event: K,
		listener: (...args: SchedulerEvents[K]) => void,
	): this {
		return super.on(event, listener as (...args: unknown[]) => void);
	}

	override once<K extends keyof SchedulerEvents>(
		event: K,
		listener: (...args: SchedulerEvents[K]) => void,
	): this {
		return super.once(event, listener as (...args: unknown[]) => void);
	}

	override off<K extends keyof SchedulerEvents>(
		event: K,
		listener: (...args: SchedulerEvents[K]) => void,
	): this {
		return super.off(event, listener as (...args: unknown[]) => void);
	}
}

export const schedulerEvents = new TypedEventEmitter();
