/**
 * Environment configuration for @sentinel/api
 */

export const env = {
	PORT: process.env.PORT ? Number(process.env.PORT) : 3002,
	NODE_ENV: process.env.NODE_ENV ?? "development",
	ALLOWED_ORIGINS: [
		"https://sentinel.blasted-labs.tech",
		"https://tt-selector.blasted-labs.tech",
		"https://sentinel.ayodejib.dev",
		"https://aquasense.ayodejib.dev",
		"https://api.ayodejib.dev",
		"http://localhost:3000",

		"http://bot-dashboard.localhost:3000",

		"http://tt-selector.localhost:3000",
		"http://127.0.0.1:3000",
	],
	SESSION_SECRET:
		process.env.SESSION_SECRET ?? "dev_session_secret_fallback_key_32b",

	// Discord OAuth2
	DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID ?? "",
	DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET ?? "",
	DISCORD_REDIRECT_URI:
		process.env.NODE_ENV === "production"
			? "https://sentinel.blasted-labs.tech/api/v1/auth/discord/callback"
			: "http://localhost:3000/api/v1/auth/discord/callback",

	DISCORD_TOKEN: process.env.DISCORD_TOKEN ?? "",
	DISCORD_USER_ID: process.env.DISCORD_USER_ID ?? "",
};
