import { env } from "../config/env";

const DISCORD_API = "https://discord.com/api/v10";

interface DiscordGuildSummary {
	id: string;
	name: string;
	icon: string | null;
	owner: boolean;
	permissions: string;
}

/**
 * Helper to fetch Discord REST API v10 endpoints with error catching.
 */
export async function fetchDiscordApi<T>(
	endpoint: string,
	authorization: string,
): Promise<T | null> {
	try {
		const res = await fetch(`${DISCORD_API}${endpoint}`, {
			headers: { Authorization: authorization },
		});
		if (!res.ok) return null;
		return (await res.json()) as T;
	} catch {
		return null;
	}
}

/**
 * Checks whether the user shares at least one Discord server where Sentinel is installed.
 * Bot owners and administrators automatically pass this validation.
 */
export async function verifyUserSharesGuildWithBot(
	userAccessToken: string,
	discordUserId?: string,
): Promise<boolean> {
	// If owner discord ID is set and matches the user, bypass
	if (
		discordUserId &&
		env.DISCORD_USER_ID &&
		discordUserId === env.DISCORD_USER_ID
	) {
		return true;
	}

	const botToken = env.DISCORD_TOKEN;
	// If in local development or bot token is missing, permit access
	if (!botToken || env.NODE_ENV === "development") {
		return true;
	}

	const [userGuilds, botGuilds] = await Promise.all([
		fetchDiscordApi<DiscordGuildSummary[]>(
			"/users/@me/guilds",
			`Bearer ${userAccessToken}`,
		),
		fetchDiscordApi<DiscordGuildSummary[]>(
			"/users/@me/guilds",
			`Bot ${botToken}`,
		),
	]);

	if (!userGuilds || !botGuilds) {
		return false;
	}

	const botGuildIds = new Set(botGuilds.map((g) => g.id));
	const hasMutualGuild = userGuilds.some((g) => botGuildIds.has(g.id));

	return hasMutualGuild;
}
