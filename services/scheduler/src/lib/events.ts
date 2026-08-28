import { EventEmitter } from "node:events";

import type { TornSchema } from "@sentinel/schemas";

export type SchedulerEvents = {
	log_backfill_completed: [];
	log_resync_completed: [];
	logs_inserted: [logs: TornSchema<"UserLog">[]];
	company_pay_received: [];
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
