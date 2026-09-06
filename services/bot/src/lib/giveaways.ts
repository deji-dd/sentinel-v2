import {
	and,
	count,
	db,
	type ElimsGiveawayConfig,
	eq,
	type GiveawayWinner,
	giveawayEntries,
	giveaways,
	isGiveawaysModuleEnabled,
	isNotNull,
	lte,
	systemStates,
	tornItems,
} from "@sentinel/database";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type Client,
	type GuildMember,
	type Message,
	MessageFlags,
	ModalBuilder,
	type ModalSubmitInteraction,
	StringSelectMenuBuilder,
	type StringSelectMenuInteraction,
	type TextChannel,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "./embeds";
import {
	ALLOWED_GIVEAWAY_CATEGORIES,
	ALLOWED_GIVEAWAY_CATEGORIES_SET,
	paginateItems,
	parseDuration,
	pickRandomWinners,
} from "./giveaway-helpers";
import { logger } from "./logger";

export const ELIMS_GIVEAWAYS_CONFIG_ID = "elims:giveaways_config";
const ELIMS_GUILD_CONFIG_ID = "elims:guild_config";

/**
 * Retrieves the giveaway configuration for a guild.
 */
export async function getGiveawayConfig(
	_guildId: string,
): Promise<ElimsGiveawayConfig | null> {
	// First check system state (for tournament/elims guild)
	const [sysState] = await db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, ELIMS_GIVEAWAYS_CONFIG_ID));

	if (sysState?.data) {
		return sysState.data as unknown as ElimsGiveawayConfig;
	}

	return null;
}

/**
 * Saves or updates giveaway config in database.
 */
export async function saveGiveawayConfig(
	config: ElimsGiveawayConfig,
): Promise<void> {
	await db
		.insert(systemStates)
		.values({
			id: ELIMS_GIVEAWAYS_CONFIG_ID,
			init: true,
			data: config as unknown as Record<string, unknown>,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: systemStates.id,
			set: {
				data: config as unknown as Record<string, unknown>,
				updatedAt: new Date(),
			},
		});
}

/**
 * Checks whether an interaction member has permission to create giveaways.
 * All members are permitted by default unless explicitly blacklisted by administrators.
 */
export async function canManageGiveaways(
	member: GuildMember | null,
	guildId: string,
): Promise<{ allowed: boolean; reason?: string }> {
	if (!member) return { allowed: false, reason: "Member not found" };

	const config = await getGiveawayConfig(guildId);
	if (config?.blacklistedUserIds?.includes(member.id)) {
		return {
			allowed: false,
			reason: "You have been blacklisted from creating giveaways.",
		};
	}

	return { allowed: true };
}

/**
 * Builds the persistent "Create Giveaway" manager panel embed and button.
 */
export function buildGiveawayCreatorComponents(): {
	embed: ReturnType<typeof createBaseEmbed>;
	components: [ActionRowBuilder<ButtonBuilder>];
} {
	const embed = createBaseEmbed(
		"Giveaways",
		"Click the button below to initiate and configure a new item giveaway.",
		EMBED_COLORS.PRIMARY,
	);

	const createButton = new ButtonBuilder()
		.setCustomId("giveaway_create_init")
		.setLabel("Create Giveaway")
		.setStyle(ButtonStyle.Primary);

	const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		createButton,
	);

	return { embed, components: [actionRow] };
}

/**
 * Builds the public active giveaway embed and entry button.
 */
export function buildActiveGiveawayComponents(
	giveaway: typeof giveaways.$inferSelect,
	entriesCount: number,
): {
	embed: ReturnType<typeof createBaseEmbed>;
	components: [ActionRowBuilder<ButtonBuilder>];
} {
	const endUnix = Math.floor(giveaway.endsAt.getTime() / 1000);

	const embed = createBaseEmbed(
		`Active Giveaway`,
		[
			`Item: **${giveaway.itemCount}x ${giveaway.itemName}**`,
			`Winners: **${giveaway.winnerCount}**`,
			`Hosted By: <@${giveaway.createdByDiscordId}>`,
			`Ends: <t:${endUnix}:R> (<t:${endUnix}:f>)`,
			`Entries: **${entriesCount}**`,
		].join("\n"),
		EMBED_COLORS.PRIMARY,
	);

	const entryButton = new ButtonBuilder()
		.setCustomId(`giveaway_entry:${giveaway.id}`)
		.setLabel("Enter / Leave Giveaway")
		.setStyle(ButtonStyle.Success);

	const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		entryButton,
	);

	return { embed, components: [actionRow] };
}

/**
 * Builds an idle embed when no giveaway is active in the announcement channel.
 */
export function buildIdleGiveawayComponents(): {
	embed: ReturnType<typeof createBaseEmbed>;
	components: [ActionRowBuilder<ButtonBuilder>];
} {
	return buildGiveawayCreatorComponents();
}

/**
 * Checks if a message is a giveaway creator embed control panel.
 * Results and announcements in the announcement channel are plain text with no components/embeds
 * and must NEVER be deleted ("post and forget").
 */
function isGiveawayCreatorMessage(msg: Message): boolean {
	const hasCreateButton = msg.components.some(
		(row) =>
			"components" in row &&
			Array.isArray(row.components) &&
			row.components.some(
				(c: unknown) =>
					typeof c === "object" &&
					c !== null &&
					"customId" in c &&
					(c as { customId?: string }).customId === "giveaway_create_init",
			),
	);
	const hasCreatorEmbedTitle = msg.embeds.some(
		(e) => e.title === "Giveaway Control Panel" || e.title === "Giveaways",
	);
	return hasCreateButton || hasCreatorEmbedTitle;
}

/**
 * Re-sends the creator embed to ensure it stays at the very bottom of the designated channel.
 * Previous instances of the creator embed (and ONLY the creator embed) in that channel are cleaned up.
 */
export async function resendCreatorEmbed(
	channel: TextChannel,
	clientUserId: string,
	guildId: string,
): Promise<string> {
	const config = await getGiveawayConfig(guildId);
	const knownId = config?.creatorEmbedMessageId;

	const recentMessages = await channel.messages
		.fetch({ limit: 50 })
		.catch(() => null);

	if (recentMessages) {
		for (const msg of recentMessages.values()) {
			if (msg.author.id !== clientUserId) continue;
			// Only delete messages that are verified creator control panels. Plain text announcement results must never be deleted.
			if (
				isGiveawayCreatorMessage(msg) ||
				(Boolean(knownId) &&
					msg.id === knownId &&
					(msg.components.length > 0 || msg.embeds.length > 0))
			) {
				await msg.delete().catch(() => {});
			}
		}
	} else if (knownId) {
		const oldMsg = await channel.messages.fetch(knownId).catch(() => null);
		if (oldMsg && isGiveawayCreatorMessage(oldMsg)) {
			await oldMsg.delete().catch(() => {});
		}
	}

	const { embed, components } = buildGiveawayCreatorComponents();
	const sent = await channel.send({
		embeds: [embed],
		components,
	});

	if (config) {
		await saveGiveawayConfig({
			...config,
			creatorEmbedMessageId: sent.id,
			updatedAt: new Date().toISOString(),
		});
	}

	return sent.id;
}

/**
 * Purges any existing creator embed messages from a specific channel.
 * Plain text winner announcements are never touched.
 */
export async function purgeCreatorEmbedsFromChannel(
	channel: TextChannel,
	clientUserId: string,
): Promise<void> {
	const recentMessages = await channel.messages
		.fetch({ limit: 50 })
		.catch(() => null);

	if (recentMessages) {
		for (const msg of recentMessages.values()) {
			if (msg.author.id !== clientUserId) continue;
			if (isGiveawayCreatorMessage(msg)) {
				await msg.delete().catch(() => {});
			}
		}
	}
}

/**
 * Synchronizes and ensures active giveaway embeds and the persistent creator embed exist.
 */
export async function updateGiveawayChannel(
	client: Client,
	guildId?: string,
): Promise<void> {
	try {
		if (!client.user) return;

		// Resolve tournament guild if guildId not provided
		let targetGuildId = guildId;
		if (!targetGuildId) {
			const [elimsState] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_GUILD_CONFIG_ID));
			targetGuildId = (elimsState?.data as { guildId?: string })?.guildId;
		}

		if (!targetGuildId) return;

		const isEnabled = await isGiveawaysModuleEnabled(targetGuildId);
		if (!isEnabled) return;

		const config = await getGiveawayConfig(targetGuildId);
		if (!config?.announcementChannelId) return;

		const announcementChannel = await client.channels
			.fetch(config.announcementChannelId)
			.catch(() => null);

		if (announcementChannel?.isTextBased()) {
			const textChannel = announcementChannel as TextChannel;

			// 1. Fetch all active giveaways in this guild
			const activeGiveaways = await db
				.select()
				.from(giveaways)
				.where(
					and(
						eq(giveaways.guildId, targetGuildId),
						eq(giveaways.status, "active"),
					),
				)
				.orderBy(giveaways.createdAt);

			let channelNeedsCreatorResend = false;

			// Ensure each active giveaway has its valid embed message in the channel
			for (const gw of activeGiveaways) {
				const [entryRes] = await db
					.select({ val: count() })
					.from(giveawayEntries)
					.where(eq(giveawayEntries.giveawayId, gw.id));

				const entriesCount = entryRes?.val ?? 0;
				const { embed, components } = buildActiveGiveawayComponents(
					gw,
					entriesCount,
				);

				let existingMsg = null;
				if (
					gw.messageId &&
					gw.messageId !== "pending" &&
					gw.messageId !== "deleted"
				) {
					existingMsg = await textChannel.messages
						.fetch(gw.messageId)
						.catch(() => null);
				}

				if (existingMsg) {
					await existingMsg
						.edit({
							embeds: [embed],
							components,
						})
						.catch(() => {});
				} else {
					const sent = await textChannel.send({
						embeds: [embed],
						components,
					});
					await db
						.update(giveaways)
						.set({ messageId: sent.id, updatedAt: new Date() })
						.where(eq(giveaways.id, gw.id));
					channelNeedsCreatorResend = true;
				}
			}

			// Clean up cancelled giveaways that still have an active embed message in the channel.
			// Ended giveaways have their active embed deleted and results posted ("post and forget").
			const staleGiveaways = await db
				.select()
				.from(giveaways)
				.where(
					and(
						eq(giveaways.guildId, targetGuildId),
						eq(giveaways.status, "cancelled"),
						isNotNull(giveaways.messageId),
					),
				);

			for (const stale of staleGiveaways) {
				if (
					stale.messageId &&
					stale.messageId !== "pending" &&
					stale.messageId !== "deleted"
				) {
					const staleMsg = await textChannel.messages
						.fetch(stale.messageId)
						.catch(() => null);
					if (staleMsg) {
						await staleMsg.delete().catch(() => {});
					}
					await db
						.update(giveaways)
						.set({ messageId: "deleted", updatedAt: new Date() })
						.where(eq(giveaways.id, stale.id));
				}
			}

			const hasDedicatedManagerChannel = Boolean(
				config.managerChannelId &&
					config.managerChannelId !== config.announcementChannelId,
			);

			if (hasDedicatedManagerChannel) {
				// Dedicated manager channel is active: purge any creator embed from announcement channel
				await purgeCreatorEmbedsFromChannel(textChannel, client.user.id);
			} else {
				// Announcement channel also serves as creator channel: ensure ONE creator embed is at the bottom
				if (channelNeedsCreatorResend || !config.creatorEmbedMessageId) {
					await resendCreatorEmbed(textChannel, client.user.id, targetGuildId);
				} else {
					const existingCreator = await textChannel.messages
						.fetch(config.creatorEmbedMessageId)
						.catch(() => null);
					if (!existingCreator) {
						await resendCreatorEmbed(
							textChannel,
							client.user.id,
							targetGuildId,
						);
					}
				}
			}
		}

		// Handle dedicated manager channel if specified
		if (
			config.managerChannelId &&
			config.managerChannelId !== config.announcementChannelId
		) {
			const managerChannel = await client.channels
				.fetch(config.managerChannelId)
				.catch(() => null);

			if (managerChannel?.isTextBased()) {
				const mgrTextChannel = managerChannel as TextChannel;
				const existingCreator = config.creatorEmbedMessageId
					? await mgrTextChannel.messages
							.fetch(config.creatorEmbedMessageId)
							.catch(() => null)
					: null;

				if (!existingCreator) {
					await resendCreatorEmbed(
						mgrTextChannel,
						client.user.id,
						targetGuildId,
					);
				}
			}
		}
	} catch (err) {
		logger.error("Error updating giveaway channels:", err);
	}
}

/**
 * Handles the "Create Giveaway" button click.
 */
export async function handleGiveawayCreateInitButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		if (!interaction.guildId || !interaction.member) return;

		const isEnabled = await isGiveawaysModuleEnabled(interaction.guildId);
		if (!isEnabled) {
			const errorEmbed = createErrorEmbed(
				"Module Disabled",
				"The **Giveaways** module is currently disabled for this server.",
			);
			await interaction.reply({
				embeds: [errorEmbed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const { allowed, reason } = await canManageGiveaways(
			interaction.member as GuildMember,
			interaction.guildId,
		);

		if (!allowed) {
			const errorEmbed = createErrorEmbed(
				"Permission Denied",
				reason ?? "You do not have permission to create giveaways.",
			);
			await interaction.reply({
				embeds: [errorEmbed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Build Category Select Menu with allowed categories
		const selectMenu = new StringSelectMenuBuilder()
			.setCustomId("giveaway_category_select")
			.setPlaceholder("Select an item category...")
			.addOptions(
				ALLOWED_GIVEAWAY_CATEGORIES.map((cat) => ({
					label: cat,
					value: cat,
					description: `Browse giveaway items in ${cat}`,
				})),
			);

		const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
			selectMenu,
		);

		const categoryEmbed = createBaseEmbed(
			"Create Giveaway — Select Category",
			"Select the category of the Torn item you would like to give away from the dropdown below:",
			EMBED_COLORS.PRIMARY,
		);

		await interaction.reply({
			embeds: [categoryEmbed],
			components: [row],
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		logger.error("Error in handleGiveawayCreateInitButton:", err);
		const errorEmbed = createErrorEmbed(
			"Creation Form Error",
			"An error occurred while opening the giveaway creator.",
		);
		await interaction
			.reply({
				embeds: [errorEmbed],
				flags: MessageFlags.Ephemeral,
			})
			.catch(() => {});
	}
}

/**
 * Helper to fetch Torn items for a category and render paginated select menu.
 */
async function renderItemSelectPage(
	category: string,
	page: number,
): Promise<{
	embed: ReturnType<typeof createBaseEmbed>;
	components: (
		| ActionRowBuilder<StringSelectMenuBuilder>
		| ActionRowBuilder<ButtonBuilder>
	)[];
} | null> {
	const allItems = await db.select().from(tornItems);

	const itemsInCategory = allItems
		.filter((item) => {
			const itemData = item.data as { type?: string; name?: string } | null;
			return (itemData?.type ?? "") === category;
		})
		.map((item) => {
			const itemData = item.data as {
				type?: string;
				name?: string;
				market_value?: number;
			} | null;
			return {
				id: item.id,
				name: item.name ?? itemData?.name ?? `Item #${item.id}`,
				marketValue: itemData?.market_value,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));

	if (itemsInCategory.length === 0) return null;

	const { items, currentPage, totalPages, hasNext, hasPrev } = paginateItems(
		itemsInCategory,
		page,
		25,
	);

	const selectMenu = new StringSelectMenuBuilder()
		.setCustomId(`giveaway_item_select:${category}`)
		.setPlaceholder(`Select an item from ${category}...`)
		.addOptions(
			items.map((it) => ({
				label: it.name,
				value: it.id,
				description: it.marketValue
					? `Market Value: $${it.marketValue.toLocaleString()}`
					: undefined,
			})),
		);

	const selectRow =
		new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
	const components: (
		| ActionRowBuilder<StringSelectMenuBuilder>
		| ActionRowBuilder<ButtonBuilder>
	)[] = [selectRow];

	if (totalPages > 1) {
		const prevBtn = new ButtonBuilder()
			.setCustomId(`giveaway_item_page:${category}:${currentPage - 1}`)
			.setLabel("Previous Page")
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(!hasPrev);

		const pageIndicator = new ButtonBuilder()
			.setCustomId("giveaway_noop_page")
			.setLabel(`Page ${currentPage} of ${totalPages}`)
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(true);

		const nextBtn = new ButtonBuilder()
			.setCustomId(`giveaway_item_page:${category}:${currentPage + 1}`)
			.setLabel("Next Page")
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(!hasNext);

		const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			prevBtn,
			pageIndicator,
			nextBtn,
		);
		components.push(navRow);
	}

	const embed = createBaseEmbed(
		`Create Giveaway — ${category} (Page ${currentPage}/${totalPages})`,
		`Select the specific item you want to give away from **${category}**:`,
		EMBED_COLORS.PRIMARY,
	);

	return { embed, components };
}

/**
 * Handles Category select menu interaction.
 */
export async function handleGiveawayCategorySelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	try {
		const selectedCategory = interaction.values[0];
		if (
			!selectedCategory ||
			!ALLOWED_GIVEAWAY_CATEGORIES_SET.has(selectedCategory)
		)
			return;

		const result = await renderItemSelectPage(selectedCategory, 1);
		if (!result) {
			const errorEmbed = createErrorEmbed(
				"No Items Found",
				`No items found in category: ${selectedCategory}.`,
			);
			await interaction.update({
				embeds: [errorEmbed],
				components: [],
			});
			return;
		}

		await interaction.update({
			embeds: [result.embed],
			components: result.components,
		});
	} catch (err) {
		logger.error("Error in handleGiveawayCategorySelect:", err);
	}
}

/**
 * Handles pagination button click for item lists with > 25 items (e.g. Supply Pack).
 */
export async function handleGiveawayItemPageButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const parts = interaction.customId.split(":");
		const category = parts[1];
		const page = Number.parseInt(parts[2] ?? "1", 10);

		if (!category || Number.isNaN(page)) return;

		const result = await renderItemSelectPage(category, page);
		if (!result) return;

		await interaction.update({
			embeds: [result.embed],
			components: result.components,
		});
	} catch (err) {
		logger.error("Error in handleGiveawayItemPageButton:", err);
	}
}

/**
 * Handles item selection -> shows modal for count, winners, duration.
 */
export async function handleGiveawayItemSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	try {
		const selectedItemId = interaction.values[0];
		if (!selectedItemId) return;

		const [dbItem] = await db
			.select()
			.from(tornItems)
			.where(eq(tornItems.id, selectedItemId));

		const itemData = dbItem?.data as { name?: string; type?: string } | null;
		const itemName =
			dbItem?.name ?? itemData?.name ?? `Item #${selectedItemId}`;
		const itemCategory = itemData?.type ?? "General";

		const modal = new ModalBuilder()
			.setCustomId(
				`giveaway_config_modal:${selectedItemId}:${encodeURIComponent(itemCategory)}`,
			)
			.setTitle(`Giveaway: ${itemName.slice(0, 30)}`);

		const countInput = new TextInputBuilder()
			.setCustomId("item_count")
			.setLabel("Item Quantity")
			.setStyle(TextInputStyle.Short)
			.setValue("1")
			.setPlaceholder("e.g. 10")
			.setRequired(true)
			.setMaxLength(10);

		const winnersInput = new TextInputBuilder()
			.setCustomId("winner_count")
			.setLabel("Number of Winners")
			.setStyle(TextInputStyle.Short)
			.setValue("1")
			.setPlaceholder("e.g. 1")
			.setRequired(true)
			.setMaxLength(5);

		const durationInput = new TextInputBuilder()
			.setCustomId("duration")
			.setLabel("Duration (e.g. 1d, 12h, 30m, 45s)")
			.setStyle(TextInputStyle.Short)
			.setValue("24h")
			.setPlaceholder("e.g. 1d 12h, 45m, 30s")
			.setRequired(true)
			.setMaxLength(30);

		modal.addComponents(
			new ActionRowBuilder<TextInputBuilder>().addComponents(countInput),
			new ActionRowBuilder<TextInputBuilder>().addComponents(winnersInput),
			new ActionRowBuilder<TextInputBuilder>().addComponents(durationInput),
		);

		await interaction.showModal(modal);
	} catch (err) {
		logger.error("Error in handleGiveawayItemSelect:", err);
	}
}

/**
 * Handles the submission of the giveaway configuration modal.
 */
export async function handleGiveawayModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	try {
		if (!interaction.guildId || !interaction.member) return;

		const parts = interaction.customId.split(":");
		const itemId = parts[1];
		const itemCategory = decodeURIComponent(parts[2] ?? "General");

		if (!itemId) return;

		const rawCount = interaction.fields.getTextInputValue("item_count").trim();
		const rawWinners = interaction.fields
			.getTextInputValue("winner_count")
			.trim();
		const rawDuration = interaction.fields.getTextInputValue("duration").trim();

		const itemCount = Number.parseInt(rawCount, 10);
		const winnerCount = Number.parseInt(rawWinners, 10);
		const durationMs = parseDuration(rawDuration);

		if (Number.isNaN(itemCount) || itemCount <= 0) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Invalid Quantity",
						"Item quantity must be a positive number greater than 0.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (Number.isNaN(winnerCount) || winnerCount <= 0) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Invalid Winners",
						"Number of winners must be a positive integer greater than 0.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (!durationMs || durationMs < 10_000 || durationMs > 30 * 86_400_000) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Invalid Duration",
						"Duration must be between 10 seconds and 30 days (e.g. 30s, 45m, 12h, 2d).",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const config = await getGiveawayConfig(interaction.guildId);
		if (!config?.announcementChannelId) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Channel Not Configured",
						"The giveaway announcement channel has not been set up in the dashboard.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const channel = await interaction.client.channels
			.fetch(config.announcementChannelId)
			.catch(() => null);

		if (!channel?.isTextBased()) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Channel Not Found",
						"Could not find or access the configured giveaway announcement channel.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const [dbItem] = await db
			.select()
			.from(tornItems)
			.where(eq(tornItems.id, itemId));

		const itemData = dbItem?.data as { name?: string } | null;
		const itemName = dbItem?.name ?? itemData?.name ?? `Item #${itemId}`;

		const endsAt = new Date(Date.now() + durationMs);

		// Insert giveaway record
		const [createdGiveaway] = await db
			.insert(giveaways)
			.values({
				guildId: interaction.guildId,
				channelId: config.announcementChannelId,
				messageId: "pending",
				createdByDiscordId: interaction.user.id,
				createdByUsername: interaction.user.username,
				itemId,
				itemName,
				itemCategory,
				itemCount,
				winnerCount,
				durationStr: rawDuration,
				durationMs,
				status: "active",
				endsAt,
			})
			.returning();

		if (!createdGiveaway) {
			throw new Error("Failed to persist giveaway in database");
		}

		// Build and send active giveaway embed to announcement channel
		const { embed, components } = buildActiveGiveawayComponents(
			createdGiveaway,
			0,
		);

		const activeMsg = await (channel as TextChannel).send({
			embeds: [embed],
			components,
		});

		await db
			.update(giveaways)
			.set({ messageId: activeMsg.id, updatedAt: new Date() })
			.where(eq(giveaways.id, createdGiveaway.id));

		const hasDedicatedManagerChannel = Boolean(
			config.managerChannelId &&
				config.managerChannelId !== config.announcementChannelId,
		);

		if (!hasDedicatedManagerChannel) {
			// Re-send the persistent creator embed so it stays at the very bottom of announcement channel
			await resendCreatorEmbed(
				channel as TextChannel,
				interaction.client.user.id,
				interaction.guildId,
			);
		} else {
			// Dedicated manager channel: announcement channel should never contain creator embed
			await purgeCreatorEmbedsFromChannel(
				channel as TextChannel,
				interaction.client.user.id,
			);
		}

		const successEmbed = createBaseEmbed(
			"Giveaway Launched",
			`Successfully created giveaway for **${itemCount}x ${itemName}** in <#${config.announcementChannelId}>.`,
			EMBED_COLORS.SUCCESS,
		);

		await interaction.reply({
			embeds: [successEmbed],
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		logger.error("Error in handleGiveawayModalSubmit:", err);
		const errorEmbed = createErrorEmbed(
			"Creation Failed",
			"An unexpected error occurred while launching the giveaway.",
		);
		await interaction
			.reply({
				embeds: [errorEmbed],
				flags: MessageFlags.Ephemeral,
			})
			.catch(() => {});
	}
}

/**
 * Handles the "Enter / Leave Giveaway" button interaction.
 */
export async function handleGiveawayEntryButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const parts = interaction.customId.split(":");
		const giveawayId = parts[1];
		if (!giveawayId) return;

		const [giveaway] = await db
			.select()
			.from(giveaways)
			.where(eq(giveaways.id, giveawayId));

		if (giveaway?.status !== "active") {
			const errorEmbed = createErrorEmbed(
				"Giveaway Concluded",
				"This giveaway is no longer active.",
			);
			await interaction.reply({
				embeds: [errorEmbed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (new Date() >= giveaway.endsAt) {
			const errorEmbed = createErrorEmbed(
				"Giveaway Concluded",
				"Entries for this giveaway have closed.",
			);
			await interaction.reply({
				embeds: [errorEmbed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Check if user is already entered
		const [existingEntry] = await db
			.select()
			.from(giveawayEntries)
			.where(
				and(
					eq(giveawayEntries.giveawayId, giveawayId),
					eq(giveawayEntries.discordUserId, interaction.user.id),
				),
			);

		let userFeedback = "";

		if (existingEntry) {
			// Leave giveaway
			await db
				.delete(giveawayEntries)
				.where(eq(giveawayEntries.id, existingEntry.id));
			userFeedback = `You have withdrawn from the giveaway for **${giveaway.itemCount}x ${giveaway.itemName}**.`;
		} else {
			// Enter giveaway
			const member = interaction.member as GuildMember | null;
			const nickMatch = member?.displayName?.match(
				/^(?:\[[^\]]*\]\s*)?(.+?)\s*\[(\d+)\]$/,
			);
			const tornId = nickMatch?.[2] ? Number(nickMatch[2]) : null;
			const tornName = nickMatch?.[1] ? nickMatch[1].trim() : null;

			await db.insert(giveawayEntries).values({
				giveawayId,
				discordUserId: interaction.user.id,
				discordUsername: interaction.user.username,
				tornId,
				tornName,
			});
			userFeedback = `You have successfully entered the giveaway for **${giveaway.itemCount}x ${giveaway.itemName}**!`;
		}

		// Reply ephemerally to the user immediately
		const feedbackEmbed = createBaseEmbed(
			existingEntry ? "Giveaway Left" : "Giveaway Entered",
			userFeedback,
			existingEntry ? EMBED_COLORS.WARNING : EMBED_COLORS.SUCCESS,
		);

		await interaction.reply({
			embeds: [feedbackEmbed],
			flags: MessageFlags.Ephemeral,
		});

		// Recount entries and update the persistent embed in place
		const [entryRes] = await db
			.select({ val: count() })
			.from(giveawayEntries)
			.where(eq(giveawayEntries.giveawayId, giveawayId));

		const currentCount = entryRes?.val ?? 0;
		const { embed, components } = buildActiveGiveawayComponents(
			giveaway,
			currentCount,
		);

		if (interaction.message) {
			await interaction.message
				.edit({
					embeds: [embed],
					components,
				})
				.catch(() => {});
		}
	} catch (err) {
		logger.error("Error in handleGiveawayEntryButton:", err);
	}
}

/**
 * Concludes a giveaway:
 * 1. Picks random winners
 * 2. Updates database
 * 3. Deletes active giveaway embed
 * 4. Sends plain text announcement tagging the winners and host
 * 5. Re-sends the original persistent embed at the bottom
 */
export async function endGiveaway(
	client: Client,
	giveaway: typeof giveaways.$inferSelect,
): Promise<void> {
	try {
		const allEntries = await db
			.select()
			.from(giveawayEntries)
			.where(eq(giveawayEntries.giveawayId, giveaway.id));

		const selectedWinners = pickRandomWinners(allEntries, giveaway.winnerCount);

		const winnerPayload: GiveawayWinner[] = selectedWinners.map((w) => ({
			discordUserId: w.discordUserId,
			discordUsername: w.discordUsername,
			tornId: w.tornId,
			tornName: w.tornName,
			selectedAt: new Date().toISOString(),
		}));

		// Update giveaway status
		await db
			.update(giveaways)
			.set({
				status: "ended",
				winners: winnerPayload,
				messageId: "deleted",
				updatedAt: new Date(),
			})
			.where(eq(giveaways.id, giveaway.id));

		const channel = await client.channels
			.fetch(giveaway.channelId)
			.catch(() => null);

		if (!channel?.isTextBased()) return;
		const textChannel = channel as TextChannel;

		// 1. Delete the active giveaway embed message
		if (
			giveaway.messageId &&
			giveaway.messageId !== "pending" &&
			giveaway.messageId !== "deleted"
		) {
			const activeMsg = await textChannel.messages
				.fetch(giveaway.messageId)
				.catch(() => null);
			if (activeMsg) {
				await activeMsg.delete().catch(() => {});
			}
		}

		// 2. Send text tagging the winners and the host (post and forget)
		let announcementText = "";
		if (selectedWinners.length > 0) {
			const winnerTags = selectedWinners
				.map((w) => `<@${w.discordUserId}>`)
				.join(", ");
			announcementText = `Congratulations ${winnerTags}! You won **${giveaway.itemCount}x ${giveaway.itemName}** hosted by <@${giveaway.createdByDiscordId}>!`;
		} else {
			announcementText = `Giveaway for **${giveaway.itemCount}x ${giveaway.itemName}** hosted by <@${giveaway.createdByDiscordId}> concluded with no entries.`;
		}

		await textChannel.send({
			content: announcementText,
		});

		// 3. Re-send creator embed only if channels are unified (no dedicated manager channel).
		// When dedicated manager channel exists, announcement channel is post-and-forget; never purge.
		const config = await getGiveawayConfig(giveaway.guildId);
		const hasDedicatedManagerChannel = Boolean(
			config?.managerChannelId &&
				config.managerChannelId !== config.announcementChannelId,
		);

		if (!hasDedicatedManagerChannel) {
			await resendCreatorEmbed(
				textChannel,
				client.user?.id ?? "",
				giveaway.guildId,
			);
		}

		logger.info(
			`Giveaway ${giveaway.id} concluded. ${selectedWinners.length} winner(s) picked.`,
		);
	} catch (err) {
		logger.error(`Error ending giveaway ${giveaway.id}:`, err);
	}
}

/**
 * Starts the background worker to poll and end completed giveaways.
 */
export function startGiveawayScheduler(client: Client): void {
	const pollIntervalMs = 15_000;

	setInterval(async () => {
		try {
			const now = new Date();
			const dueGiveaways = await db
				.select()
				.from(giveaways)
				.where(and(eq(giveaways.status, "active"), lte(giveaways.endsAt, now)));

			for (const gw of dueGiveaways) {
				await endGiveaway(client, gw);
			}
		} catch (err) {
			logger.error("Error in giveaway scheduler loop:", err);
		}
	}, pollIntervalMs);

	logger.info("Giveaway scheduler worker initialized (15s cadence).");
}
