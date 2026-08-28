import { isTargetGuild } from "@sentinel/database";
import { Events, type Guild } from "discord.js";
import { logger } from "../lib/logger";

export const guildCreateEvent = {
	name: Events.GuildCreate,
	async execute(guild: Guild): Promise<void> {
		if (!isTargetGuild(guild.id)) {
			logger.warn(
				`Bot was added to unauthorized server ${guild.name} (${guild.id}). Leaving immediately...`,
			);
			await guild.leave().catch((err) => {
				logger.error(`Failed to leave unauthorized guild ${guild.id}:`, err);
			});
		} else {
			logger.info(
				`Bot joined authorized target guild: ${guild.name} (${guild.id})`,
			);
		}
	},
} as const;
