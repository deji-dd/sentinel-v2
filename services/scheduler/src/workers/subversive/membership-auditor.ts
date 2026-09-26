import { db, eq, subversiveTargetFinderUsers } from "@sentinel/database";
import type { FactionMembersResponse } from "@sentinel/schemas";
import { type ManagedApiKey, tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import { startEventDrivenRunner } from "../../lib/scheduler";
import type { WorkerStarter } from "../registry";
import {
	getNextSubversiveUserKey,
	hasActiveSubversiveKeys,
} from "./subversive-key-pool";

const logger = new Logger("SubversiveMembershipAuditor");

const SUBVERSIVE_FACTION_ID = 2013;

/**
 * Audit active Subversive Target Finder users against Faction 2013 roster.
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

	try {
		const factionRes = (await tornApi.get("/faction/{id}/members", {
			apiKey: apiKey.apiKey,
			userId: apiKey.userId,
			pathParams: { id: SUBVERSIVE_FACTION_ID },
		})) as FactionMembersResponse;

		const activeFactionMemberIds = new Set(
			(factionRes.members ?? []).map((m) => m.id),
		);

		let revokedCount = 0;
		for (const user of activeUsers) {
			if (!activeFactionMemberIds.has(user.tornId)) {
				logger.warn(
					`User ${user.tornName} [${user.tornId}] is no longer in Subversive Alliance (${SUBVERSIVE_FACTION_ID}). Revoking access.`,
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

		if (revokedCount > 0) {
			logger.info(
				`Revoked Target Finder access for ${revokedCount} former member(s).`,
			);
		}
		return revokedCount;
	} catch (error) {
		logger.error("Failed to audit Subversive Alliance faction roster:", error);
		return 0;
	}
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
