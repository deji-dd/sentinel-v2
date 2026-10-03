import { and, db, gt, inArray, mercContracts } from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { isAnyFamilyRankedWarEngaged } from "../workers/subversive/ranked-war-worker";

const logger = new Logger("Scheduler", "AttackFeedCadence");

/**
 * Activity tiers driving the faction attack feed's polling cadence. The feed is
 * the only reader of `/v2/faction/attacks`, so its cadence is the single knob
 * for master-key API pressure across every consumer.
 *
 * Any engaged work — a merc contract, a ranked war, or both at once — polls at
 * the same fast rate. The distinction between `both` / `war` / `contract` is
 * kept only so logs and metrics can attribute which consumer is driving; it
 * deliberately does not change the interval, because merc hits and the 5-minute
 * Retal window are both time-sensitive and neither benefits from a slower tier
 * while the other is quiet.
 */
export type AttackFeedActivity = "both" | "war" | "contract" | "idle";

export const ATTACK_FEED_CADENCE_MS: Record<AttackFeedActivity, number> = {
	both: 5_000,
	war: 5_000,
	contract: 5_000,
	idle: 60_000,
};

/** Default cadence used before the first activity check has completed. */
export const DEFAULT_ATTACK_FEED_CADENCE_MS = ATTACK_FEED_CADENCE_MS.idle;

/**
 * Whether any merc contract is currently creditable: active, or upcoming whose
 * start time has already passed. Paused contracts are excluded — they credit
 * no hits — and this mirrors the validator's own gate so the feed never polls
 * at contract speed for a contract the validator would ignore.
 *
 * Pauses are short-lived and normally resume into the same active contract, so a
 * brief under-poll during a pause is an acceptable trade for not burning API
 * budget on a paused contract.
 */
export async function isAnyMercContractActive(): Promise<boolean> {
	try {
		const now = new Date();
		const rows = await db
			.select({ id: mercContracts.id, status: mercContracts.status })
			.from(mercContracts)
			.where(
				and(
					inArray(mercContracts.status, ["active", "upcoming"]),
					// Over-broad on purpose: the per-row start-time comparison is
					// done in JS so this stays a single cheap indexed scan.
					gt(mercContracts.endTime, now),
				),
			)
			.limit(20);

		return rows.some((row) => row.status === "active");
	} catch (err) {
		logger.warn(
			`Failed checking for active merc contracts: ${err instanceof Error ? err.message : String(err)}`,
		);
		// Fall back to the faster tier so a transient DB error cannot silently
		// stall hit validation behind a slow cadence.
		return true;
	}
}

/**
 * Resolves the current activity tier from two independent checks: whether a
 * ranked war is engaged (in-memory, free) and whether a merc contract is
 * creditable (one cheap indexed query).
 */
export async function resolveAttackFeedActivity(): Promise<AttackFeedActivity> {
	const [warEngaged, contractActive] = await Promise.all([
		Promise.resolve(isAnyFamilyRankedWarEngaged()),
		isAnyMercContractActive(),
	]);

	if (warEngaged && contractActive) return "both";
	if (warEngaged) return "war";
	if (contractActive) return "contract";
	return "idle";
}

/** Maps an activity tier to its polling cadence. */
export function cadenceForActivity(activity: AttackFeedActivity): number {
	return ATTACK_FEED_CADENCE_MS[activity] ?? DEFAULT_ATTACK_FEED_CADENCE_MS;
}
