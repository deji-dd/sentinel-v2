import type { SubversiveChainAlertPayload } from "@sentinel/schemas";
import { formatNumber } from "@sentinel/utils";
import type { Client, EmbedBuilder, TextChannel } from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

function profileUrl(targetId: number): string {
	return `https://www.torn.com/profiles.php?XID=${targetId}`;
}

function attackUrl(targetId: number): string {
	return `https://www.torn.com/page.php?sid=attack&user2ID=${targetId}`;
}

/**
 * The role mention that opens every chain warning.
 *
 * Kept separate from the embed so delivery can pass an explicit
 * `allowedMentions.roles` list. No other mention (including `@everyone` or
 * `@here`) is ever allowed.
 */
export function buildChainAlertContent(
	payload: SubversiveChainAlertPayload,
): string | undefined {
	return payload.warningRoleId ? `<@&${payload.warningRoleId}>` : undefined;
}

/**
 * Builds the warning embed: chain size, the timer that triggered it, and the
 * low-stat okay targets a member can immediately hit to keep the chain alive.
 */
export function buildChainAlertEmbed(
	payload: SubversiveChainAlertPayload,
): EmbedBuilder {
	const expiresAt = Math.floor(Date.now() / 1000) + payload.timeoutSeconds;
	const color =
		payload.timeoutSeconds <= 15 ? EMBED_COLORS.DANGER : EMBED_COLORS.WARNING;

	const embed = createBaseEmbed(
		`Chain Warning — ${payload.factionName} [${payload.factionId}]`,
		undefined,
		color,
	);

	embed.addFields(
		{
			name: "Chain",
			value: `**${payload.chainCurrent.toLocaleString("en-US")}** / ${payload.chainMax.toLocaleString("en-US")}`,
			inline: true,
		},
		{
			name: "Time Remaining",
			value: `**${payload.timeoutSeconds}s** (<t:${expiresAt}:R>)`,
			inline: true,
		},
		{
			name: "Chain Modifier",
			value: `${payload.modifier.toFixed(2)}x`,
			inline: true,
		},
	);

	const targets = payload.targets ?? [];
	const targetValue =
		targets.length > 0
			? targets
					.map(
						(target) =>
							`[${target.name} [${target.id}]](${profileUrl(target.id)}) — Lv ${target.level} · ~${formatNumber(target.estimatedBs)} BS · [Attack](${attackUrl(target.id)})`,
					)
					.join("\n")
			: "No okay targets are currently in the target-finder pool.";

	embed.addFields({
		name: "Low-Stat Okay Targets",
		value: targetValue,
		inline: false,
	});

	embed.setFooter({
		text: `Sentinel • Warning #${payload.warningNumber}`,
	});

	return embed;
}

/**
 * Delivers one chain warning to its configured channel.
 *
 * Delivery failure is logged and reported as `false`; the scheduler's next
 * warning interval will try again. Nothing here retries in a loop, so a deleted
 * channel cannot pin the bot process.
 */
export async function handleSubversiveChainAlert(
	client: Client,
	payload: SubversiveChainAlertPayload,
): Promise<boolean> {
	if (!payload.channelId) return false;

	try {
		const channel = (await client.channels
			.fetch(payload.channelId)
			.catch(() => null)) as TextChannel | null;

		if (!channel?.isTextBased()) {
			logger.warn(
				`Chain alert channel not found or not text-based: ${payload.channelId}`,
			);
			return false;
		}

		const content = buildChainAlertContent(payload);
		await channel.send({
			...(content ? { content } : {}),
			embeds: [buildChainAlertEmbed(payload)],
			allowedMentions: {
				parse: [],
				roles: payload.warningRoleId ? [payload.warningRoleId] : [],
			},
		});

		logger.info(
			`Dispatched chain warning #${payload.warningNumber} for faction ${payload.factionId} to channel ${payload.channelId}.`,
		);
		return true;
	} catch (err) {
		logger.error(
			`Failed to deliver chain warning for faction ${payload.factionId}:`,
			err,
		);
		return false;
	}
}
