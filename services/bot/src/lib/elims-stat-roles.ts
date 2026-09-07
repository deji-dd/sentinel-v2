import { db, elimsMemberStats, eq } from "@sentinel/database";
import type { Client } from "discord.js";
import { logger } from "./logger";

export const STAT_BUCKETS = [
	{ label: "<1b", min: 0, max: 1e9 },
	{ label: "1b-2.5b", min: 1e9, max: 2.5e9 },
	{ label: "2.5b-5b", min: 2.5e9, max: 5e9 },
	{ label: "5b-10b", min: 5e9, max: 10e9 },
	{ label: "10b-25b", min: 10e9, max: 25e9 },
	{ label: "25b-50b", min: 25e9, max: 50e9 },
	{ label: "50b-100b", min: 50e9, max: 100e9 },
	{ label: "100b-250b", min: 100e9, max: 250e9 },
	{ label: "250b-500b", min: 250e9, max: 500e9 },
	{ label: "500b-1t", min: 500e9, max: 1e12 },
	{ label: ">1t", min: 1e12, max: Number.POSITIVE_INFINITY },
] as const;

/**
 * Iterates through stored elimination member stats and auto-assigns
 * Discord roles based on each member's battle stat estimate bracket.
 */
export async function autoAssignElimsStatRoles(
	client: Client,
	guildId: string,
	roleMappings: Record<string, string>,
): Promise<{ processed: number; assigned: number; errors: number }> {
	logger.info(
		`Starting auto-assignment of stat distribution roles in guild ${guildId}...`,
	);

	const guild =
		client.guilds.cache.get(guildId) ??
		(await client.guilds.fetch(guildId).catch(() => null));

	if (!guild) {
		logger.warn(`Guild ${guildId} not found on Discord client.`);
		return { processed: 0, assigned: 0, errors: 1 };
	}

	const allTierRoleIds = new Set(
		Object.values(roleMappings).filter((r): r is string =>
			Boolean(r && r !== "none"),
		),
	);

	if (allTierRoleIds.size === 0) {
		logger.info("No valid role mappings configured for stat distribution.");
		return { processed: 0, assigned: 0, errors: 0 };
	}

	const members = await db
		.select({
			discordId: elimsMemberStats.discordId,
			bsEstimate: elimsMemberStats.bsEstimate,
			tornName: elimsMemberStats.tornName,
		})
		.from(elimsMemberStats)
		.where(eq(elimsMemberStats.guildId, guildId));

	let processed = 0;
	let assigned = 0;
	let errors = 0;

	for (const m of members) {
		if (typeof m.bsEstimate !== "number" || m.bsEstimate <= 0) {
			continue;
		}

		processed++;
		const bs = m.bsEstimate;

		// Find matching bracket
		const bucket = STAT_BUCKETS.find((b) => bs >= b.min && bs < b.max);
		if (!bucket) continue;

		const targetRoleId = roleMappings[bucket.label];
		if (!targetRoleId || targetRoleId === "none") continue;

		try {
			const member = await guild.members.fetch(m.discordId).catch(() => null);
			if (!member) continue;

			// Add target role if not already possessed
			if (!member.roles.cache.has(targetRoleId)) {
				await member.roles.add(
					targetRoleId,
					`Sentinel: Battle stat distribution role (${bucket.label})`,
				);
				assigned++;
			}

			// Clean up other tier roles to prevent multi-tier accumulation
			const rolesToRemove = Array.from(allTierRoleIds).filter(
				(rId) => rId !== targetRoleId && member.roles.cache.has(rId),
			);
			if (rolesToRemove.length > 0) {
				await member.roles.remove(
					rolesToRemove,
					"Sentinel: Pruning previous battle stat distribution role(s)",
				);
			}
		} catch (err) {
			errors++;
			logger.warn(
				`Failed assigning stat role to member ${m.discordId} (${m.tornName ?? "unknown"}):`,
				err,
			);
		}
	}

	logger.info(
		`Finished stat role assignment in guild ${guildId}: ${assigned} role(s) assigned, ${processed} member(s) processed, ${errors} error(s).`,
	);

	return { processed, assigned, errors };
}
