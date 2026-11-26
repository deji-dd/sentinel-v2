import {
	allianceApiKeys,
	and,
	db,
	eq,
	getAllianceGuildId,
	guildConfigs,
	isNull,
	or,
} from "@sentinel/database";
import {
	clearAllianceKeyPoolCache,
	encryptApiKey,
	hashApiKey,
	PublicKeyRequiredError,
	verifyPublicApiKey,
} from "@sentinel/torn-api";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type Client,
	EmbedBuilder,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	type ModalSubmitInteraction,
	TextChannel,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";

import { createErrorEmbed, createSuccessEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

export const ALLIANCE_DONATION_EMBED_TITLE = "API Key Donation";
const DONATE_BUTTON_ID = "alliance_donate_key_button";
const DONATE_MODAL_ID = "alliance_donate_key_modal";

/**
 * Builds the persistent Alliance key-donation embed and its action button.
 */
export function buildAllianceKeyDonationEmbed(): {
	embed: EmbedBuilder;
	row: ActionRowBuilder<ButtonBuilder>;
} {
	const embed = new EmbedBuilder()
		.setTitle(ALLIANCE_DONATION_EMBED_TITLE)
		.setDescription(
			`Help power Alliance features

**What we ask of your key**
• Public Only access — any other level is rejected
• Encrypted, never published, and stored until you revoke it on Torn

**How it works:** Click **Donate API Key** and paste your 16-character key in the private form. Only the bot sees it; it is never posted in chat. Repeat donors simply replace their existing key.`,
		)
		.setColor(EMBED_COLORS.PRIMARY)
		.setFooter({
			text: "Sentinel",
		})
		.setTimestamp(new Date());

	const donateBtn = new ButtonBuilder()
		.setCustomId(DONATE_BUTTON_ID)
		.setLabel("Donate API Key")
		.setStyle(ButtonStyle.Primary);

	return {
		embed,
		row: new ActionRowBuilder<ButtonBuilder>().addComponents(donateBtn),
	};
}

let isUpdatingDonationChannel = false;
let pendingDonationUpdate = false;

/** Updates or creates the persistent donation embed in the Alliance guild. */
export async function updateAllianceKeyDonationChannel(
	client: Client,
	guildId?: string,
): Promise<void> {
	if (isUpdatingDonationChannel) {
		pendingDonationUpdate = true;
		return;
	}
	isUpdatingDonationChannel = true;
	try {
		do {
			pendingDonationUpdate = false;
			await performDonationChannelUpdate(client, guildId);
		} while (pendingDonationUpdate);
	} finally {
		isUpdatingDonationChannel = false;
	}
}

async function performDonationChannelUpdate(
	client: Client,
	guildId?: string,
): Promise<void> {
	try {
		const allianceGuildId = getAllianceGuildId();
		if (!allianceGuildId) return;
		if (guildId && guildId !== allianceGuildId) return;

		const [config] = await db
			.select()
			.from(guildConfigs)
			.where(eq(guildConfigs.guildId, allianceGuildId));

		if (!config?.keyDonationChannelId) return;

		const channel = await client.channels
			.fetch(config.keyDonationChannelId)
			.catch(() => null);
		if (!channel || !(channel instanceof TextChannel)) return;

		const { embed, row } = buildAllianceKeyDonationEmbed();
		const recentMessages = await channel.messages
			.fetch({ limit: 50 })
			.catch(() => null);
		const botDonationMessages = recentMessages
			? Array.from(recentMessages.values()).filter(
					(m) =>
						m.author.id === client.user?.id &&
						m.embeds.some((e) =>
							e.title?.includes(ALLIANCE_DONATION_EMBED_TITLE),
						),
				)
			: [];

		const targetMessage = config.keyDonationEmbedMessageId
			? (botDonationMessages.find(
					(m) => m.id === config.keyDonationEmbedMessageId,
				) ??
				(await channel.messages
					.fetch(config.keyDonationEmbedMessageId)
					.catch(() => null)))
			: (botDonationMessages[0] ?? null);

		for (const msg of botDonationMessages) {
			if (targetMessage && msg.id !== targetMessage.id) {
				await msg.delete().catch(() => {});
			}
		}

		let activeMessageId = targetMessage?.id;
		if (targetMessage) {
			await targetMessage.edit({ embeds: [embed], components: [row] });
		} else {
			const sent = await channel.send({ embeds: [embed], components: [row] });
			activeMessageId = sent.id;
		}

		if (
			activeMessageId &&
			activeMessageId !== config.keyDonationEmbedMessageId
		) {
			await db
				.update(guildConfigs)
				.set({
					keyDonationEmbedMessageId: activeMessageId,
					updatedAt: new Date(),
				})
				.where(eq(guildConfigs.guildId, allianceGuildId));
		}
	} catch (err) {
		logger.error("Error updating Alliance key donation channel:", err);
	}
}

/** Presents the secure key-entry modal. */
export async function handleAllianceKeyDonationButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const modal = new ModalBuilder()
			.setCustomId(DONATE_MODAL_ID)
			.setTitle("Donate Public Torn API Key");

		const keyInput = new TextInputBuilder()
			.setCustomId("torn_api_key")
			.setStyle(TextInputStyle.Short)
			.setPlaceholder("16-character Public Only Torn API key")
			.setMinLength(16)
			.setMaxLength(16)
			.setRequired(true);

		modal.addLabelComponents(
			new LabelBuilder()
				.setLabel("Torn API Key (16 Characters)")
				.setTextInputComponent(keyInput),
		);

		await interaction.showModal(modal);
	} catch (err) {
		logger.error("Error showing Alliance key donation modal:", err);
		if (interaction.isRepliable()) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Form Error",
						"Failed to open the key donation form. Please try again.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}

/** Validates, verifies and stores a donated Alliance key. */
export async function handleAllianceKeyDonationModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	try {
		const rawKey = interaction.fields.getTextInputValue("torn_api_key").trim();
		const guildId = getAllianceGuildId();
		if (!guildId) {
			await interaction.followUp({
				embeds: [
					createErrorEmbed(
						"Server Unconfigured",
						"The Alliance server is not configured.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Live verification rejects non-public keys before anything is persisted.
		let verified;
		try {
			verified = await verifyPublicApiKey(rawKey);
		} catch (err) {
			const message =
				err instanceof PublicKeyRequiredError
					? err.message
					: err instanceof Error
						? err.message
						: "Torn API verification failed.";
			await interaction.followUp({
				embeds: [createErrorEmbed("Key Not Accepted", message)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const keyHash = hashApiKey(rawKey, process.env.API_KEY_HASH_PEPPER ?? "");

		const [sameKey] = await db
			.select({ donatedByDiscordId: allianceApiKeys.donatedByDiscordId })
			.from(allianceApiKeys)
			.where(eq(allianceApiKeys.apiKeyHash, keyHash));

		if (
			sameKey &&
			(sameKey.donatedByDiscordId === null ||
				sameKey.donatedByDiscordId !== interaction.user.id)
		) {
			await interaction.followUp({
				embeds: [
					createErrorEmbed(
						"Already Registered",
						"This key is already in the Alliance key pool.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const [samePlayer] = await db
			.select({ donatedByDiscordId: allianceApiKeys.donatedByDiscordId })
			.from(allianceApiKeys)
			.where(eq(allianceApiKeys.tornId, verified.tornId));

		if (
			samePlayer?.donatedByDiscordId &&
			samePlayer.donatedByDiscordId !== interaction.user.id
		) {
			await interaction.followUp({
				embeds: [
					createErrorEmbed(
						"Already Registered",
						`A key for **${verified.tornName} [${verified.tornId}]** is already in the Alliance key pool.`,
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const encrypted = encryptApiKey(rawKey, process.env.ENCRYPTION_KEY ?? "");
		const existingForDonor = await db
			.select({ id: allianceApiKeys.id })
			.from(allianceApiKeys)
			.where(
				and(
					or(
						isNull(allianceApiKeys.guildId),
						eq(allianceApiKeys.guildId, guildId),
					),
					or(
						eq(allianceApiKeys.donatedByDiscordId, interaction.user.id),
						eq(allianceApiKeys.tornId, verified.tornId),
					),
				),
			);

		const [primary, ...redundant] = existingForDonor;
		if (primary) {
			await db
				.update(allianceApiKeys)
				.set({
					guildId,
					tornId: verified.tornId,
					tornName: verified.tornName,
					apiKeyEncrypted: encrypted,
					apiKeyHash: keyHash,
					isValid: true,
					invalidCount: 0,
					donatedByDiscordId: interaction.user.id,
					donatedByDiscordTag:
						interaction.user.tag || interaction.user.username,
					updatedAt: new Date(),
				})
				.where(eq(allianceApiKeys.id, primary.id));
			for (const row of redundant) {
				await db.delete(allianceApiKeys).where(eq(allianceApiKeys.id, row.id));
			}
		} else {
			await db.insert(allianceApiKeys).values({
				guildId,
				tornId: verified.tornId,
				tornName: verified.tornName,
				apiKeyEncrypted: encrypted,
				apiKeyHash: keyHash,
				isValid: true,
				invalidCount: 0,
				donatedByDiscordId: interaction.user.id,
				donatedByDiscordTag: interaction.user.tag || interaction.user.username,
			});
		}
		clearAllianceKeyPoolCache();

		logger.info(
			`Public Torn API key ${primary ? "updated" : "donated"} for ${verified.tornName} [${verified.tornId}] by ${interaction.user.tag} (${interaction.user.id}) in Alliance guild ${guildId}`,
		);

		await interaction.followUp({
			embeds: [
				createSuccessEmbed(
					primary ? "API Key Updated" : "API Key Donated",
					`Thank you, <@${interaction.user.id}>! Your **Public Only** key for **${verified.tornName} [${verified.tornId}]** is now in the Alliance key pool.`,
				),
			],
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		logger.error("Error processing Alliance key donation:", err);
		await interaction.followUp({
			embeds: [
				createErrorEmbed(
					"Processing Error",
					"An unexpected error occurred while saving your key. Please try again.",
				),
			],
			flags: MessageFlags.Ephemeral,
		});
	}
}
