import {
	db,
	type ElimsItemRequestConfig,
	elimsArmoryDeposits,
	eq,
	getArmoryStock,
	type ItemStock,
	systemStates,
} from "@sentinel/database";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type Client,
	EmbedBuilder,
	type Message,
	MessageFlags,
	ModalBuilder,
	type ModalSubmitInteraction,
	StringSelectMenuBuilder,
	type StringSelectMenuInteraction,
	TextChannel,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { resolveElimsUser } from "./elims-item-requests";
import {
	createBaseEmbed,
	createErrorEmbed,
	createSuccessEmbed,
	EMBED_COLORS,
} from "./embeds";
import { logger } from "./logger";
import { parseDepositLogs } from "./torn-log-parser";

const ELIMS_ITEM_REQUESTS_CONFIG_ID = "elims:item_requests_config";

export { getArmoryStock, type ItemStock };

/**
 * Builds the persistent storage channel embed showing armory instructions and live item stock.
 */
export async function buildArmoryStorageEmbed(): Promise<{
	embed: EmbedBuilder;
	row: ActionRowBuilder<ButtonBuilder>;
}> {
	const embed = new EmbedBuilder()
		.setTitle("Item Deposits")
		.setDescription(
			`**How to Deposit:**
1. Copy your Torn event log(s) (e.g. \`You were sent 16x Serotonin from [User](...)\`)
2. Click **Log Deposit** below to paste.

💬 **Large Logs:** If your log is too long for the popup, simply **paste it directly into this channel chat**! Sentinel will automatically record all item deposits and delete your message immediately to keep the channel clean.`,
		)
		.setColor(EMBED_COLORS.PRIMARY);

	embed.setFooter({
		text: "Sentinel",
	});
	embed.setTimestamp(new Date());

	const logDepositBtn = new ButtonBuilder()
		.setCustomId("elims_armory_log_deposit")
		.setLabel("Log Deposit")
		.setStyle(ButtonStyle.Primary);

	const testDepositBtn = new ButtonBuilder()
		.setCustomId("elims_armory_test_deposit")
		.setLabel("[TEST] Deposit Test Items")
		.setStyle(ButtonStyle.Secondary);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		logDepositBtn,
		testDepositBtn,
	);

	return { embed, row };
}

let isUpdatingArmoryChannel = false;
let pendingArmoryUpdate = false;

/**
 * Updates or posts the persistent armory storage embed in the configured storageChannelId.
 * Cleans up any duplicate embeds from the bot to keep the channel completely clean.
 */
export async function updateElimsArmoryStorageChannel(
	client: Client,
	guildId?: string,
): Promise<void> {
	if (isUpdatingArmoryChannel) {
		pendingArmoryUpdate = true;
		return;
	}
	isUpdatingArmoryChannel = true;
	try {
		do {
			pendingArmoryUpdate = false;
			await performArmoryStorageChannelUpdate(client, guildId);
		} while (pendingArmoryUpdate);
	} finally {
		isUpdatingArmoryChannel = false;
	}
}

async function performArmoryStorageChannelUpdate(
	client: Client,
	guildId?: string,
): Promise<void> {
	try {
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));

		const config = state?.data as unknown as ElimsItemRequestConfig | undefined;
		if (!config?.storageChannelId) return;

		const targetGuildId = guildId ?? client.guilds.cache.first()?.id;
		if (!targetGuildId) return;

		const channel = await client.channels
			.fetch(config.storageChannelId)
			.catch(() => null);

		if (!channel || !(channel instanceof TextChannel)) return;

		const { embed, row } = await buildArmoryStorageEmbed();

		// Find any existing Armory embed messages from the bot in this channel
		const recentMessages = await channel.messages
			.fetch({ limit: 50 })
			.catch(() => null);

		const botArmoryMessages = recentMessages
			? Array.from(recentMessages.values()).filter(
					(m) =>
						m.author.id === client.user?.id &&
						m.embeds.some(
							(e) =>
								e.title?.includes("Item Deposits") ||
								e.title?.includes("Armory") ||
								e.title?.includes("Supply Depot"),
						),
				)
			: [];

		// Target message: config.storageEmbedMessageId if found, else newest message in channel
		const targetMessage = config.storageEmbedMessageId
			? (botArmoryMessages.find((m) => m.id === config.storageEmbedMessageId) ??
				(await channel.messages
					.fetch(config.storageEmbedMessageId)
					.catch(() => null)))
			: (botArmoryMessages[0] ?? null);

		// Clean up any extra duplicate embeds in the channel to prevent flooding/pollution
		for (const msg of botArmoryMessages) {
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

		// Save message ID to config if new or changed
		if (activeMessageId && activeMessageId !== config.storageEmbedMessageId) {
			const updatedConfig: ElimsItemRequestConfig = {
				...config,
				storageEmbedMessageId: activeMessageId,
				updatedAt: new Date().toISOString(),
			};

			await db
				.insert(systemStates)
				.values({
					id: ELIMS_ITEM_REQUESTS_CONFIG_ID,
					init: true,
					data: updatedConfig as unknown as Record<string, unknown>,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						data: updatedConfig as unknown as Record<string, unknown>,
						updatedAt: new Date(),
					},
				});
		}
	} catch (err) {
		logger.error("Error updating elims armory storage channel:", err);
	}
}

/**
 * Handles clicking the "Log Deposit (Paste Log)" button.
 */
export async function handleArmoryLogDepositButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = state?.data as unknown as ElimsItemRequestConfig | undefined;

		// Check Blacklist
		if (config?.blacklistedUserIds?.includes(interaction.user.id)) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Access Denied",
						"You have been blacklisted from interacting with the tournament armory.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const modal = new ModalBuilder()
			.setCustomId("elims_armory_log_modal")
			.setTitle("Armory — Log Deposit");

		const logInput = new TextInputBuilder()
			.setCustomId("deposit_log_text")
			.setLabel("Torn Event Log(s)")
			.setStyle(TextInputStyle.Paragraph)
			.setPlaceholder(
				"Paste Torn event log(s) here, e.g.:\nYou were sent 16x Serotonin from [User](...)",
			)
			.setRequired(true)
			.setMaxLength(4000);

		const row = new ActionRowBuilder<TextInputBuilder>().addComponents(
			logInput,
		);
		modal.addComponents(row);

		await interaction.showModal(modal);
	} catch (err) {
		logger.error("Error in handleArmoryLogDepositButton:", err);
	}
}

/**
 * Handles submission of the Log Deposit modal.
 */
export async function handleArmoryLogModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	try {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = state?.data as unknown as ElimsItemRequestConfig | undefined;

		if (config?.blacklistedUserIds?.includes(interaction.user.id)) {
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						"Access Denied",
						"You are blacklisted from depositing items.",
					),
				],
			});
			return;
		}

		const logText = interaction.fields.getTextInputValue("deposit_log_text");
		const parsedLogs = parseDepositLogs(logText);

		if (parsedLogs.length === 0) {
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						"Unable to Parse Deposit Log",
						`Could not parse any valid item transfer logs from your input.

💬 **Is your log too long?**
Discord modal popups have a strict character limit. If your log is very long or got cut off, **send it directly into this channel chat instead**! Sentinel will automatically read it, record the deposits, and delete your message to keep the channel clean.

**Accepted formats:**
• \`You were sent 16x Serotonin from [User](...)\`
• \`00:50:02 - 06/09/26 User sent 16x Serotonin to you\`
• \`You were sent a Brick from [User](...) with the message: ...\``,
					),
				],
			});
			return;
		}

		const guildId = interaction.guildId ?? "";
		const insertedItems: Array<{
			name: string;
			quantity: number;
			donor: string;
		}> = [];

		for (const parsed of parsedLogs) {
			const matchedItem = config?.allowedItems.find(
				(i) =>
					i.name.trim().toLowerCase() === parsed.itemName.trim().toLowerCase(),
			);

			await db.insert(elimsArmoryDeposits).values({
				guildId,
				discordUserId: interaction.user.id,
				discordUsername: interaction.user.username,
				tornName: parsed.donorName,
				tornId: parsed.donorTornId,
				itemId: matchedItem?.id ?? "external",
				itemName: matchedItem?.name ?? parsed.itemName,
				itemCategory: matchedItem?.category ?? "General",
				quantity: parsed.quantity,
				rawLog: parsed.rawLog,
				isTest: false,
				status: "available",
			});

			insertedItems.push({
				name: matchedItem?.name ?? parsed.itemName,
				quantity: parsed.quantity,
				donor: parsed.donorName,
			});
		}

		// Refresh persistent storage embed
		if (config && interaction.client) {
			void updateElimsArmoryStorageChannel(interaction.client, guildId);
		}

		// Ephemeral review confirmation
		const reviewLines = insertedItems.map(
			(item) =>
				`• **${item.quantity.toLocaleString()}x** ${item.name} from **${item.donor}**`,
		);

		const limitNotice =
			logText.length >= 3950
				? "\n\n⚠️ **Note:** Your input reached the 4,000 character limit. If any logs were cut off, you can send the remaining logs directly in this channel chat!"
				: "";

		const successEmbed = createSuccessEmbed(
			"Deposit Logged Successfully",
			`Successfully processed and added **${insertedItems.length}** deposit record(s) to the armory stockpile:\n\n${reviewLines.join("\n")}${limitNotice}`,
		);

		await interaction.editReply({ embeds: [successEmbed] });
	} catch (err) {
		logger.error("Error in handleArmoryLogModalSubmit:", err);
		if (interaction.deferred || interaction.replied) {
			await interaction
				.editReply({
					embeds: [
						createErrorEmbed(
							"Deposit Failed",
							"An error occurred while processing your deposit log.",
						),
					],
				})
				.catch(() => {});
		}
	}
}

/**
 * Handles clicking "[TEST] Deposit Test Items".
 */
export async function handleArmoryTestDepositButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = state?.data as unknown as ElimsItemRequestConfig | undefined;

		if (config?.blacklistedUserIds?.includes(interaction.user.id)) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Access Denied",
						"You are blacklisted from armory interactions.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (!config || config.allowedItems.length === 0) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"No Items Whitelisted",
						"No items have been whitelisted yet to simulate test deposits.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Follow the flow of item request: Category first then item
		const categories = Array.from(
			new Set(config.allowedItems.map((i) => i.category || "General")),
		).slice(0, 25);

		const selectMenu = new StringSelectMenuBuilder()
			.setCustomId("elims_armory_test_category_select")
			.setPlaceholder("Select an item category...")
			.addOptions(
				categories.map((cat) => ({
					label: cat,
					value: cat,
					description: `Browse items in ${cat}`,
				})),
			);

		const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
			selectMenu,
		);

		const categoryEmbed = createBaseEmbed(
			"Item Deposits — Select Category",
			"Select the category of items you would like to deposit into **Test Stock** from the dropdown below:",
			EMBED_COLORS.PRIMARY,
		);

		await interaction.reply({
			embeds: [categoryEmbed],
			components: [row],
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		logger.error("Error in handleArmoryTestDepositButton:", err);
	}
}

/**
 * Handles Category StringSelectMenu selection for test deposits -> updates ephemeral view with items in that category.
 */
export async function handleArmoryTestCategorySelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	try {
		const selectedCategory = interaction.values[0];
		if (!selectedCategory) return;

		const [reqState] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = reqState?.data as unknown as ElimsItemRequestConfig | null;

		if (!config) return;

		const itemsInCategory = config.allowedItems
			.filter((i) => (i.category || "General") === selectedCategory)
			.slice(0, 25);

		if (itemsInCategory.length === 0) {
			const embed = createErrorEmbed(
				"No Items Found",
				`No whitelisted items found in ${selectedCategory}.`,
			);
			await interaction.update({
				embeds: [embed],
				components: [],
			});
			return;
		}

		const selectMenu = new StringSelectMenuBuilder()
			.setCustomId("elims_armory_test_item_select")
			.setPlaceholder(`Select an item from ${selectedCategory}...`)
			.addOptions(
				itemsInCategory.map((it) => ({
					label: it.name.slice(0, 100),
					value: it.id,
					description: it.marketPrice
						? `Market Price: $${it.marketPrice.toLocaleString()}`
						: undefined,
				})),
			);

		const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
			selectMenu,
		);

		const itemSelectEmbed = createBaseEmbed(
			`Item Deposits — ${selectedCategory}`,
			`Select the specific item you want to deposit into **Test Stock** from **${selectedCategory}** below:`,
			EMBED_COLORS.PRIMARY,
		);

		await interaction.update({
			embeds: [itemSelectEmbed],
			components: [row],
		});
	} catch (err) {
		logger.error("Error in handleArmoryTestCategorySelect:", err);
		const errorEmbed = createErrorEmbed(
			"Category Selection Error",
			"An error occurred while loading items for this category.",
		);
		await interaction
			.update({
				embeds: [errorEmbed],
				components: [],
			})
			.catch(() => {});
	}
}

/**
 * Handles selecting an item from the Test Deposit dropdown, opening the quantity modal.
 */
export async function handleArmoryTestItemSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	try {
		const itemId = interaction.values[0];
		if (!itemId) return;

		const modal = new ModalBuilder()
			.setCustomId(`elims_armory_test_qty_modal:${itemId}`)
			.setTitle("[TEST] Deposit Quantity");

		const qtyInput = new TextInputBuilder()
			.setCustomId("test_quantity")
			.setLabel("Test Quantity to Deposit")
			.setStyle(TextInputStyle.Short)
			.setPlaceholder("e.g. 50")
			.setRequired(true)
			.setMaxLength(6);

		const row = new ActionRowBuilder<TextInputBuilder>().addComponents(
			qtyInput,
		);
		modal.addComponents(row);

		await interaction.showModal(modal);
	} catch (err) {
		logger.error("Error in handleArmoryTestItemSelect:", err);
	}
}

/**
 * Handles submission of the Test Deposit quantity modal.
 */
export async function handleArmoryTestQtyModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	try {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const itemId = interaction.customId.split(":")[1];
		const qtyStr = interaction.fields.getTextInputValue("test_quantity").trim();
		const quantity = Number.parseInt(qtyStr, 10);

		if (Number.isNaN(quantity) || quantity <= 0) {
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						"Invalid Quantity",
						"Please provide a positive whole number for test deposit.",
					),
				],
			});
			return;
		}

		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = state?.data as unknown as ElimsItemRequestConfig | undefined;
		const item = config?.allowedItems.find((i) => i.id === itemId);

		if (!item) {
			await interaction.editReply({
				embeds: [
					createErrorEmbed("Item Not Found", "Selected item was not found."),
				],
			});
			return;
		}

		const guildId = interaction.guildId ?? "";
		const resolvedUser = await resolveElimsUser(interaction.user.id, guildId);

		const tornName =
			resolvedUser?.tornName ??
			interaction.user.displayName ??
			interaction.user.username;
		const tornId = resolvedUser?.tornId ?? null;

		await db.insert(elimsArmoryDeposits).values({
			guildId,
			discordUserId: interaction.user.id,
			discordUsername: interaction.user.username,
			tornName,
			tornId,
			itemId: item.id,
			itemName: item.name,
			itemCategory: item.category || "General",
			quantity,
			rawLog: `[TEST DEPOSIT] Simulated by ${tornName}${tornId ? ` [${tornId}]` : ""} (${quantity}x ${item.name})`,
			isTest: true,
			status: "available",
		});

		if (config && interaction.client) {
			void updateElimsArmoryStorageChannel(interaction.client, guildId);
		}

		const successEmbed = createSuccessEmbed(
			"[TEST] Deposit Recorded",
			`Added **${quantity.toLocaleString()}x ${item.name}** into **Test Storage**.`,
		);

		await interaction.editReply({ embeds: [successEmbed] });
	} catch (err) {
		logger.error("Error in handleArmoryTestQtyModalSubmit:", err);
		if (interaction.deferred || interaction.replied) {
			await interaction
				.editReply({
					embeds: [
						createErrorEmbed(
							"Test Deposit Failed",
							"An error occurred while processing your test deposit.",
						),
					],
				})
				.catch(() => {});
		}
	}
}

/**
 * Handles incoming chat messages in the armory storage channel.
 * If a user sends event logs in chat (especially useful for large logs exceeding modal limits),
 * Sentinel parses the deposits, inserts them into the database, updates the storage embed,
 * deletes the user's message to keep the channel clean, and posts a self-deleting confirmation.
 */
export async function handleArmoryStorageChatMessage(
	message: Message,
): Promise<void> {
	if (message.author.bot || !message.guildId) return;
	if (!message.channel.isSendable()) return;

	try {
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = state?.data as unknown as ElimsItemRequestConfig | undefined;

		if (
			!config?.storageChannelId ||
			message.channelId !== config.storageChannelId
		) {
			return;
		}

		// Check if user is blacklisted
		if (config.blacklistedUserIds?.includes(message.author.id)) {
			await message.delete().catch(() => {});
			const reply = await message.channel
				.send({
					embeds: [
						createErrorEmbed(
							"Access Denied",
							`<@${message.author.id}>, you are blacklisted from depositing items.`,
						),
					],
				})
				.catch(() => null);
			if (reply) {
				setTimeout(() => {
					reply.delete().catch(() => {});
				}, 8000);
			}
			return;
		}

		const parsedLogs = parseDepositLogs(message.content);

		if (parsedLogs.length === 0) {
			const lower = message.content.toLowerCase();
			if (
				lower.includes("sent") ||
				lower.includes("you were sent") ||
				lower.includes("to you")
			) {
				await message.delete().catch(() => {});
				const reply = await message.channel
					.send({
						embeds: [
							createErrorEmbed(
								"Unable to Parse Deposit Log",
								`<@${message.author.id}>, could not parse any valid item transfer logs from your message.

**Accepted formats:**
• \`You were sent 16x Serotonin from [User](...)\`
• \`00:50:02 - 06/09/26 User sent 16x Serotonin to you\`
• \`You were sent a Brick from [User](...) with the message: ...\``,
							),
						],
					})
					.catch(() => null);
				if (reply) {
					setTimeout(() => {
						reply.delete().catch(() => {});
					}, 10000);
				}
			}
			return;
		}

		// Valid deposits detected: delete the user's message immediately to keep the channel clean
		await message.delete().catch(() => {});

		const guildId = message.guildId;
		const insertedItems: Array<{
			name: string;
			quantity: number;
			donor: string;
		}> = [];

		for (const parsed of parsedLogs) {
			const matchedItem = config.allowedItems.find(
				(i) =>
					i.name.trim().toLowerCase() === parsed.itemName.trim().toLowerCase(),
			);

			await db.insert(elimsArmoryDeposits).values({
				guildId,
				discordUserId: message.author.id,
				discordUsername: message.author.username,
				tornName: parsed.donorName,
				tornId: parsed.donorTornId,
				itemId: matchedItem?.id ?? "external",
				itemName: matchedItem?.name ?? parsed.itemName,
				itemCategory: matchedItem?.category ?? "General",
				quantity: parsed.quantity,
				rawLog: parsed.rawLog,
				isTest: false,
				status: "available",
			});

			insertedItems.push({
				name: matchedItem?.name ?? parsed.itemName,
				quantity: parsed.quantity,
				donor: parsed.donorName,
			});
		}

		// Update the persistent storage embed
		if (message.client) {
			void updateElimsArmoryStorageChannel(message.client, guildId);
		}

		// Post a temporary self-deleting confirmation embed
		const reviewLines = insertedItems.map(
			(item) =>
				`• **${item.quantity.toLocaleString()}x** ${item.name} from **${item.donor}**`,
		);

		const extraCount = reviewLines.length - 15;
		const extraNotice =
			extraCount > 0 ? `\n*...and ${extraCount} more item(s)*` : "";

		const reply = await message.channel
			.send({
				embeds: [
					createSuccessEmbed(
						"Deposits Recorded via Chat",
						`Successfully logged **${insertedItems.length}** item transfer(s) from <@${message.author.id}>:

${reviewLines.slice(0, 15).join("\n")}${extraNotice}`,
					),
				],
			})
			.catch(() => null);

		if (reply) {
			setTimeout(() => {
				reply.delete().catch(() => {});
			}, 10000);
		}
	} catch (err) {
		logger.error("Error in handleArmoryStorageChatMessage:", err);
	}
}
