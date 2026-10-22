import { and, eq, inArray, notInArray } from "drizzle-orm";

import { db } from "../../index";
import { personalBountyTargets } from "../schema/ledger";
import {
	getWorkerState,
	upsertWorkerState,
	WORKER_STATE_IDS,
} from "./worker-state";

/**
 * Persistence for the personal bounty finder.
 *
 * Targets are rows in `personal_bounty_targets`; the deployment-level counters
 * live in `worker_state`. Both are exposed here rather than in the two services
 * that use them (the scheduler's bounty finder and the API's bounty routes),
 * because both need to read and write the same data and previously carried
 * their own copies of these types.
 *
 * The scheduler owns the candidate pool and replaces it wholesale, so it uses
 * {@link syncPersonalBountyState}. The API only ever re-checks or removes one
 * target, so it must use the single-row helpers — a full-state write from the
 * API would delete targets the scheduler added after the API's read, which is
 * the last-writer-wins hazard this migration exists to narrow.
 */

export interface PersonalBountyTarget {
	id: number;
	name: string;
	level: number;
	/** Highest single qualifying bounty reward, in dollars. */
	reward: number;
	/** Null when the target has not been scouted yet. */
	fairFight: number | null;
	estimatedBs: number | null;
	/** Target age in days; the finder only keeps targets at 14+ days. */
	age: number;
	status: {
		state: string;
		description?: string;
		until?: number | null;
	};
	attackUrl: string;
	lastCheckedAt: number;
}

/** A hospital-queue entry additionally carries the remaining hospital time. */
export type PersonalBountyHospitalTarget = PersonalBountyTarget & {
	secondsRemaining: number;
};

export interface PersonalBountyState {
	readyTargets: PersonalBountyTarget[];
	hospitalQueue: PersonalBountyHospitalTarget[];
	lastSyncTimestamp: number;
	targetCount: number;
	pendingCount?: number;
}

/** Reads the full board: target rows plus the counters held in `worker_state`. */
export async function loadPersonalBountyState(): Promise<PersonalBountyState> {
	const rows = await db.select().from(personalBountyTargets);
	const meta = await getWorkerState(WORKER_STATE_IDS.bounties);
	const details = (meta?.details ?? {}) as { pendingCount?: number };

	const readyTargets: PersonalBountyTarget[] = [];
	const hospitalQueue: PersonalBountyHospitalTarget[] = [];

	for (const row of rows) {
		const target = rowToTarget(row);
		if (row.queue === "hospital") {
			hospitalQueue.push({
				...target,
				secondsRemaining: row.secondsRemaining ?? 0,
			});
		} else {
			readyTargets.push(target);
		}
	}

	// Ordering is part of the contract: the dashboard shows the best reward
	// first and the soonest hospital exit first.
	readyTargets.sort((a, b) => b.reward - a.reward);
	hospitalQueue.sort((a, b) => a.secondsRemaining - b.secondsRemaining);

	return {
		readyTargets,
		hospitalQueue,
		lastSyncTimestamp: meta?.cursor ?? 0,
		targetCount: readyTargets.length + hospitalQueue.length,
		pendingCount: Number(details.pendingCount ?? 0),
	};
}

/** Writes the deployment-level counters for the finder. */
export async function savePersonalBountyMeta(input: {
	lastSyncTimestamp: number;
	pendingCount: number;
}): Promise<void> {
	await upsertWorkerState({
		workerId: WORKER_STATE_IDS.bounties,
		init: true,
		cursor: input.lastSyncTimestamp,
		lastRunAt: new Date(),
		details: { pendingCount: input.pendingCount },
	});
}

/**
 * Replaces the tracked targets with the given board.
 *
 * Intended for the scheduler, which owns the candidate pool. Rows for targets no
 * longer present are deleted; unchanged targets are not rewritten.
 */
export async function syncPersonalBountyState(
	state: PersonalBountyState,
): Promise<void> {
	const ready = state.readyTargets.map((target) => ({
		target,
		queue: "ready" as const,
		secondsRemaining: null as number | null,
	}));
	const hospital = state.hospitalQueue.map((target) => ({
		target,
		queue: "hospital" as const,
		secondsRemaining: target.secondsRemaining,
	}));
	const entries = [...ready, ...hospital];
	const keepIds = entries.map((entry) => entry.target.id);

	await db.transaction(async (tx) => {
		if (keepIds.length > 0) {
			await tx
				.delete(personalBountyTargets)
				.where(notInArray(personalBountyTargets.targetId, keepIds));
		} else {
			await tx.delete(personalBountyTargets);
		}

		const now = new Date();
		for (const entry of entries) {
			const values = targetToRow(
				entry.target,
				entry.queue,
				entry.secondsRemaining,
			);
			await tx
				.insert(personalBountyTargets)
				.values({ ...values, createdAt: now })
				.onConflictDoUpdate({
					target: personalBountyTargets.targetId,
					set: { ...values, updatedAt: now },
				});
		}
	});

	await savePersonalBountyMeta({
		lastSyncTimestamp: state.lastSyncTimestamp,
		pendingCount: state.pendingCount ?? 0,
	});
}

/**
 * Upserts exactly one target, leaving every other row alone.
 *
 * This is what the API uses: it moves a single target between the ready and
 * hospital queues after re-profiling it.
 */
export async function upsertPersonalBountyTarget(
	target: PersonalBountyTarget,
	queue: "ready" | "hospital",
	secondsRemaining: number | null,
): Promise<void> {
	const now = new Date();
	const values = targetToRow(target, queue, secondsRemaining);
	await db
		.insert(personalBountyTargets)
		.values({ ...values, createdAt: now })
		.onConflictDoUpdate({
			target: personalBountyTargets.targetId,
			set: { ...values, updatedAt: now },
		});
}

/** Removes a target that has been defeated or is no longer tracked. */
export async function deletePersonalBountyTarget(
	targetId: number,
): Promise<void> {
	await db
		.delete(personalBountyTargets)
		.where(eq(personalBountyTargets.targetId, targetId));
}

/** Reads one target, or null when it is not tracked. */
export async function getPersonalBountyTarget(
	targetId: number,
): Promise<{ target: PersonalBountyTarget; queue: string } | null> {
	const [row] = await db
		.select()
		.from(personalBountyTargets)
		.where(eq(personalBountyTargets.targetId, targetId));
	return row ? { target: rowToTarget(row), queue: row.queue } : null;
}

/** Reads many targets at once, keyed by target id. */
export async function getPersonalBountyTargets(
	targetIds: number[],
): Promise<PersonalBountyTarget[]> {
	if (targetIds.length === 0) return [];
	const rows = await db
		.select()
		.from(personalBountyTargets)
		.where(inArray(personalBountyTargets.targetId, targetIds));
	return rows.map(rowToTarget);
}

/** True when the target is tracked in the given queue. */
export async function isPersonalBountyTargetQueued(
	targetId: number,
	queue: "ready" | "hospital",
): Promise<boolean> {
	const [row] = await db
		.select({ targetId: personalBountyTargets.targetId })
		.from(personalBountyTargets)
		.where(
			and(
				eq(personalBountyTargets.targetId, targetId),
				eq(personalBountyTargets.queue, queue),
			),
		);
	return Boolean(row);
}

function targetToRow(
	target: PersonalBountyTarget,
	queue: "ready" | "hospital",
	secondsRemaining: number | null,
): typeof personalBountyTargets.$inferInsert {
	return {
		targetId: target.id,
		queue,
		name: target.name,
		level: target.level,
		reward: target.reward,
		fairFight: target.fairFight,
		estimatedBs: target.estimatedBs,
		age: target.age,
		statusState: target.status.state,
		statusDescription: target.status.description ?? null,
		statusUntil: target.status.until ?? null,
		attackUrl: target.attackUrl,
		lastCheckedAt: target.lastCheckedAt,
		secondsRemaining,
	};
}

function rowToTarget(
	row: typeof personalBountyTargets.$inferSelect,
): PersonalBountyTarget {
	return {
		id: row.targetId,
		name: row.name,
		level: row.level,
		reward: row.reward,
		fairFight: row.fairFight,
		estimatedBs: row.estimatedBs,
		age: row.age,
		status: {
			state: row.statusState,
			...(row.statusDescription !== null
				? { description: row.statusDescription }
				: {}),
			...(row.statusUntil !== null ? { until: row.statusUntil } : {}),
		},
		attackUrl: row.attackUrl,
		lastCheckedAt: row.lastCheckedAt,
	};
}
