import { db, eq, guildConfigs } from "@sentinel/database";
import { type Client, type EmbedBuilder, TextChannel } from "discord.js";
import { logger } from "./logger";

/**
 * Sends an audit log embed to the configured guild log channel if enabled.
 */
export async function sendGuildAuditLog(
	client: Client,
	guildId: string,
	embed: EmbedBuilder,
): Promise<void> {
	try {
		const config = await db.query.guildConfigs.findFirst({
			where: eq(guildConfigs.guildId, guildId),
		});

		if (!config?.logChannelId) return;

		const channel = await client.channels
			.fetch(config.logChannelId)
			.catch(() => null);

		if (channel && channel instanceof TextChannel) {
			await channel.send({ embeds: [embed] }).catch(() => {});
		}
	} catch (error) {
		logger.warn(`Failed to send audit log for guild ${guildId}:`, error);
	}
}
