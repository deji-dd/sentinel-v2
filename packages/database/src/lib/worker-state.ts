import { eq } from "drizzle-orm";

import { db } from "../../index";
import { workerState, type WorkerStateRow } from "../schema/system";

/**
 * Read/write access to {@link workerState}, the sanctioned home for background
 * worker cursors, status and first-run flags.
 *
 * Every writer is the single worker that owns its `worker_id`, so an upsert
 * replaces the row outright — there is no cross-process read-modify-write to
 * race against, which is the failure mode the typed tables exist to avoid.
 * Configuration must not be stored here; see `.agents/AGENTS.md`.
 */

/**
 * Canonical `worker_state` ids.
 *
 * Kept in one place because some of these are written by the scheduler and read
 * or cleared by the API — `subversiveRecruitment` in particular. A literal
 * repeated in two services is how a key silently drifts between writer and
 * reader, which is exactly what happened to the `system_states` keys these
 * replace.
 */
export const WORKER_STATE_IDS = {
	/** Personal log backfill/forward sync cursors. */
	logManager: "personal:log_manager",
	/** In-flight log resync job (window bounds, page counters). */
	logManagerResync: "personal:log_manager_resync",
	/** Recruitment worker's last-scan watermark and first-run gate. */
	subversiveRecruitment: "subversive:recruitment_state",
	/**
	 * Bounty finder's last-sync watermark and target counts. The targets
	 * themselves are rows in `personal_bounty_targets`.
	 */
	bounties: "personal:bounties",
	/**
	 * Company sync progress: status, last error, the sync watermark, and the
	 * inflow/outflow/profit counters in `details`.
	 */
	companySync: "personal:company_sync",
	/** Whether the initial war-ledger backfill has completed. */
	warLedgerInit: "war_ledger_init_state",
	/** Whether the initial territory-state load has completed. */
	territoryInit: "tt_init_state",
} as const;

export type WorkerStateId =
	(typeof WORKER_STATE_IDS)[keyof typeof WORKER_STATE_IDS];

/** Reads one worker's state row, or null when it has never written one. */
export async function getWorkerState(
	workerId: string,
): Promise<WorkerStateRow | null> {
	const [row] = await db
		.select()
		.from(workerState)
		.where(eq(workerState.workerId, workerId))
		.limit(1);
	return row ?? null;
}

export interface WorkerStateInput {
	workerId: string;
	/** First-run gate. Omit to leave the existing value untouched. */
	init?: boolean;
	status?: string | null;
	lastError?: string | null;
	cursor?: number | null;
	lastRunAt?: Date | null;
	/** Worker-specific counters. Replaces the stored object when provided. */
	details?: Record<string, unknown>;
}

/**
 * Writes a worker's state.
 *
 * `init` is only written when explicitly provided, so a worker that persists
 * progress cannot accidentally clear the flag that stops it replaying history.
 */
export async function upsertWorkerState(
	input: WorkerStateInput,
): Promise<void> {
	const now = new Date();
	const row: Record<string, unknown> = {
		workerId: input.workerId,
		status: input.status ?? null,
		lastError: input.lastError ?? null,
		cursor: input.cursor ?? null,
		lastRunAt: input.lastRunAt ?? null,
		updatedAt: now,
	};

	// Only these two are conditional. `init` because clearing it replays history,
	// and `details` because a caller that omits it must not wipe the counters it
	// simply did not mention.
	if (input.init !== undefined) {
		row.init = input.init;
	}
	if (input.details !== undefined) {
		row.details = input.details;
	}

	await db
		.insert(workerState)
		.values({ ...row, createdAt: now } as typeof workerState.$inferInsert)
		.onConflictDoUpdate({
			target: workerState.workerId,
			set: row,
		});
}

/** Sets only a first-run flag, leaving everything else on the row untouched. */
export async function setWorkerInitFlag(
	workerId: string,
	init: boolean,
): Promise<void> {
	const now = new Date();
	await db
		.insert(workerState)
		.values({ workerId, init, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: workerState.workerId,
			set: { init, updatedAt: now },
		});
}
