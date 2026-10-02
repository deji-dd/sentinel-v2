/**
 * Environment configuration for @sentinel/api
 */

export const env = {
	PORT: process.env.PORT ? Number(process.env.PORT) : 3002,
	NODE_ENV: process.env.NODE_ENV ?? "development",
	ALLOWED_ORIGINS: [
		"https://dashboard.blasted-labs.tech",
		"https://sentinel.blasted-labs.tech",
		"https://api.blasted-labs.tech",
		"https://tt-selector.blasted-labs.tech",
		"https://elims.blasted-labs.tech",
		"https://api.elims.blasted-labs.tech",
		"https://subversive.blasted-labs.tech",
		"https://aquasense.ayodejib.dev",
		"https://api.ayodejib.dev",
		"http://localhost:3000",
		"http://localhost:5173",
		"http://localhost:5175",
		"http://localhost:5176",
		"http://localhost:5177",
		"http://127.0.0.1:3000",
	],
	SESSION_SECRET:
		process.env.SESSION_SECRET ?? "dev_session_secret_fallback_key_32b",

	// Discord OAuth2
	DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID ?? "",
	DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET ?? "",
	DISCORD_REDIRECT_URI:
		process.env.DISCORD_REDIRECT_URI ??
		(process.env.NODE_ENV === "production"
			? "https://api.blasted-labs.tech/v2/auth/discord/callback"
			: "http://localhost:3000/v2/auth/discord/callback"),

	DISCORD_TOKEN: process.env.DISCORD_TOKEN ?? "",
	DISCORD_USER_ID: process.env.DISCORD_USER_ID ?? "",

	// Server Types (Inferred from Environment)
	ALLIANCE_GUILD_ID:
		process.env.ALLIANCE_GUILD_ID ||
		process.env.DISCORD_ALLIANCE_GUILD_ID ||
		null,
	FACTION_GUILD_ID:
		process.env.FACTION_GUILD_ID ||
		process.env.DISCORD_FACTION_GUILD_ID ||
		null,
	ELIMS_GUILD_ID:
		process.env.ELIMS_GUILD_ID || process.env.DISCORD_ELIMS_GUILD_ID || null,
	OWNER_GUILD_ID:
		process.env.OWNER_GUILD_ID || process.env.DISCORD_OWNER_GUILD_ID || null,
	MERC_GUILD_ID:
		process.env.MERC_GUILD_ID ||
		process.env.DISCORD_MERC_GUILD_ID ||
		process.env.MERCENARY_GUILD_ID ||
		process.env.DISCORD_MERCENARY_GUILD_ID ||
		null,
};
