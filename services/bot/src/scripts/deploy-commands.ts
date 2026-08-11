import { db, eq, guildConfigs } from "@sentinel/database";
import { normalizeModules } from "@sentinel/utils";
import { REST, Routes } from "discord.js";
import { commandsList } from "../commands";
import { logger } from "../lib/logger";

/**
 * Deploys slash commands filtered by active modules for a specific guild.
 */
export async function deployGuildCommands(guildId: string): Promise<void> {
	const token = process.env.DISCORD_TOKEN;
	const clientId = process.env.DISCORD_CLIENT_ID;

	if (!token || !clientId) return;

	const config = await db.query.guildConfigs.findFirst({
		where: eq(guildConfigs.guildId, guildId),
	});

	const enabledModules = new Set(
		normalizeModules(config?.enabledModules || []),
	);

	// Filter commands that are either global (no module required) or match enabled modules
	const activeCommands = commandsList.filter((cmd) => {
		if (!cmd.module) return true;
		return enabledModules.has(cmd.module);
	});

	const commandBodies = activeCommands.map((cmd) => cmd.data.toJSON());
	const rest = new REST({ version: "10" }).setToken(token);

	try {
		const globalCmdCount = commandsList.filter((cmd) => !cmd.module).length;
		const moduleCmdCount = commandBodies.length - globalCmdCount;

		logger.info(
			`Deploying ${commandBodies.length} slash commands (${globalCmdCount} base + ${moduleCmdCount} module) to Guild ${guildId} (Active Modules: ${Array.from(enabledModules).join(", ") || "none"})...`,
		);

		await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
			body: commandBodies,
		});
	} catch (error) {
		logger.error(`Failed to deploy commands to guild ${guildId}:`, error);
	}
}

/**
 * Deploys global base commands to Discord API and module-specific commands to configured guilds.
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

	const rest = new REST({ version: "10" }).setToken(token);

	try {
		// 1. Deploy Global Commands (commands without module dependency)
		const globalCommands = commandsList.filter((cmd) => !cmd.module);
		const globalBodies = globalCommands.map((cmd) => cmd.data.toJSON());

		logger.info(
			`Deploying ${globalBodies.length} global slash commands across all servers...`,
		);
		await rest.put(Routes.applicationCommands(clientId), {
			body: globalBodies,
		});

		// 2. Deploy Module-Specific Commands per Guild
		const allGuildConfigs = await db.query.guildConfigs.findMany();
		for (const guildCfg of allGuildConfigs) {
			await deployGuildCommands(guildCfg.guildId);
		}
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
