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
	if (targetIds.length === 0) return true; // If none configured, allow all
	return targetIds.includes(guildId);
}
