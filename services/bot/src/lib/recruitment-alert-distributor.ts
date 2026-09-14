import type { IpcSubversiveRecruitmentAlertPayload } from "@sentinel/schemas";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Client,
	type TextChannel,
} from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

function formatNumberHuman(num: number | null | undefined): string {
	if (num === null || num === undefined || num === 0) return "Unknown";
	if (num >= 1_000_000_000) {
		return `${(num / 1_000_000_000).toFixed(2)}B`;
	}
	if (num >= 1_000_000) {
		return `${(num / 1_000_000).toFixed(2)}M`;
	}
	if (num >= 1_000) {
		return `${(num / 1_000).toFixed(1)}K`;
	}
	return num.toLocaleString();
}

/**
 * Handles incoming recruitment candidate alerts and dispatches rich Discord embeds
 * to the designated notification channel.
 */
export async function handleSubversiveRecruitmentAlert(
	client: Client,
	payload: IpcSubversiveRecruitmentAlertPayload,
): Promise<void> {
	if (!payload.notificationChannelId) return;

	try {
		const channel = await client.channels.fetch(payload.notificationChannelId);
		if (!channel?.isTextBased()) {
			logger.warn("Target recruitment channel not found or not text-based.");
			return;
		}

		const textChannel = channel as TextChannel;

		const profileUrl = `https://www.torn.com/profiles.php?XID=${payload.playerId}`;
		const factionUrl = `https://www.torn.com/factions.php?step=profile&ID=${payload.factionId}`;
		const warUrl = `https://www.torn.com/war.php?step=rankreport&rankID=${payload.warId}`;

		const daysInFactionText =
			payload.daysInFaction !== undefined && payload.daysInFaction !== null
				? `${payload.daysInFaction.toLocaleString()} ${payload.daysInFaction === 1 ? "day" : "days"}`
				: "Unknown";

		const embed = createBaseEmbed(
			`Recruitment Alert`,
			undefined,
			EMBED_COLORS.PRIMARY,
		)
			.addFields(
				{
					name: "Player",
					value: `[${payload.playerName} [${payload.playerId}]](${profileUrl}) — Level ${payload.playerLevel}`,
					inline: true,
				},
				{
					name: "Faction",
					value: `[${payload.factionName} [${payload.factionId}]](${factionUrl})`,
					inline: true,
				},
				{
					name: "Days in Faction",
					value: daysInFactionText,
					inline: true,
				},
				{
					name: "Estimated Stats",
					value: `${formatNumberHuman(payload.bsEstimate)}${
						payload.fairFight ? ` (FF: ${payload.fairFight.toFixed(2)})` : ""
					}`,
					inline: true,
				},
				{
					name: "War Contribution",
					value: `**${payload.attacks}** hits (**${payload.attackPercentage.toFixed(1)}%** of ${payload.factionTotalAttacks})\nScore: **${payload.score.toLocaleString()}**`,
					inline: true,
				},
				{
					name: "Source War",
					value: `[Ranked War #${payload.warId}](${warUrl})`,
					inline: true,
				},
			)
			.setFooter({
				text: "Sentinel",
			});

		const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setLabel("Torn Profile")
				.setStyle(ButtonStyle.Link)
				.setURL(profileUrl),
			new ButtonBuilder()
				.setLabel("War Report")
				.setStyle(ButtonStyle.Link)
				.setURL(warUrl),
		);

		await textChannel.send({
			embeds: [embed],
			components: [actionRow],
		});

		const channelLabel = textChannel.name ? `#${textChannel.name}` : "channel";
		logger.info(
			`Dispatched recruitment lead embed for ${payload.playerName} [${payload.playerId}] to ${channelLabel}.`,
		);
	} catch (err) {
		logger.error(
			"Failed to send subversive recruitment alert to Discord:",
			err,
		);
	}
}
