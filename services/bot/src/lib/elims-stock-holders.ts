import {
	assignStockToHolder,
	db,
	deductHolderStock,
	type ElimsItemRequestConfig,
	eq,
	getArmoryStock,
	getStockHolders,
	getUnassignedStock,
	reclaimStockFromHolder,
	type StockHolderAllocation,
	systemStates,
	type WhitelistedItem,
} from "@sentinel/database";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type Client,
	EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	type ModalSubmitInteraction,
	StringSelectMenuBuilder,
	type StringSelectMenuInteraction,
	TextChannel,
	TextInputBuilder,
	TextInputStyle,
	UserSelectMenuBuilder,
	type UserSelectMenuInteraction,
} from "discord.js";
import { resolveTornItem } from "./elims-armory-storage";
import { createErrorEmbed, createSuccessEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

const ELIMS_ITEM_REQUESTS_CONFIG_ID = "elims:item_requests_config";

export {
	assignStockToHolder,
	deductHolderStock,
	getStockHolders,
	getUnassignedStock,
	reclaimStockFromHolder,
	type StockHolderAllocation,
};

let isSyncingStockHolders = false;
let pendingStockHolderSync = false;

/**
 * Checks whether an interacting member has manager or admin permissions.
 */
export function hasManagerPermission(
	interaction:
		| ButtonInteraction
		| UserSelectMenuInteraction
		| StringSelectMenuInteraction
		| ModalSubmitInteraction,
	config: ElimsItemRequestConfig | null | undefined,
): boolean {
	const member = interaction.member;
	if (!member) return false;

	const userRoles =
		"roles" in member && Array.isArray(member.roles)
			? member.roles
			: "roles" in member &&
					member.roles &&
					typeof member.roles === "object" &&
					"cache" in member.roles
				? Array.from((member.roles.cache as Map<string, unknown>).keys())
				: [];

	const isAdmin =
		"permissions" in member &&
		typeof member.permissions === "object" &&
		"has" in member.permissions &&
		(member.permissions as { has: (p: bigint) => boolean }).has(BigInt(0x8));

	const hasManagerRole =
		config?.managerRoleIds && config.managerRoleIds.length > 0
			? config.managerRoleIds.some((rId) => userRoles.includes(rId))
			: true;

	return Boolean(isAdmin || hasManagerRole);
}

/**
 * Builds the embed and action buttons for an individual item in the Stock Holders channel.
 */
export function buildStockHolderItemEmbed(params: {
	item: { id: string; name: string; category?: string; image?: string };
	unassigned: number;
	totalAvailable: number;
	holders: StockHolderAllocation[];
}): {
	embed: EmbedBuilder;
	row: ActionRowBuilder<ButtonBuilder>;
} {
	const { item, unassigned, totalAvailable, holders } = params;

	const embed = new EmbedBuilder()
		.setTitle(`Item — ${item.name}`)
		.setColor(unassigned > 0 ? EMBED_COLORS.SUCCESS : EMBED_COLORS.PRIMARY)
		.addFields(
			{
				name: "Unassigned in Armory",
				value: `**${unassigned.toLocaleString()}**`,
				inline: true,
			},
			{
				name: "Total Active Stock",
				value: `**${totalAvailable.toLocaleString()}**`,
				inline: true,
			},
		);

	if (item.image) {
		embed.setThumbnail(item.image);
	}

	if (holders.length > 0) {
		const MAX_FIELD_LENGTH = 1024;
		const lines: string[] = [];
		let remainingCount = 0;

		for (let i = 0; i < holders.length; i++) {
			const h = holders[i];
			if (!h) continue;
			const line = `• <@${h.discordUserId}> — **${h.quantity.toLocaleString()}x**`;
			const suffix =
				holders.length - (i + 1) > 0
					? `\n*...and ${holders.length - (i + 1)} more*`
					: "";
			const prospective = [...lines, line].join("\n") + suffix;

			if (prospective.length > MAX_FIELD_LENGTH) {
				remainingCount = holders.length - i;
				break;
			}
			lines.push(line);
		}

		if (remainingCount > 0) {
			lines.push(`*...and ${remainingCount} more*`);
		}

		embed.addFields({
			name: `Current Holders (${holders.length})`,
			value: lines.join("\n"),
			inline: false,
		});
	} else {
		embed.addFields({
			name: "Current Holders",
			value: "*No stock holders assigned. Click below to assign.*",
			inline: false,
		});
	}

	embed.setFooter({ text: "Sentinel" }).setTimestamp(new Date());

	const assignBtn = new ButtonBuilder()
		.setCustomId(`elims_holder_assign:${item.id}`)
		.setLabel("Assign to Holder")
		.setStyle(ButtonStyle.Primary)
		.setDisabled(unassigned <= 0);

	const reclaimBtn = new ButtonBuilder()
		.setCustomId(`elims_holder_reclaim:${item.id}`)
		.setLabel("Reclaim Stock")
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(holders.length === 0);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		assignBtn,
		reclaimBtn,
	);

	return { embed, row };
}

/**
 * Synchronizes embeds in the designated Stock Holders channel.
 * Concurrency-guarded to prevent duplicate runs.
 */
export async function syncElimsStockHoldersChannel(
	client: Client,
	guildId?: string,
): Promise<void> {
	if (isSyncingStockHolders) {
		pendingStockHolderSync = true;
		return;
	}

	isSyncingStockHolders = true;
	try {
		do {
			pendingStockHolderSync = false;
			await performStockHoldersChannelSync(client, guildId);
		} while (pendingStockHolderSync);
	} finally {
		isSyncingStockHolders = false;
	}
}

async function performStockHoldersChannelSync(
	client: Client,
	guildId?: string,
): Promise<void> {
	try {
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = state?.data as unknown as ElimsItemRequestConfig | undefined;

		if (!config?.stockHoldersChannelId) return;

		let targetGuildId = guildId;
		if (!targetGuildId) {
			const [guildState] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, "elims:guild_config"));
			const guildData = guildState?.data as { guildId?: string } | undefined;
			targetGuildId = guildData?.guildId ?? client.guilds.cache.first()?.id;
		}
		if (!targetGuildId) return;

		const channel = await client.channels
			.fetch(config.stockHoldersChannelId)
			.catch(() => null);
		if (!channel || !(channel instanceof TextChannel)) return;

		const isTest = false;
		const [stockMap, allHolders] = await Promise.all([
			getArmoryStock(targetGuildId, isTest),
			getStockHolders(targetGuildId, isTest),
		]);

		// Group holders by itemId
		const holdersByItem = new Map<string, StockHolderAllocation[]>();
		for (const h of allHolders) {
			const existing = holdersByItem.get(h.itemId) ?? [];
			existing.push(h);
			holdersByItem.set(h.itemId, existing);
		}

		// Identify all items that either have active stock in armory or active holders
		const activeItemIds = new Set<string>();
		for (const [key, stock] of stockMap.entries()) {
			if (key === "money" || stock.itemName.trim().toLowerCase() === "money") {
				continue;
			}
			if (stock.available > 0) {
				activeItemIds.add(stock.itemId || key);
			}
		}
		for (const h of allHolders) {
			activeItemIds.add(h.itemId);
		}

		// Also include whitelisted items if configured
		const allowedItems: WhitelistedItem[] = config.allowedItems ?? [];
		for (const whitelisted of allowedItems) {
			const stock =
				stockMap.get(whitelisted.id) ??
				stockMap.get(whitelisted.name.trim().toLowerCase());
			const holders = holdersByItem.get(whitelisted.id) ?? [];
			if ((stock && stock.available > 0) || holders.length > 0) {
				activeItemIds.add(whitelisted.id);
			}
		}

		const messageMap: Record<string, string> = {
			...(config.stockHolderMessageIds ?? {}),
		};

		// 1. Delete embeds for items that no longer have any active stock or holders
		for (const [itemId, messageId] of Object.entries(messageMap)) {
			if (!activeItemIds.has(itemId)) {
				const oldMsg = await channel.messages
					.fetch(messageId)
					.catch(() => null);
				if (oldMsg) {
					await oldMsg.delete().catch(() => {});
				}
				delete messageMap[itemId];
			}
		}

		// 2. Post or edit embeds for all active items
		for (const itemId of activeItemIds) {
			const whitelisted = allowedItems.find(
				(i) => i.id.toLowerCase() === itemId.toLowerCase(),
			);
			const itemStock =
				stockMap.get(itemId) ??
				(whitelisted
					? stockMap.get(whitelisted.name.trim().toLowerCase())
					: undefined);
			const itemInfo = await resolveTornItem(
				whitelisted?.name ?? itemStock?.itemName ?? itemId,
				allowedItems,
			);

			const holders = holdersByItem.get(itemId) ?? [];
			const totalAvailable = itemStock?.available ?? 0;
			const totalAllocated = holders.reduce((acc, h) => acc + h.quantity, 0);
			const unassigned = Math.max(0, totalAvailable - totalAllocated);

			const { embed, row } = buildStockHolderItemEmbed({
				item: {
					id: itemId,
					name: whitelisted?.name ?? itemInfo.name,
					category: whitelisted?.category ?? itemInfo.category,
					image: whitelisted?.image,
				},
				unassigned,
				totalAvailable,
				holders,
			});

			const existingMessageId = messageMap[itemId];
			if (existingMessageId) {
				const existingMsg = await channel.messages
					.fetch(existingMessageId)
					.catch(() => null);
				if (existingMsg) {
					await existingMsg
						.edit({
							embeds: [embed],
							components: [row],
						})
						.catch((err) => {
							logger.warn(
								`Failed to edit stock holder embed for ${itemInfo.name}:`,
								err,
							);
						});
					await new Promise((resolve) => setTimeout(resolve, 300));
					continue;
				}
			}

			// Message not found or doesn't exist yet -> send new message
			const sentMsg = await channel
				.send({
					embeds: [embed],
					components: [row],
				})
				.catch((err) => {
					logger.error(
						`Failed to send stock holder embed for ${itemInfo.name}:`,
						err,
					);
					return null;
				});

			if (sentMsg) {
				messageMap[itemId] = sentMsg.id;
			}

			// Stagger delay between sends to prevent rate-limiting on initial seeding
			await new Promise((resolve) => setTimeout(resolve, 300));
		}

		// Save updated message IDs map to config
		const updatedConfig: ElimsItemRequestConfig = {
			...config,
			stockHolderMessageIds: messageMap,
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
	} catch (err) {
		logger.error("Error in performStockHoldersChannelSync:", err);
	}
}

/**
 * Handles clicking "Assign to Holder" on an item embed in the Stock Holders channel.
 * Replies with an ephemeral UserSelectMenu.
 */
export async function handleStockHolderAssignButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = state?.data as unknown as ElimsItemRequestConfig | undefined;

		if (!hasManagerPermission(interaction, config)) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Permission Denied",
						"You do not have permission to assign stock holders.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const itemId = interaction.customId.split(":")[1];
		if (!itemId || !interaction.guildId) return;

		const isTest = false;
		const { unassigned } = await getUnassignedStock(
			interaction.guildId,
			isTest,
			itemId,
		);

		if (unassigned <= 0) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"No Unassigned Stock",
						"There is currently no unassigned armory stock for this item.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const userSelect = new UserSelectMenuBuilder()
			.setCustomId(`elims_holder_user_select:${itemId}`)
			.setPlaceholder("Select a server member to assign stock to...")
			.setMinValues(1)
			.setMaxValues(1);

		const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
			userSelect,
		);

		await interaction.reply({
			content: `Select the server member you want to assign stock to for this item (**${unassigned.toLocaleString()}** unassigned available):`,
			components: [row],
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		logger.error("Error in handleStockHolderAssignButton:", err);
	}
}

/**
 * Handles selection of a user from the ephemeral UserSelectMenu.
 * Responds immediately with a Modal prompting for the quantity to assign.
 */
export async function handleStockHolderUserSelect(
	interaction: UserSelectMenuInteraction,
): Promise<void> {
	try {
		const itemId = interaction.customId.split(":")[1];
		const targetUserId = interaction.values[0];

		if (!itemId || !targetUserId || !interaction.guildId) return;

		const isTest = false;
		const { unassigned } = await getUnassignedStock(
			interaction.guildId,
			isTest,
			itemId,
		);

		const modal = new ModalBuilder()
			.setCustomId(`elims_holder_assign_modal:${itemId}:${targetUserId}`)
			.setTitle("Assign Stock to Holder");

		const quantityInput = new TextInputBuilder()
			.setCustomId("quantity")
			.setLabel(`Quantity to Assign (Max: ${unassigned})`)
			.setStyle(TextInputStyle.Short)
			.setPlaceholder(`e.g. 10 (Max: ${unassigned})`)
			.setMinLength(1)
			.setMaxLength(6)
			.setRequired(true);

		const row = new ActionRowBuilder<TextInputBuilder>().addComponents(
			quantityInput,
		);
		modal.addComponents(row);

		await interaction.showModal(modal);
	} catch (err) {
		logger.error("Error in handleStockHolderUserSelect:", err);
	}
}

/**
 * Handles submission of the modal for assigning stock to a holder.
 */
export async function handleStockHolderModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	try {
		const parts = interaction.customId.split(":");
		const itemId = parts[1];
		const targetUserId = parts[2];

		if (!itemId || !targetUserId || !interaction.guildId) return;

		const qtyRaw = interaction.fields.getTextInputValue("quantity").trim();
		const quantity = Number.parseInt(qtyRaw, 10);

		if (Number.isNaN(quantity) || quantity <= 0) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Invalid Quantity",
						"Please enter a valid positive whole number.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Resolve target user username
		let targetUsername = `user_${targetUserId}`;
		try {
			const fetchedUser = await interaction.client.users
				.fetch(targetUserId)
				.catch(() => null);
			if (fetchedUser) {
				targetUsername = fetchedUser.username;
			}
		} catch {}

		// Resolve item canonical name
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = state?.data as unknown as ElimsItemRequestConfig | undefined;
		const itemInfo = await resolveTornItem(itemId, config?.allowedItems);

		const isTest = false;
		const result = await assignStockToHolder({
			guildId: interaction.guildId,
			discordUserId: targetUserId,
			discordUsername: targetUsername,
			itemId,
			itemName: itemInfo.name,
			quantity,
			isTest,
		});

		if (!result.success) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Assignment Failed",
						result.error ?? "Failed to assign stock to holder.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const successEmbed = createSuccessEmbed(
			"Stock Assigned Successfully",
			`Assigned **${quantity.toLocaleString()}x ${itemInfo.name}** to <@${targetUserId}>.\n\n` +
				`• **Member Total**: ${result.updatedQuantity?.toLocaleString() ?? quantity}x ${itemInfo.name}\n` +
				`• **Action By**: <@${interaction.user.id}>`,
		);

		await interaction.reply({
			embeds: [successEmbed],
		});

		setTimeout(() => {
			interaction.deleteReply().catch(() => {});
		}, 10_000);

		// Trigger background channel embed sync
		void syncElimsStockHoldersChannel(interaction.client, interaction.guildId);
	} catch (err) {
		logger.error("Error in handleStockHolderModalSubmit:", err);
	}
}

/**
 * Handles clicking "Reclaim Stock" on an item embed in the Stock Holders channel.
 */
export async function handleStockHolderReclaimButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = state?.data as unknown as ElimsItemRequestConfig | undefined;

		if (!hasManagerPermission(interaction, config)) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Permission Denied",
						"You do not have permission to reclaim stock.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const itemId = interaction.customId.split(":")[1];
		if (!itemId || !interaction.guildId) return;

		const isTest = false;
		const holders = await getStockHolders(interaction.guildId, isTest, itemId);

		if (holders.length === 0) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"No Active Holders",
						"No members currently hold stock for this item.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// If only 1 holder exists, immediately show modal
		if (holders.length === 1 && holders[0]) {
			const singleHolder = holders[0];
			const modal = new ModalBuilder()
				.setCustomId(
					`elims_holder_reclaim_modal:${itemId}:${singleHolder.discordUserId}`,
				)
				.setTitle("Reclaim Stock From Holder");

			const qtyInput = new TextInputBuilder()
				.setCustomId("quantity")
				.setLabel(`Quantity to Reclaim (Holds: ${singleHolder.quantity})`)
				.setStyle(TextInputStyle.Short)
				.setPlaceholder(`e.g. ${singleHolder.quantity}`)
				.setRequired(true);

			const row = new ActionRowBuilder<TextInputBuilder>().addComponents(
				qtyInput,
			);
			modal.addComponents(row);

			await interaction.showModal(modal);
			return;
		}

		// Multiple holders: reply with a select menu
		const select = new StringSelectMenuBuilder()
			.setCustomId(`elims_holder_reclaim_select:${itemId}`)
			.setPlaceholder("Select member to reclaim stock from...")
			.addOptions(
				holders.map((h) => ({
					label: `@${h.discordUsername} (${h.quantity.toLocaleString()}x)`,
					value: h.discordUserId,
					description: `User ID: ${h.discordUserId}`,
				})),
			);

		const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
			select,
		);

		await interaction.reply({
			content:
				"Select the member you want to reclaim stock from back to the armory:",
			components: [row],
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		logger.error("Error in handleStockHolderReclaimButton:", err);
	}
}

/**
 * Handles selecting a member to reclaim stock from in the StringSelectMenu.
 */
export async function handleStockHolderReclaimSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	try {
		const itemId = interaction.customId.split(":")[1];
		const targetUserId = interaction.values[0];

		if (!itemId || !targetUserId || !interaction.guildId) return;

		const isTest = false;
		const holders = await getStockHolders(interaction.guildId, isTest, itemId);
		const holder = holders.find((h) => h.discordUserId === targetUserId);

		const modal = new ModalBuilder()
			.setCustomId(`elims_holder_reclaim_modal:${itemId}:${targetUserId}`)
			.setTitle("Reclaim Stock From Holder");

		const qtyInput = new TextInputBuilder()
			.setCustomId("quantity")
			.setLabel(`Quantity to Reclaim (Holds: ${holder?.quantity ?? 0})`)
			.setStyle(TextInputStyle.Short)
			.setPlaceholder(`e.g. ${holder?.quantity ?? 1}`)
			.setRequired(true);

		const row = new ActionRowBuilder<TextInputBuilder>().addComponents(
			qtyInput,
		);
		modal.addComponents(row);

		await interaction.showModal(modal);
	} catch (err) {
		logger.error("Error in handleStockHolderReclaimSelect:", err);
	}
}

/**
 * Handles modal submit for reclaiming stock.
 */
export async function handleStockHolderReclaimModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	try {
		const parts = interaction.customId.split(":");
		const itemId = parts[1];
		const targetUserId = parts[2];

		if (!itemId || !targetUserId || !interaction.guildId) return;

		const qtyRaw = interaction.fields.getTextInputValue("quantity").trim();
		const quantity = Number.parseInt(qtyRaw, 10);

		if (Number.isNaN(quantity) || quantity <= 0) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Invalid Quantity",
						"Please enter a valid positive whole number.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const isTest = false;
		const result = await reclaimStockFromHolder({
			guildId: interaction.guildId,
			discordUserId: targetUserId,
			itemId,
			quantity,
			isTest,
		});

		if (!result.success) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Reclaim Failed",
						result.error ?? "Failed to reclaim stock from holder.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const successEmbed = createSuccessEmbed(
			"Stock Reclaimed Successfully",
			`Reclaimed **${quantity.toLocaleString()} item(s)** from <@${targetUserId}> back to armory unassigned pool.\n\n` +
				`• **Member Remaining**: ${result.remainingQuantity?.toLocaleString() ?? 0} item(s)\n` +
				`• **Action By**: <@${interaction.user.id}>`,
		);

		await interaction.reply({
			embeds: [successEmbed],
		});

		setTimeout(() => {
			interaction.deleteReply().catch(() => {});
		}, 10_000);

		// Trigger background channel embed sync
		void syncElimsStockHoldersChannel(interaction.client, interaction.guildId);
	} catch (err) {
		logger.error("Error in handleStockHolderReclaimModalSubmit:", err);
	}
}
