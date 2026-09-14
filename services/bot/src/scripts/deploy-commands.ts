import {
	ensureTargetGuildConfigs,
	getGuildModules,
	getTargetGuildIds,
	isElimsGuildAsync,
} from "@sentinel/database";
import { REST, Routes } from "discord.js";
import {
	type BotCommand,
	elimsCommandsList,
	normalCommandsList,
} from "../commands";
import { logger } from "../lib/logger";

/**
 * Deploys slash commands directly to a specific target guild.
 * Enforces strict separation: Elims tournament guild receives ONLY Elims commands,
 * while normal guilds receive ONLY normal bot commands (filtered by active modules).
 */
export async function deployGuildCommands(
	guildId: string,
	guildName?: string,
): Promise<void> {
	const token = process.env.DISCORD_TOKEN;
	const clientId = process.env.DISCORD_CLIENT_ID;

	if (!token || !clientId || !guildId || !/^\d{17,20}$/.test(guildId)) {
		return;
	}

	const isElims = await isElimsGuildAsync(guildId);
	let enabledCommands: BotCommand[] = [];
	const serverLabel = guildName ? `server "${guildName}"` : "guild";

	if (isElims) {
		// 1. Elims Tournament Server — Strictly Elims Commands
		enabledCommands = elimsCommandsList;
		logger.info(
			`Deploying ${enabledCommands.length} Elims slash command(s) to Tournament ${serverLabel}...`,
		);
	} else {
		// 2. Standard Sentinel Guild — Normal Commands filtered by modules
		const modules = await getGuildModules(guildId);
		enabledCommands = normalCommandsList.filter((cmd) => {
			if (!cmd.module) return true;
			if (cmd.module === "verification") return modules.verification;
			if (cmd.module === "territory") return modules.territory;
			if (cmd.module === "reaction_roles") return modules.reactionRoles;
			return false;
		});
		logger.info(
			`Deploying ${enabledCommands.length} normal slash command(s) to ${serverLabel}...`,
		);
	}

	const commandBodies = enabledCommands.map((cmd) => cmd.data.toJSON());
	const rest = new REST({ version: "10" }).setToken(token);

	try {
		await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
			body: commandBodies,
		});
		logger.info(
			`Successfully deployed ${enabledCommands.length} command(s) to ${serverLabel} (${isElims ? "Elims Server" : "Standard Guild"}).`,
		);
	} catch (error) {
		logger.error(`Failed to deploy commands to ${serverLabel}:`, error);
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

	const targetGuildIds = await getTargetGuildIds();
	if (targetGuildIds.length === 0) {
		logger.warn(
			"No authorized target guild IDs found in database. Authorize a server via the dashboard.",
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
			let guildName: string | undefined;
			try {
				const g = (await rest.get(Routes.guild(guildId))) as { name?: string };
				guildName = g?.name;
			} catch {
				// Fallback to undefined if REST call fails
			}
			await deployGuildCommands(guildId, guildName);
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
