import {
	and,
	db,
	eq,
	gt,
	isNull,
	lt,
	ne,
	or,
	sql,
	subversiveTargetFinderTargets,
} from "@sentinel/database";

import type { UserProfileResponse } from "@sentinel/schemas";
import {
	getPlayerStats,
	type ManagedApiKey,
	tornApi,
} from "@sentinel/torn-api";
import {
	isAttackableInTorn,
	isHospitalStatus,
	Logger,
	tornStateSlug,
} from "@sentinel/utils";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import {
	getSubversiveUserKeys,
	hasActiveSubversiveKeys,
} from "./subversive-key-pool";
import { computeScoreFromEstimate } from "./target-utils";

const logger = new Logger("SubversiveTargetFinderWorker");

/**
 * How long a target may stay out of the ready pool before its state is
 * re-checked against Torn. Matches the maintenance cadence, so an unavailable
 * target is eligible for exactly one verification per cycle.
 */
const RECHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Enriches targets with battle stats from the FFScouter 30-day cache.
 * Note: Soft 30d limit; never re-scouts targets who are inactive to preserve calls.
 */
export async function enrichTargetStats(): Promise<number> {
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

	// Find up to 100 targets:
	// 1. Initial estimation for any target with score = 0 (including inactive targets)
	// 2. Renewal only for active players whose stats expired > 30 days ago (skipping inactives whose stats do not change)
	const targetsToEnrich = await db
		.select({
			targetId: subversiveTargetFinderTargets.targetId,
		})
		.from(subversiveTargetFinderTargets)
		.where(
			or(
				eq(subversiveTargetFinderTargets.estimatedScore, 0),
				and(
					eq(subversiveTargetFinderTargets.isInactive, false),
					lt(subversiveTargetFinderTargets.updatedAt, thirtyDaysAgo),
				),
			),
		)
		.limit(100);

	if (targetsToEnrich.length === 0) return 0;

	const playerIds = targetsToEnrich.map((t) => t.targetId);

	try {
		const results = await getPlayerStats(playerIds);
		const now = new Date();

		// Collected first, then written in one statement: every row shares the same
		// `updatedAt`, so the only per-row values are the estimate and its score.
		// That makes a single `UPDATE ... FROM (VALUES ...)` equivalent to the
		// up-to-100 statements the old loop awaited — same rows, same values.
		const enriched: Array<{
			targetId: number;
			estimatedBs: number;
			estimatedScore: number;
		}> = [];

		for (const res of results) {
			if (res.player_id && res.bs_estimate) {
				enriched.push({
					targetId: res.player_id,
					estimatedBs: res.bs_estimate,
					estimatedScore: computeScoreFromEstimate(
						res.bs_estimate,
						res.distribution,
					),
				});
			}
		}

		if (enriched.length > 0) {
			const values = sql.join(
				enriched.map(
					(row) =>
						sql`(${row.targetId}::integer, ${row.estimatedBs}::double precision, ${row.estimatedScore}::double precision)`,
				),
				sql`, `,
			);

			await db
				.update(subversiveTargetFinderTargets)
				.set({
					estimatedBs: sql`v.estimated_bs`,
					estimatedScore: sql`v.estimated_score`,
					updatedAt: now,
				})
				.from(
					sql`(values ${values}) as v(target_id, estimated_bs, estimated_score)`,
				)
				.where(eq(subversiveTargetFinderTargets.targetId, sql`v.target_id`));
		}

		// Counts the same rows the loop counted: one per usable FFScouter result,
		// regardless of whether the target row still existed at write time.
		const enrichedCount = enriched.length;

		logger.info(
			`Enriched ${enrichedCount}/${playerIds.length} targets with FFScouter stats.`,
		);
		return enrichedCount;
	} catch (error) {
		logger.error("Failed to enrich targets with FFScouter stats:", error);
		return 0;
	}
}

/**
 * Clears hospital status for targets whose hospital time has expired.
 *
 * Only rows whose last known state is `hospital` are promoted. A hospital stay
 * is the one unavailability that ends on its own, so re-admitting it on its
 * timer is safe. Rows left unavailable for any other reason — traveling,
 * abroad, jailed — carry no `hospitalUntil` at all and are re-checked by
 * `verifyReadyTargetsHospitalStatus` instead; promoting those on a timer would
 * put a member back in the ready pool without ever asking Torn whether they can
 * be attacked.
 */
async function clearExpiredHospitalStatus(): Promise<number> {
	const now = new Date();
	await db
		.update(subversiveTargetFinderTargets)
		.set({
			inHospital: false,
			hospitalUntil: null,
			status: "okay",
			updatedAt: now,
		})
		.where(
			and(
				eq(subversiveTargetFinderTargets.inHospital, true),
				eq(subversiveTargetFinderTargets.status, "hospital"),
				or(
					isNull(subversiveTargetFinderTargets.hospitalUntil),
					lt(subversiveTargetFinderTargets.hospitalUntil, now),
				),
			),
		);

	return 0;
}

/**
 * Re-verifies a slice of targets against Torn and rewrites their availability.
 *
 * Two kinds of row need this:
 *
 * - rows sitting in the ready pool, so an external hospitalisation is caught
 *   before the target is offered again;
 * - rows kept out of the pool for a reason Torn gives no timer for — traveling,
 *   abroad, jailed. `clearExpiredHospitalStatus` cannot bring those back
 *   (there is no hospital timer to expire), so without this poll they would
 *   stay out of the pool forever.
 *
 * The write-back applies the same availability rule as the API's dispatch path:
 * `status` records what Torn actually said, and only a hospital stay carries a
 * `hospitalUntil`. Anything else leaves the row out of the pool with no timer.
 */
export async function verifyReadyTargetsHospitalStatus(
	userKeys: ManagedApiKey[],
): Promise<number> {
	if (userKeys.length === 0) return 0;

	// Unavailability with no timer is not self-healing, so a row is only polled
	// once it has been out of action for a full maintenance cadence. Without the
	// bound, a backlog of freshly unavailable rows would monopolise the batch and
	// starve the pool rows this worker exists to protect.
	const recheckBefore = new Date(Date.now() - RECHECK_INTERVAL_MS);

	// Pick least-recently verified targets scaled to key pool size
	const batchSize = Math.min(60, Math.max(15, userKeys.length * 12));
	const targetsToCheck = await db
		.select({
			targetId: subversiveTargetFinderTargets.targetId,
		})
		.from(subversiveTargetFinderTargets)
		.where(
			and(
				gt(subversiveTargetFinderTargets.estimatedScore, 0),
				or(
					// In the ready pool: catch an external hospitalisation.
					and(
						eq(subversiveTargetFinderTargets.inHospital, false),
						eq(subversiveTargetFinderTargets.status, "okay"),
					),
					// Out of the pool with no timer to expire: poll it back.
					and(
						lt(subversiveTargetFinderTargets.updatedAt, recheckBefore),
						or(
							eq(subversiveTargetFinderTargets.inHospital, true),
							ne(subversiveTargetFinderTargets.status, "okay"),
						),
					),
				),
			),
		)
		.orderBy(subversiveTargetFinderTargets.updatedAt)
		.limit(batchSize);

	if (targetsToCheck.length === 0) return 0;

	try {
		const results = await tornApi.executeBatchSettled(
			"/user/{id}/profile",
			targetsToCheck,
			(item) => ({ pathParams: { id: item.targetId } }),
			userKeys,
		);

		const now = new Date();
		let unavailableCount = 0;
		// Collected first, then written in one statement: as in `enrichTargetStats`,
		// only the per-row profile values differ, so a single
		// `UPDATE ... FROM (VALUES ...)` replaces up to 60 awaited statements.
		const verified: Array<{
			targetId: number;
			inHospital: boolean;
			hospitalUntil: Date | null;
			status: string;
			lastAction: Date | null;
			isInactive: boolean;
			factionId: number | null;
			isFactionless: boolean;
		}> = [];

		for (let i = 0; i < results.length; i++) {
			const res = results[i];
			const target = targetsToCheck[i];
			if (res?.status === "fulfilled" && target) {
				const profileData = res.value as UserProfileResponse;
				const statusObj = profileData.profile?.status;
				const lastActionObj = profileData.profile?.last_action;
				const factionId = profileData.profile?.faction_id ?? null;
				const isFactionless = factionId === null;

				const lastActionTimestamp = lastActionObj?.timestamp;
				const lastActionDate =
					lastActionTimestamp && lastActionTimestamp > 0
						? new Date(lastActionTimestamp * 1000)
						: null;
				const isInactive =
					lastActionTimestamp && lastActionTimestamp > 0
						? now.getTime() - lastActionTimestamp * 1000 >
							14 * 24 * 60 * 60 * 1000
						: false;

				const attackable = isAttackableInTorn(statusObj);
				const isHospitalStay = isHospitalStatus(statusObj);
				const untilSeconds = statusObj?.until ?? 0;
				const hospitalUntil =
					isHospitalStay && untilSeconds > 0
						? new Date(untilSeconds * 1000)
						: null;

				if (!attackable) unavailableCount++;

				verified.push({
					targetId: target.targetId,
					inHospital: !attackable,
					hospitalUntil,
					status: tornStateSlug(statusObj),
					lastAction: lastActionDate,
					isInactive,
					factionId,
					isFactionless,
				});
			}
		}

		if (verified.length > 0) {
			const values = sql.join(
				verified.map(
					(row) =>
						sql`(${row.targetId}::integer, ${row.inHospital}::boolean, ${row.hospitalUntil?.toISOString() ?? null}::timestamptz, ${row.status}::text, ${row.lastAction?.toISOString() ?? null}::timestamptz, ${row.isInactive}::boolean, ${row.factionId}::integer, ${row.isFactionless}::boolean)`,
				),
				sql`, `,
			);

			await db
				.update(subversiveTargetFinderTargets)
				.set({
					inHospital: sql`v.in_hospital`,
					hospitalUntil: sql`v.hospital_until`,
					status: sql`v.status`,
					lastAction: sql`v.last_action`,
					isInactive: sql`v.is_inactive`,
					factionId: sql`v.faction_id`,
					isFactionless: sql`v.is_factionless`,
					updatedAt: now,
				})
				.from(
					sql`(values ${values}) as v(target_id, in_hospital, hospital_until, status, last_action, is_inactive, faction_id, is_factionless)`,
				)
				.where(eq(subversiveTargetFinderTargets.targetId, sql`v.target_id`));
		}

		if (unavailableCount > 0) {
			logger.info(
				`Detected ${unavailableCount} targets that are no longer attackable (hospital, traveling or abroad); marked in DB.`,
			);
		}
		return unavailableCount;
	} catch (error) {
		logger.error("Failed to verify ready targets hospital status:", error);
		return 0;
	}
}

/**
 * Main Target Finder maintenance cycle.
 *
 * Runs on a 15-minute quiet cadence: expiry first (a hospital stay that ended on
 * its own goes straight back into the pool), then a slice of Torn verification
 * so nothing is offered as a target without Torn vouching for it, then stat
 * enrichment for rows that still lack a score.
 */
export async function runTargetFinderCycle(): Promise<void> {
	await clearExpiredHospitalStatus();
	const activeKeys = await hasActiveSubversiveKeys();
	if (activeKeys) {
		await verifyReadyTargetsHospitalStatus(await getSubversiveUserKeys());
		await enrichTargetStats();
	}
}

export const startSubversiveTargetFinderWorker: WorkerStarter = (options?: {
	initialDelayMs?: number;
}) => {
	startEventDrivenRunner({
		worker: "subversive:target_finder_worker",
		defaultCadenceSeconds: 15 * 60, // 15-minute loop
		initialDelayMs: options?.initialDelayMs ?? 10000,
		handler: async () => {
			await runTargetFinderCycle();
		},
	});
};
