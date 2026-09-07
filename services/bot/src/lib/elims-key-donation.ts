import {
	and,
	db,
	elimsApiKeys,
	eq,
	or,
	systemStates,
} from "@sentinel/database";
import { encryptApiKey, hashApiKey, isValidApiKey } from "@sentinel/torn-api";
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
import { sendElimsKeyVerificationRequest } from "./ipc/server";
import { logger } from "./logger";

const ELIMS_CONFIG_ID = "elims:guild_config";

interface ElimsGuildConfigState {
	guildId: string;
	guildName: string;
	guildIcon: string | null;
	adminRoleIds: string[];
	keyDonationChannelId?: string | null;
	keyDonationEmbedMessageId?: string | null;
	configuredAt: string;
	configuredBy: {
		discordId: string;
		username: string;
	};
	updatedAt: string;
}

/**
 * Builds the persistent key donation embed and action button.
 */
export function buildKeyDonationEmbed(): {
	embed: EmbedBuilder;
	row: ActionRowBuilder<ButtonBuilder>;
} {
	const embed = new EmbedBuilder()
		.setTitle("Torn API Key Contribution")
		.setDescription(
			`Help empower our elimination team! Donating your Torn API key helps us better track competition stats.

**Security & Privacy Guarantee:**
• Keys are securely encrypted before storage.
• Only calls relating to eliminations will be made.
• Required key type: Public.
• You can pause, reset, or revoke your key on Torn at any time.

Click **Donate API Key** below to submit your key in complete privacy via a secure form.`,
		)
		.setColor(EMBED_COLORS.PRIMARY)
		.setFooter({
			text: "Sentinel • For Science!",
		})
		.setTimestamp(new Date());

	const donateBtn = new ButtonBuilder()
		.setCustomId("elims_donate_key_button")
		.setLabel("Donate API Key")
		.setStyle(ButtonStyle.Primary);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(donateBtn);

	return { embed, row };
}

let isUpdatingKeyDonationChannel = false;
let pendingKeyDonationUpdate = false;

/**
 * Updates or creates the persistent key donation embed in the configured channel.
 */
export async function updateElimsKeyDonationChannel(
	client: Client,
	guildId?: string,
): Promise<void> {
	if (isUpdatingKeyDonationChannel) {
		pendingKeyDonationUpdate = true;
		return;
	}
	isUpdatingKeyDonationChannel = true;
	try {
		do {
			pendingKeyDonationUpdate = false;
			await performKeyDonationChannelUpdate(client, guildId);
		} while (pendingKeyDonationUpdate);
	} finally {
		isUpdatingKeyDonationChannel = false;
	}
}

async function performKeyDonationChannelUpdate(
	client: Client,
	guildId?: string,
): Promise<void> {
	try {
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_CONFIG_ID));

		const config = state?.data as unknown as ElimsGuildConfigState | undefined;
		if (!config?.guildId) return;

		const targetGuildId = guildId ?? config.guildId;
		if (targetGuildId !== config.guildId) return;

		// If no channel is configured, clean up existing embed if found
		if (!config.keyDonationChannelId) {
			return;
		}

		const channel = await client.channels
			.fetch(config.keyDonationChannelId)
			.catch(() => null);

		if (!channel || !(channel instanceof TextChannel)) return;

		const { embed, row } = buildKeyDonationEmbed();

		// Fetch recent messages to look for bot's existing key donation embed
		const recentMessages = await channel.messages
			.fetch({ limit: 50 })
			.catch(() => null);

		const botDonationMessages = recentMessages
			? Array.from(recentMessages.values()).filter(
					(m) =>
						m.author.id === client.user?.id &&
						m.embeds.some(
							(e) =>
								e.title?.includes("Torn API Key Contribution") ||
								e.title?.includes("Key Contribution") ||
								e.title?.includes("API Key Pool"),
						),
				)
			: [];

		// Determine target message
		const targetMessage = config.keyDonationEmbedMessageId
			? (botDonationMessages.find(
					(m) => m.id === config.keyDonationEmbedMessageId,
				) ??
				(await channel.messages
					.fetch(config.keyDonationEmbedMessageId)
					.catch(() => null)))
			: (botDonationMessages[0] ?? null);

		// Clean up duplicate embeds in the channel
		for (const msg of botDonationMessages) {
			if (targetMessage && msg.id !== targetMessage.id) {
				await msg.delete().catch(() => {});
			}
		}

		let activeMessageId = targetMessage?.id;

		if (targetMessage) {
			await targetMessage.edit({
				embeds: [embed],
				components: [row],
			});
		} else {
			const sent = await channel.send({
				embeds: [embed],
				components: [row],
			});
			activeMessageId = sent.id;
		}

		// Update message ID in config if newly assigned or changed
		if (
			activeMessageId &&
			activeMessageId !== config.keyDonationEmbedMessageId
		) {
			const updatedConfig: ElimsGuildConfigState = {
				...config,
				keyDonationEmbedMessageId: activeMessageId,
				updatedAt: new Date().toISOString(),
			};

			await db
				.update(systemStates)
				.set({
					data: updatedConfig as unknown as Record<string, unknown>,
					updatedAt: new Date(),
				})
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));
		}
	} catch (err) {
		logger.error("Error updating elims key donation channel:", err);
	}
}

/**
 * Handles user clicking the "Donate API Key" button by presenting a secure modal.
 */
export async function handleKeyDonationButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const modal = new ModalBuilder()
			.setCustomId("elims_donate_key_modal")
			.setTitle("Donate Torn API Key");

		const keyInput = new TextInputBuilder()
			.setCustomId("torn_api_key")
			.setStyle(TextInputStyle.Short)
			.setPlaceholder("Enter your 16-character Torn API key")
			.setMinLength(16)
			.setMaxLength(16)
			.setRequired(true);

		const label = new LabelBuilder()
			.setLabel("Torn API Key (16 Characters)")
			.setTextInputComponent(keyInput);

		modal.addLabelComponents(label);

		await interaction.showModal(modal);
	} catch (err) {
		logger.error("Error showing key donation modal:", err);
		if (interaction.isRepliable()) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Form Error",
						"Failed to open key donation form. Please try again.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}

/**
 * Handles submission of the key donation modal:
 * Validates, checks duplicates, verifies with Torn API, encrypts with AES-256-GCM, and persists to elimsApiKeys.
 * If the user already has an API key registered for this guild, replaces the existing key instead of creating a duplicate.
 */
export async function handleKeyDonationModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	try {
		const rawKey = interaction.fields.getTextInputValue("torn_api_key").trim();

		// 1. Format validation
		if (!isValidApiKey(rawKey)) {
			await interaction.followUp({
				embeds: [
					createErrorEmbed(
						"Invalid API Key",
						"Torn API keys must be exactly 16 alphanumeric characters.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 2. Fetch guild context
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_CONFIG_ID));
		const config = state?.data as unknown as ElimsGuildConfigState | undefined;
		const targetGuildId = interaction.guildId ?? config?.guildId;

		if (!targetGuildId) {
			await interaction.followUp({
				embeds: [
					createErrorEmbed(
						"Server Unconfigured",
						"Elims tournament guild is not configured.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 3. Validate with Torn API via Scheduler IPC
		let tornUserId: number | null = null;
		let playerName = "Unknown";
		try {
			const verified = await sendElimsKeyVerificationRequest(rawKey);
			tornUserId = verified.tornId;
			playerName = verified.tornName;
		} catch (err) {
			const errorMessage =
				err instanceof Error ? err.message : "Torn API verification failed.";
			await interaction.followUp({
				embeds: [createErrorEmbed("Torn API Verification Error", errorMessage)],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 4. Hash key for duplicate collision checking
		const pepper = process.env.API_KEY_HASH_PEPPER ?? "";
		const keyHash = hashApiKey(rawKey, pepper);

		// Check if this exact key is already registered in this guild by a different user
		const [existingKeyWithSameHash] = await db
			.select()
			.from(elimsApiKeys)
			.where(
				and(
					eq(elimsApiKeys.guildId, targetGuildId),
					eq(elimsApiKeys.apiKeyHash, keyHash),
				),
			);

		if (
			existingKeyWithSameHash?.donatedByDiscordId &&
			existingKeyWithSameHash.donatedByDiscordId !== interaction.user.id
		) {
			await interaction.followUp({
				embeds: [
					createErrorEmbed(
						"Already Registered",
						"This API key has already been registered in this tournament server by another user.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Check if another Discord user already registered a key for this Torn player
		const [keyForSameTornUser] = await db
			.select()
			.from(elimsApiKeys)
			.where(
				and(
					eq(elimsApiKeys.guildId, targetGuildId),
					eq(elimsApiKeys.tornId, tornUserId),
				),
			);

		if (
			keyForSameTornUser?.donatedByDiscordId &&
			keyForSameTornUser.donatedByDiscordId !== interaction.user.id
		) {
			await interaction.followUp({
				embeds: [
					createErrorEmbed(
						"Already Registered",
						`An API key for **${playerName} [${tornUserId}]** has already been registered by another user in this server.`,
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 5. Encrypt key with master encryption key
		const masterKey = process.env.ENCRYPTION_KEY ?? "";
		const keyEncrypted = encryptApiKey(rawKey, masterKey);

		// 6. Guard: Check if the user already has a key in the database for this guild
		// (Matching by either Discord user ID or Torn Player ID)
		const existingUserKeys = await db
			.select()
			.from(elimsApiKeys)
			.where(
				and(
					eq(elimsApiKeys.guildId, targetGuildId),
					or(
						eq(elimsApiKeys.donatedByDiscordId, interaction.user.id),
						eq(elimsApiKeys.tornId, tornUserId),
					),
				),
			);

		let isUpdate = false;
		if (existingUserKeys.length > 0) {
			isUpdate = true;
			const [primaryExistingKey, ...redundantKeys] = existingUserKeys;

			if (primaryExistingKey) {
				await db
					.update(elimsApiKeys)
					.set({
						tornId: tornUserId,
						tornName: playerName,
						apiKeyEncrypted: keyEncrypted,
						apiKeyHash: keyHash,
						isValid: true,
						invalidCount: 0,
						donatedByDiscordId: interaction.user.id,
						donatedByDiscordTag:
							interaction.user.tag || interaction.user.username,
						updatedAt: new Date(),
					})
					.where(eq(elimsApiKeys.id, primaryExistingKey.id));
			}

			// Clean up any extra redundant key rows for this user in this guild to maintain 1 key per user
			for (const redundant of redundantKeys) {
				await db.delete(elimsApiKeys).where(eq(elimsApiKeys.id, redundant.id));
			}

			logger.info(
				`Torn API key for ${playerName} [${tornUserId}] updated by Discord user ${interaction.user.tag} (${interaction.user.id}) in guild ${targetGuildId}`,
			);
		} else {
			// Save new key to database
			await db.insert(elimsApiKeys).values({
				guildId: targetGuildId,
				tornId: tornUserId,
				tornName: playerName,
				apiKeyEncrypted: keyEncrypted,
				apiKeyHash: keyHash,
				isValid: true,
				invalidCount: 0,
				donatedByDiscordId: interaction.user.id,
				donatedByDiscordTag: interaction.user.tag || interaction.user.username,
			});

			logger.info(
				`Torn API key for ${playerName} [${tornUserId}] donated by Discord user ${interaction.user.tag} (${interaction.user.id}) in guild ${targetGuildId}`,
			);
		}

		// 7. Ephemeral confirmation
		const successTitle = isUpdate
			? "API Key Updated Successfully"
			: "API Key Donated Successfully";
		const successMessage = isUpdate
			? `Thank you, <@${interaction.user.id}>! Your existing Torn API key for **${playerName} [${tornUserId}]** has been replaced with your newly donated key.`
			: `Thank you, <@${interaction.user.id}>! Your Torn API key for **${playerName} [${tornUserId}]** has been verified.`;

		const successEmbed = createSuccessEmbed(successTitle, successMessage);

		await interaction.followUp({
			embeds: [successEmbed],
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		logger.error("Error processing key donation modal submit:", err);
		await interaction.followUp({
			embeds: [
				createErrorEmbed(
					"Processing Error",
					"An unexpected error occurred while saving your API key. Please try again.",
				),
			],
			flags: MessageFlags.Ephemeral,
		});
	}
}
