import type { DibsRecord } from "@sentinel/schemas";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type Client,
	MessageFlags,
	type TextChannel,
} from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

const API_BASE_URL =
	process.env.API_URL ||
	(process.env.PORT
		? `http://127.0.0.1:${process.env.PORT}`
		: "http://127.0.0.1:3002");

function formatStats(num: number | null | undefined): string {
	if (!num || !Number.isFinite(num)) return "Unknown";
	if (num >= 1e15) return `${(num / 1e15).toFixed(2)}Q`;
	if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
	if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
	if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
	if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k`;
	return Math.round(num).toLocaleString();
}

/**
 * Builds the ActionRow containing interactive buttons for a Dibs embed (strictly zero emojis).
 */
function buildDibsActionRow(
	targetId: number,
	status: "open" | "claimed",
): ActionRowBuilder<ButtonBuilder> {
	const row = new ActionRowBuilder<ButtonBuilder>();

	if (status === "open") {
		row.addComponents(
			new ButtonBuilder()
				.setCustomId(`dibs_claim:${targetId}`)
				.setLabel("Claim Dibs")
				.setStyle(ButtonStyle.Primary),
		);
	} else {
		row.addComponents(
			new ButtonBuilder()
				.setCustomId(`dibs_release:${targetId}`)
				.setLabel("Release Dibs")
				.setStyle(ButtonStyle.Secondary),
		);
	}

	row.addComponents(
		new ButtonBuilder()
			.setStyle(ButtonStyle.Link)
			.setLabel("Profile")
			.setURL(`https://www.torn.com/profiles.php?XID=${targetId}`),
		new ButtonBuilder()
			.setStyle(ButtonStyle.Link)
			.setLabel("Attack")
			.setURL(`https://www.torn.com/loader.php?sid=attack&user2ID=${targetId}`),
	);

	return row;
}

/**
 * Posts a new Dibs callout embed to the specified Discord channel when target enters lead time.
 */
export async function postDibsAlert(
	client: Client,
	channelId: string,
	dibs: DibsRecord,
): Promise<void> {
	try {
		const channel = (await client.channels
			.fetch(channelId)
			.catch(() => null)) as TextChannel | null;
		if (!channel || !("send" in channel)) {
			logger.warn(`Dibs channel not found or not sendable: ${channelId}`);
			return;
		}

		const targetProfileUrl = `https://www.torn.com/profiles.php?XID=${dibs.targetId}`;
		const embed = createBaseEmbed(
			`Target Exiting Hospital: ${dibs.targetName} [${dibs.targetId}]`,
			`Target: [${dibs.targetName} [${dibs.targetId}]](${targetProfileUrl})\nLevel ${dibs.targetLevel} | Estimated BS: ${formatStats(dibs.estimatedBs)}`,
			EMBED_COLORS.PRIMARY,
		);

		embed.addFields(
			{
				name: "Hospital Exit",
				value: `<t:${dibs.hospitalUntil}:R> (<t:${dibs.hospitalUntil}:T>)`,
				inline: true,
			},
			{
				name: "Status",
				value: "Available for Claim",
				inline: true,
			},
		);

		const row = buildDibsActionRow(dibs.targetId, "open");
		const msg = await channel.send({ embeds: [embed], components: [row] });

		// Notify API of messageId so future edits/deletes know the exact Discord message
		await fetch(`${API_BASE_URL}/api/v1/subversive/dibs/record-message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				targetId: dibs.targetId,
				channelId,
				messageId: msg.id,
			}),
		}).catch((err) => {
			logger.warn("Failed recording dibs message ID with Sentinel API:", err);
		});
	} catch (err) {
		logger.error("Failed to post dibs alert to Discord:", err);
	}
}

/**
 * Updates an existing Dibs alert message when claimed, released, or lock expired.
 */
export async function updateDibsAlert(
	client: Client,
	channelId: string,
	messageId: string,
	dibs: DibsRecord,
	status: "open" | "claimed",
): Promise<void> {
	try {
		const channel = (await client.channels
			.fetch(channelId)
			.catch(() => null)) as TextChannel | null;
		if (!channel || !("messages" in channel)) return;

		const message = await channel.messages.fetch(messageId).catch(() => null);
		if (!message) return;

		const isClaimed = status === "claimed";
		const claimantDisplay =
			dibs.claimedBy?.tornId && dibs.claimedBy?.tornName
				? `[${dibs.claimedBy.tornName} [${dibs.claimedBy.tornId}]](https://www.torn.com/profiles.php?XID=${dibs.claimedBy.tornId})`
				: (dibs.claimedBy?.tornName ??
					dibs.claimedBy?.discordTag ??
					"Teammate");

		const statusText = isClaimed
			? `Claimed by ${claimantDisplay} (<t:${Math.floor((dibs.claimedAt || Date.now()) / 1000)}:R>)`
			: "Available for Claim (Lock released)";

		const targetProfileUrl = `https://www.torn.com/profiles.php?XID=${dibs.targetId}`;
		const embed = createBaseEmbed(
			`Target Exiting Hospital: ${dibs.targetName} [${dibs.targetId}]`,
			`Target: [${dibs.targetName} [${dibs.targetId}]](${targetProfileUrl})\nLevel ${dibs.targetLevel} | Estimated BS: ${formatStats(dibs.estimatedBs)}`,
			isClaimed ? EMBED_COLORS.WARNING : EMBED_COLORS.PRIMARY,
		);

		embed.addFields(
			{
				name: "Hospital Exit",
				value: `<t:${dibs.hospitalUntil}:R> (<t:${dibs.hospitalUntil}:T>)`,
				inline: true,
			},
			{
				name: "Status",
				value: statusText,
				inline: true,
			},
		);

		const row = buildDibsActionRow(dibs.targetId, status);
		await message.edit({ embeds: [embed], components: [row] });
	} catch (err) {
		logger.warn("Failed to update dibs alert in Discord:", err);
	}
}

/**
 * Deletes a Dibs message when the target has been downed in hospital.
 */
export async function deleteDibsAlert(
	client: Client,
	channelId: string,
	messageId: string,
): Promise<void> {
	try {
		const channel = (await client.channels
			.fetch(channelId)
			.catch(() => null)) as TextChannel | null;
		if (!channel || !("messages" in channel)) return;

		const message = await channel.messages.fetch(messageId).catch(() => null);
		if (message) {
			await message.delete().catch(() => {});
		}
	} catch (err) {
		logger.warn("Failed deleting downed target dibs alert:", err);
	}
}

/**
 * Handles a Discord button interaction for claiming dibs.
 */
export async function handleDibsClaimButton(
	interaction: ButtonInteraction,
): Promise<void> {
	const targetIdStr = interaction.customId.split(":")[1];
	const targetId = Number.parseInt(targetIdStr ?? "", 10);
	if (!targetId || Number.isNaN(targetId)) return;

	try {
		const res = await fetch(
			`${API_BASE_URL}/api/v1/subversive/dibs/claim-discord`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					targetId,
					discordUserId: interaction.user.id,
					discordUsername: interaction.user.tag || interaction.user.username,
				}),
			},
		);

		const json = (await res.json()) as {
			success?: boolean;
			error?: string;
			dibs?: DibsRecord;
		};

		if (json.success && json.dibs) {
			const claimant =
				json.dibs.claimedBy?.tornName && json.dibs.claimedBy?.tornId
					? `${json.dibs.claimedBy.tornName} [${json.dibs.claimedBy.tornId}]`
					: "You";

			await interaction.reply({
				content: `Dibs confirmed for ${json.dibs.targetName} [${json.dibs.targetId}] by ${claimant}. You have 20 seconds after hospital exit to initiate attack.`,
				flags: MessageFlags.Ephemeral,
			});
		} else {
			await interaction.reply({
				content: json.error || "Unable to claim dibs.",
				flags: MessageFlags.Ephemeral,
			});
		}
	} catch (err) {
		logger.error("Error claiming dibs via Discord button:", err);
		await interaction
			.reply({
				content: "Internal error processing claim. Please try again.",
				flags: MessageFlags.Ephemeral,
			})
			.catch(() => {});
	}
}

/**
 * Handles a Discord button interaction for releasing dibs.
 */
export async function handleDibsReleaseButton(
	interaction: ButtonInteraction,
): Promise<void> {
	const targetIdStr = interaction.customId.split(":")[1];
	const targetId = Number.parseInt(targetIdStr ?? "", 10);
	if (!targetId || Number.isNaN(targetId)) return;

	try {
		const res = await fetch(
			`${API_BASE_URL}/api/v1/subversive/dibs/release-discord`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					targetId,
					discordUserId: interaction.user.id,
				}),
			},
		);

		const json = (await res.json()) as {
			success?: boolean;
			error?: string;
		};

		if (json.success) {
			await interaction.reply({
				content: "Dibs claim released.",
				flags: MessageFlags.Ephemeral,
			});
		} else {
			await interaction.reply({
				content: json.error || "Unable to release dibs.",
				flags: MessageFlags.Ephemeral,
			});
		}
	} catch (err) {
		logger.error("Error releasing dibs via Discord button:", err);
		await interaction
			.reply({
				content: "Internal error releasing claim. Please try again.",
				flags: MessageFlags.Ephemeral,
			})
			.catch(() => {});
	}
}
