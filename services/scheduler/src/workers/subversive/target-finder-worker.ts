import {
	and,
	db,
	eq,
	gt,
	isNull,
	lt,
	or,
	subversiveTargetFinderTargets,
} from "@sentinel/database";

import type { UserProfileResponse } from "@sentinel/schemas";
import {
	getPlayerStats,
	type ManagedApiKey,
	tornApi,
} from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import { hasActiveSubversiveKeys } from "./subversive-key-pool";
import { computeScoreFromEstimate } from "./target-utils";

const logger = new Logger("SubversiveTargetFinderWorker");

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
		let enrichedCount = 0;
		const now = new Date();

		for (const res of results) {
			if (res.player_id && res.bs_estimate) {
				const estimatedScore = computeScoreFromEstimate(
					res.bs_estimate,
					res.distribution,
				);

				await db
					.update(subversiveTargetFinderTargets)
					.set({
						estimatedBs: res.bs_estimate,
						estimatedScore,
						updatedAt: now,
					})
					.where(eq(subversiveTargetFinderTargets.targetId, res.player_id));
				enrichedCount++;
			}
		}

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
				or(
					isNull(subversiveTargetFinderTargets.hospitalUntil),
					lt(subversiveTargetFinderTargets.hospitalUntil, now),
				),
			),
		);

	return 0;
}

/**
 * Verifies a slice of ready targets to ensure they haven't been hospitalized externally.
 */
export async function verifyReadyTargetsHospitalStatus(
	userKeys: ManagedApiKey[],
): Promise<number> {
	if (userKeys.length === 0) return 0;

	// Pick least-recently verified active ready targets scaled to key pool size
	const batchSize = Math.min(60, Math.max(15, userKeys.length * 12));
	const targetsToCheck = await db
		.select({
			targetId: subversiveTargetFinderTargets.targetId,
		})
		.from(subversiveTargetFinderTargets)
		.where(
			and(
				eq(subversiveTargetFinderTargets.inHospital, false),
				eq(subversiveTargetFinderTargets.status, "okay"),
				gt(subversiveTargetFinderTargets.estimatedScore, 0),
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
		let hospitalizedCount = 0;

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

				const state = statusObj?.state;
				const inHospital = state === "Hospital";
				const untilSeconds = statusObj?.until ?? 0;
				const hospitalUntil =
					untilSeconds > 0 ? new Date(untilSeconds * 1000) : null;

				await db
					.update(subversiveTargetFinderTargets)
					.set({
						inHospital,
						hospitalUntil,
						status: inHospital ? "hospital" : "okay",
						lastAction: lastActionDate,
						isInactive,
						factionId,
						isFactionless,
						updatedAt: now,
					})
					.where(eq(subversiveTargetFinderTargets.targetId, target.targetId));

				if (inHospital) {
					hospitalizedCount++;
				}
			}
		}

		if (hospitalizedCount > 0) {
			logger.info(
				`Detected ${hospitalizedCount} externally hospitalized targets; marked in DB.`,
			);
		}
		return hospitalizedCount;
	} catch (error) {
		logger.error("Failed to verify ready targets hospital status:", error);
		return 0;
	}
}

/**
 * Main Target Finder maintenance cycle.
 * Runs on a 15-minute quiet cadence to clear expired hospital timers and enrich candidate stats.
 */
export async function runTargetFinderCycle(): Promise<void> {
	await clearExpiredHospitalStatus();
	const activeKeys = await hasActiveSubversiveKeys();
	if (activeKeys) {
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
