import { EventEmitter } from "node:events";

import type { TornSchema } from "@sentinel/schemas";
import type { FactionAttackEvent } from "../workers/merc/faction-attack-feed-worker";

export type SchedulerEvents = {
	log_backfill_completed: [];
	log_resync_completed: [];
	logs_inserted: [logs: TornSchema<"UserLog">[]];
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
