import { Logger } from "@sentinel/utils";

const logger = new Logger("Scheduler", "SubscriberHealth");

/**
 * Health accounting for reactive log-stream subscribers.
 *
 * The personal ledger modules (crimes, battlestats, stocks, company, oil-rig)
 * are not scheduler runners — they subscribe to `logs_inserted` and are invoked
 * fire-and-forget by the event emitter, which deliberately does not await them
 * so a slow consumer cannot stall ingestion.
 *
 * The consequence is that a subscriber which fails on every single event is
 * invisible: nothing increments `consecutiveFailures` and `/health` stays green
 * while its derived tables silently fall behind. This registry gives those
 * modules the same visibility runners already have, without making them
 * blocking.
 */
export interface SubscriberHealth {
	module: string;
	/** Events handled without throwing. */
	processed: number;
	/** Events whose handler threw. */
	failed: number;
	lastError: string | null;
	lastFailedAt: number | null;
	lastSuccessAt: number | null;
}

const healthByModule = new Map<string, SubscriberHealth>();

function ensure(module: string): SubscriberHealth {
	let entry = healthByModule.get(module);
	if (!entry) {
		entry = {
			module,
			processed: 0,
			failed: 0,
			lastError: null,
			lastFailedAt: null,
			lastSuccessAt: null,
		};
		healthByModule.set(module, entry);
	}
	return entry;
}

export function recordSubscriberSuccess(module: string): void {
	const entry = ensure(module);
	entry.processed++;
	entry.lastSuccessAt = Date.now();
}

export function recordSubscriberFailure(module: string, error: unknown): void {
	const entry = ensure(module);
	entry.failed++;
	entry.lastError = error instanceof Error ? error.message : String(error);
	entry.lastFailedAt = Date.now();
}

/**
 * Runs a subscriber handler with failure accounting.
 *
 * Replaces the bare `.catch(err => logger.error(...))` pattern used by the
 * personal ledger subscribers: identical error containment, but the failure is
 * also counted so `/health` can surface a subscriber that is failing every
 * event. Never rejects, so it stays safe to call from an emitter listener.
 *
 * The promise is returned so a caller that genuinely needs ordering can await it -
 * the daily oil rig handler refreshes the roster benchmark before briefing, so the
 * brief uses the baseline measured moments earlier. Callers that do not care keep
 * ignoring the return value, and because it never rejects there is no unhandled
 * rejection to guard against.
 */
export function runSubscriber(
	module: string,
	work: () => Promise<unknown>,
): Promise<void> {
	return (async () => {
		try {
			await work();
			recordSubscriberSuccess(module);
		} catch (error) {
			recordSubscriberFailure(module, error);
			logger.error(`Subscriber '${module}' failed:`, error);
		}
	})();
}

export function getSubscriberHealth(): SubscriberHealth[] {
	return Array.from(healthByModule.values());
}

/** Test seam: clears recorded subscriber health. */
export function resetSubscriberHealth(): void {
	healthByModule.clear();
}
