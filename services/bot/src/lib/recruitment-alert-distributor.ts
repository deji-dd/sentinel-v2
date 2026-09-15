import type {
	FactionMembersResponse,
	IpcSubversiveRecruitmentAlertPayload,
} from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
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
 * Checks if a faction position/role corresponds to a leader or co-leader.
 */
export function isLeaderRole(role?: string | null): boolean {
	if (!role) return false;
	const normalized = role.trim().toLowerCase();
	return (
		normalized === "leader" ||
		normalized === "co-leader" ||
		normalized === "coleader"
	);
}

/**
 * Attempts to fetch a player's faction role from Torn API using the configured environment key.
 */
export async function fetchFactionMemberRole(
	factionId: number,
	playerId: number,
): Promise<string | null> {
	const apiKey = process.env.TORN_API_KEY;
	if (!apiKey) return null;

	try {
		const res = (await tornApi.get("/faction/{id}/members", {
			apiKey,
			pathParams: { id: factionId },
		})) as FactionMembersResponse;

		const member = res.members?.find((m) => m.id === playerId);
		return member?.position ?? null;
	} catch (err) {
		logger.warn(
			`Failed to fetch faction member role for player ${playerId} in faction ${factionId}:`,
			err,
		);
		return null;
	}
}

/**
 * Handles incoming recruitment candidate alerts and dispatches rich Discord embeds
 * to the designated notification channel.
 */
export async function handleSubversiveRecruitmentAlert(
	client: Client,
	payload: IpcSubversiveRecruitmentAlertPayload,
): Promise<boolean> {
	if (!payload.notificationChannelId) return false;

	let factionRole = payload.factionRole;
	if (factionRole === undefined && payload.factionId && payload.playerId) {
		factionRole = await fetchFactionMemberRole(
			payload.factionId,
			payload.playerId,
		);
	}

	if (isLeaderRole(factionRole)) {
		logger.info(
			`Excluding recruitment alert for ${payload.playerName} [${payload.playerId}] (${factionRole}) — leader/co-leader roles are excluded.`,
		);
		return false;
	}

	try {
		const channel = await client.channels.fetch(payload.notificationChannelId);
		if (!channel?.isTextBased()) {
			logger.warn("Target recruitment channel not found or not text-based.");
			return false;
		}

		const textChannel = channel as TextChannel;

		const profileUrl = `https://www.torn.com/profiles.php?XID=${payload.playerId}`;
		const factionUrl = `https://www.torn.com/factions.php?step=profile&ID=${payload.factionId}`;
		const warUrl = `https://www.torn.com/war.php?step=rankreport&rankID=${payload.warId}`;

		const daysInFactionText =
			payload.daysInFaction !== undefined && payload.daysInFaction !== null
				? `${payload.daysInFaction.toLocaleString()} ${payload.daysInFaction === 1 ? "day" : "days"}`
				: "Unknown";

		const roleText = factionRole || "Unknown";

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
					name: "Faction Role",
					value: roleText,
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
		return true;
	} catch (err) {
		logger.error(
			"Failed to send subversive recruitment alert to Discord:",
			err,
		);
		return false;
	}
}
