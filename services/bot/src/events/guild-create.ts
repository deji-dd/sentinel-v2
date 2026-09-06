import { isTargetGuildAsync } from "@sentinel/database";
import { Events, type Guild } from "discord.js";
import { logger } from "../lib/logger";
import { deployGuildCommands } from "../scripts/deploy-commands";

export const guildCreateEvent = {
	name: Events.GuildCreate,
	async execute(guild: Guild): Promise<void> {
		const isAuthorized = await isTargetGuildAsync(guild.id);

		if (!isAuthorized) {
			logger.warn(
				`Bot was added to server ${guild.name} (${guild.id}) without prior authorization. Retaining in server pending dashboard configuration.`,
			);
			return;
		}

		logger.info(
			`Bot joined authorized target guild: ${guild.name} (${guild.id}). Deploying slash commands...`,
		);
		await deployGuildCommands(guild.id);
	},
} as const;
