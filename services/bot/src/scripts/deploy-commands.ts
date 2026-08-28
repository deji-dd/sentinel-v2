import {
	ensureTargetGuildConfigs,
	getTargetGuildIds,
} from "@sentinel/database";
import { REST, Routes } from "discord.js";
import { commandsList } from "../commands";
import { logger } from "../lib/logger";

/**
 * Deploys all slash commands directly to a specific target guild.
 */
export async function deployGuildCommands(guildId: string): Promise<void> {
	const token = process.env.DISCORD_TOKEN;
	const clientId = process.env.DISCORD_CLIENT_ID;

	if (!token || !clientId || !guildId || !/^\d{17,20}$/.test(guildId)) {
		return;
	}

	const commandBodies = commandsList.map((cmd) => cmd.data.toJSON());
	const rest = new REST({ version: "10" }).setToken(token);

	try {
		logger.info(
			`Deploying ${commandBodies.length} slash commands directly to Guild ${guildId}...`,
		);

		await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
			body: commandBodies,
		});
		logger.info(`Successfully deployed commands to Guild ${guildId}.`);
	} catch (error) {
		logger.error(`Failed to deploy commands to guild ${guildId}:`, error);
	}
}

/**
 * Deploys all slash commands directly to configured target guilds in ENV.
 * Also cleans up any stale global commands.
 */
export async function deployCommands(): Promise<void> {
	const token = process.env.DISCORD_TOKEN;
	const clientId = process.env.DISCORD_CLIENT_ID;

	if (!token || !clientId) {
		logger.warn(
			"Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment variables. Skipping command deployment.",
		);
		return;
	}

	const targetGuildIds = getTargetGuildIds();
	if (targetGuildIds.length === 0) {
		logger.warn(
			"No target guild IDs found in TARGET_GUILD_IDS or DISCORD_GUILD_ID. Please specify target guilds in .env.",
		);
		return;
	}

	const rest = new REST({ version: "10" }).setToken(token);

	try {
		// 1. Wipe old global commands to prevent duplicates
		logger.info("Clearing legacy global slash commands...");
		await rest.put(Routes.applicationCommands(clientId), {
			body: [],
		});

		// 2. Ensure configs exist in database
		await ensureTargetGuildConfigs();

		// 3. Deploy all commands to each target guild
		for (const guildId of targetGuildIds) {
			await deployGuildCommands(guildId);
		}
		logger.info("Command deployment completed across all target guilds.");
	} catch (error) {
		logger.error("Failed to deploy slash commands:", error);
	}
}

// Executable CLI support for Bun
if (import.meta.main) {
	deployCommands()
		.then(() => {
			process.exit(0);
		})
		.catch((err) => {
			logger.error("Failed to deploy commands:", err);
			process.exit(1);
		});
}
