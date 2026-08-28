import { eq } from "drizzle-orm";
import { db } from "../../index";
import { guildConfigs } from "../schema/discord";

/**
 * Helper to retrieve target Discord guild IDs configured in environment variables.
 */
export function getTargetGuildIds(): string[] {
	const raw =
		process.env.TARGET_GUILD_IDS ||
		process.env.DISCORD_GUILD_ID ||
		process.env.GUILD_ID ||
		"";

	return raw
		.split(",")
		.map((id) => id.trim())
		.filter((id) => /^\d{17,20}$/.test(id));
}

/**
 * Checks if a given guild ID is one of the configured target guilds.
 */
export function isTargetGuild(guildId: string | null | undefined): boolean {
	if (!guildId) return false;
	const targetIds = getTargetGuildIds();
	if (targetIds.length === 0) return true;
	return targetIds.includes(guildId);
}

/**
 * Ensures that default `guildConfigs` records exist in SQLite for all configured target guilds.
 */
export async function ensureTargetGuildConfigs(): Promise<void> {
	const targetGuildIds = getTargetGuildIds();
	if (targetGuildIds.length === 0) return;

	for (const guildId of targetGuildIds) {
		const existing = await db.query.guildConfigs.findFirst({
			where: eq(guildConfigs.guildId, guildId),
		});

		if (!existing) {
			await db
				.insert(guildConfigs)
				.values({
					guildId,
					adminRoleIds: [],
					verifiedRoleIds: [],
					protectedRoleIds: [],
					factionListMessageIds: [],
					ttTerritoryIds: [],
					ttFactionIds: [],
					nicknameTemplate: "[{tag}] {name} [{id}]",
					verifyOnJoin: false,
					verifyCron: false,
					verifyCronInterval: 24,
				})
				.onConflictDoNothing();
		}
	}
}
