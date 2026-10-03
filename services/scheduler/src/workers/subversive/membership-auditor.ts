import { db, eq, subversiveTargetFinderUsers } from "@sentinel/database";
import type { FactionMembersResponse } from "@sentinel/schemas";
import { type ManagedApiKey, tornApi } from "@sentinel/torn-api";
import {
	getSubversiveFactionName,
	Logger,
	resolveSubversiveFactionId,
} from "@sentinel/utils";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import {
	getNextSubversiveUserKey,
	hasActiveSubversiveKeys,
} from "./subversive-key-pool";

const logger = new Logger("SubversiveMembershipAuditor");

/**
 * Audits active Subversive Target Finder users against the roster of the faction
 * each user belongs to (2013 Subversive Alliance, 27312 SA Succession).
 */
export async function auditSubversiveMembership(
	apiKey: ManagedApiKey | null,
): Promise<number> {
	if (!apiKey) return 0;

	const activeUsers = await db
		.select()
		.from(subversiveTargetFinderUsers)
		.where(eq(subversiveTargetFinderUsers.isActive, true));

	if (activeUsers.length === 0) return 0;

	// Group users by their family faction so each roster is fetched only once
	const usersByFaction = new Map<number, typeof activeUsers>();
	for (const user of activeUsers) {
		const factionId = resolveSubversiveFactionId(user.factionId);
		const bucket = usersByFaction.get(factionId);
		if (bucket) {
			bucket.push(user);
		} else {
			usersByFaction.set(factionId, [user]);
		}
	}

	let revokedCount = 0;

	for (const [factionId, users] of usersByFaction) {
		try {
			const factionRes = (await tornApi.get("/faction/{id}/members", {
				apiKey: apiKey.apiKey,
				userId: apiKey.userId,
				pathParams: { id: factionId },
			})) as FactionMembersResponse;

			const activeFactionMemberIds = new Set(
				(factionRes.members ?? []).map((m) => m.id),
			);

			for (const user of users) {
				if (!activeFactionMemberIds.has(user.tornId)) {
					logger.warn(
						`User ${user.tornName} [${user.tornId}] is no longer in ${getSubversiveFactionName(factionId)} (${factionId}). Revoking access.`,
					);
					await db
						.update(subversiveTargetFinderUsers)
						.set({
							isActive: false,
							updatedAt: new Date(),
						})
						.where(eq(subversiveTargetFinderUsers.tornId, user.tornId));
					revokedCount++;
				}
			}
		} catch (error) {
			logger.error(`Failed to audit faction ${factionId} roster:`, error);
		}
	}

	if (revokedCount > 0) {
		logger.info(
			`Revoked Target Finder access for ${revokedCount} former member(s).`,
		);
	}
	return revokedCount;
}

/**
 * Main membership auditor cycle.
 * Runs on a 15-minute quiet cadence to audit faction roster.
 */
export async function runMembershipAuditorCycle(): Promise<void> {
	const activeKeys = await hasActiveSubversiveKeys();
	if (!activeKeys) {
		logger.debug(
			"No active Subversive script keys enrolled. Membership auditor worker dormant.",
		);
		return;
	}

	const nextKey = await getNextSubversiveUserKey();
	await auditSubversiveMembership(nextKey);
}

export const startSubversiveMembershipAuditor: WorkerStarter = (options?: {
	initialDelayMs?: number;
}) => {
	startEventDrivenRunner({
		worker: "subversive:membership_auditor",
		defaultCadenceSeconds: 15 * 60, // 15-minute loop
		initialDelayMs: options?.initialDelayMs ?? 10000,
		handler: async () => {
			await runMembershipAuditorCycle();
		},
	});
};
