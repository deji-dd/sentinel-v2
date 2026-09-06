import {
	and,
	db,
	type ElimsItemRequestConfig,
	elimsApiKeys,
	elimsItemRequests,
	elimsVerifiedUsers,
	eq,
	systemStates,
} from "@sentinel/database";
import {
	decryptApiKey,
	isValidApiKey,
	TornApiClient,
} from "@sentinel/torn-api";
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
} from "discord.js";
import {
	createBaseEmbed,
	createErrorEmbed,
	createSuccessEmbed,
	EMBED_COLORS,
} from "./embeds";
import { logger } from "./logger";

const ELIMS_CONFIG_ID = "elims:guild_config";
const ELIMS_ITEM_REQUESTS_CONFIG_ID = "elims:item_requests_config";

/**
 * Resolves a Discord user's Torn identity for Elims.
 * 1. Checks elimsVerifiedUsers table in DB.
 * 2. If not found, falls back to a live Torn API call using the guild's configured API key(s).
 * 3. On successful live resolution, saves the record into elimsVerifiedUsers.
 */
export async function resolveElimsUser(
	discordId: string,
	guildId: string,
): Promise<{ tornId: number; tornName: string } | null> {
	// 1. Check Elims verified users DB
	const [cached] = await db
		.select()
		.from(elimsVerifiedUsers)
		.where(eq(elimsVerifiedUsers.discordId, discordId));

	if (cached?.tornId && cached.tornName) {
		return { tornId: cached.tornId, tornName: cached.tornName };
	}

	// 2. Fetch guild's active API keys
	const guildKeys = await db
		.select()
		.from(elimsApiKeys)
		.where(
			and(eq(elimsApiKeys.guildId, guildId), eq(elimsApiKeys.isValid, true)),
		)
		.orderBy(elimsApiKeys.lastUsedAt);

	if (guildKeys.length === 0) {
		return null;
	}

	const masterKey = process.env.ENCRYPTION_KEY ?? "";
	const client = new TornApiClient();

	for (const keyRecord of guildKeys) {
		try {
			const rawKey =
				keyRecord.apiKeyEncrypted.length > 16 && masterKey
					? decryptApiKey(keyRecord.apiKeyEncrypted, masterKey)
					: keyRecord.apiKeyEncrypted;

			if (!isValidApiKey(rawKey)) continue;

			// Call Torn API user endpoint with Discord ID
			const response = await client.getRaw<{
				player_id?: number;
				name?: string;
				faction?: { id?: number; tag?: string };
				profile?: { id?: number; name?: string };
				error?: { code: number; error: string };
			}>("user/", {
				apiKey: rawKey,
				queryParams: {
					selections: "discord,profile",
					id: discordId,
				},
			});

			// Update key's lastUsedAt
			await db
				.update(elimsApiKeys)
				.set({ lastUsedAt: new Date() })
				.where(eq(elimsApiKeys.id, keyRecord.id));

			const tornId = response?.profile?.id ?? response?.player_id ?? null;
			const tornName = response?.profile?.name ?? response?.name ?? null;

			if (tornId && tornName) {
				const now = new Date();
				// Cache in elimsVerifiedUsers
				await db
					.insert(elimsVerifiedUsers)
					.values({
						discordId,
						tornId,
						tornName,
						factionId: response.faction?.id ?? null,
						factionTag: response.faction?.tag ?? null,
						lastCheckedAt: now,
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: elimsVerifiedUsers.discordId,
						set: {
							tornId,
							tornName,
							factionId: response.faction?.id ?? null,
							factionTag: response.faction?.tag ?? null,
							lastCheckedAt: now,
							updatedAt: now,
						},
					});

				return { tornId, tornName };
			}
		} catch (err) {
			logger.warn(
				`Failed live Torn verification for ${discordId} using guild key ${keyRecord.id}:`,
				err,
			);
		}
	}

	return null;
}

/**
 * Updates or deploys the persistent Item Requests embed in the configured request channel.
 */
export async function updateElimsItemRequestsChannel(
	client: Client,
	targetGuildId?: string,
	incomingConfig?: Record<string, unknown>,
): Promise<void> {
	try {
		const [guildState] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_CONFIG_ID));

		const guildData = guildState?.data as { guildId?: string } | undefined;
		const guildId = targetGuildId || guildData?.guildId;
		if (!guildId) return;

		let config: ElimsItemRequestConfig | null = null;
		if (incomingConfig) {
			config = incomingConfig as unknown as ElimsItemRequestConfig;
		} else {
			const [reqState] = await db
				.select()
				.from(systemStates)
				.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
			config = reqState?.data as unknown as ElimsItemRequestConfig | null;
		}

		if (!config?.requestChannelId) return;

		const guild =
			client.guilds.cache.get(guildId) ||
			(await client.guilds.fetch(guildId).catch(() => null));
		if (!guild) return;

		const channel =
			guild.channels.cache.get(config.requestChannelId) ||
			(await guild.channels.fetch(config.requestChannelId).catch(() => null));
		if (!channel || !(channel instanceof TextChannel)) return;

		const embed = createBaseEmbed(
			"Item Requests",
			"Request supplies and equipment for elims.",
			EMBED_COLORS.PRIMARY,
		);

		embed.addFields({
			name: "Instructions",
			value:
				"Click the button below to submit a request. Your request will be reviewed by admins.",
			inline: false,
		});

		const requestButton = new ButtonBuilder()
			.setCustomId("elims_request_open")
			.setLabel("Request Items")
			.setStyle(ButtonStyle.Primary);

		const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			requestButton,
		);

		// Check if existing embed exists
		let existingMessage = null;
		if (config.embedMessageId) {
			existingMessage = await channel.messages
				.fetch(config.embedMessageId)
				.catch(() => null);
		}

		if (existingMessage) {
			await existingMessage.edit({
				embeds: [embed],
				components: [actionRow],
			});
		} else {
			const sent = await channel.send({
				embeds: [embed],
				components: [actionRow],
			});

			// Save message ID to config
			const updatedConfig: ElimsItemRequestConfig = {
				...config,
				embedMessageId: sent.id,
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
		logger.error("Error updating Elims Item Requests channel embed:", err);
	}
}

/**
 * Handles the initial [Request Items] button click.
 */
export async function handleItemRequestButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const [reqState] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = reqState?.data as unknown as ElimsItemRequestConfig | null;

		if (!config || config.allowedItems.length === 0) {
			const embed = createErrorEmbed(
				"Item Requests Unavailable",
				"Item requests are currently not configured or no items are whitelisted.",
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Role permission verification
		if (
			config.requesterRoleIds &&
			config.requesterRoleIds.length > 0 &&
			interaction.inGuild()
		) {
			const member = interaction.member;
			const userRoles =
				member && "roles" in member && Array.isArray(member.roles)
					? member.roles
					: member &&
							"roles" in member &&
							member.roles &&
							typeof member.roles === "object" &&
							"cache" in member.roles
						? Array.from((member.roles.cache as Map<string, unknown>).keys())
						: [];

			const hasRequiredRole = config.requesterRoleIds.some((rId) =>
				userRoles.includes(rId),
			);
			if (!hasRequiredRole) {
				const embed = createErrorEmbed(
					"Permission Denied",
					"You do not have permission to request items.",
				);
				await interaction.reply({
					embeds: [embed],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
		}

		// Extract unique categories (max 25 for select menu)
		const categories = Array.from(
			new Set(config.allowedItems.map((i) => i.category || "General")),
		).slice(0, 25);

		const selectMenu = new StringSelectMenuBuilder()
			.setCustomId("elims_category_select")
			.setPlaceholder("Select an item category...")
			.addOptions(
				categories.map((cat) => ({
					label: cat,
					value: cat,
					description: `Browse requestable items in ${cat}`,
				})),
			);

		const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
			selectMenu,
		);

		const categoryEmbed = createBaseEmbed(
			"Item Requests — Select Category",
			"Select the category of supplies you would like to request from the dropdown below:",
			EMBED_COLORS.PRIMARY,
		);

		await interaction.reply({
			embeds: [categoryEmbed],
			components: [row],
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		logger.error("Error in handleItemRequestButton:", err);
		const errorEmbed = createErrorEmbed(
			"Request Form Error",
			"An error occurred while opening the request form.",
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
 * Handles Category StringSelectMenu selection -> updates ephemeral view with items in that category.
 */
export async function handleItemRequestCategorySelect(
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
			.setCustomId("elims_item_select")
			.setPlaceholder(`Select an item from ${selectedCategory}...`)
			.addOptions(
				itemsInCategory.map((it) => ({
					label: it.name,
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
			`Item Requests — ${selectedCategory}`,
			`Select the specific item you need from **${selectedCategory}** below:`,
			EMBED_COLORS.PRIMARY,
		);

		await interaction.update({
			embeds: [itemSelectEmbed],
			components: [row],
		});
	} catch (err) {
		logger.error("Error in handleItemRequestCategorySelect:", err);
	}
}

/**
 * Handles Item StringSelectMenu selection -> displays Discord Modal for quantity.
 */
export async function handleItemRequestItemSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	try {
		const selectedItemId = interaction.values[0];
		if (!selectedItemId) return;

		const [reqState] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = reqState?.data as unknown as ElimsItemRequestConfig | null;

		const selectedItem = config?.allowedItems.find(
			(i) => i.id === selectedItemId,
		);
		const itemName = selectedItem?.name ?? "Item";

		const modal = new ModalBuilder()
			.setCustomId(`elims_request_modal:${selectedItemId}`)
			.setTitle(`Request ${itemName.slice(0, 30)}`);

		const quantityInput = new TextInputBuilder()
			.setCustomId("quantity")
			.setLabel("Quantity Needed")
			.setStyle(TextInputStyle.Short)
			.setPlaceholder("e.g. 5")
			.setMinLength(1)
			.setMaxLength(6)
			.setRequired(true);

		const reasonInput = new TextInputBuilder()
			.setCustomId("reason")
			.setLabel("Match Notes / Target (Optional)")
			.setStyle(TextInputStyle.Paragraph)
			.setPlaceholder("e.g. Target: Team 4 war match")
			.setMaxLength(200)
			.setRequired(false);

		const row1 = new ActionRowBuilder<TextInputBuilder>().addComponents(
			quantityInput,
		);
		const row2 = new ActionRowBuilder<TextInputBuilder>().addComponents(
			reasonInput,
		);

		modal.addComponents(row1, row2);
		await interaction.showModal(modal);
	} catch (err) {
		logger.error("Error in handleItemRequestItemSelect:", err);
	}
}

/**
 * Handles Discord Modal submission -> stores request in DB and posts to Granting Channel.
 */
export async function handleItemRequestModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	try {
		const itemId = interaction.customId.split(":")[1];
		if (!itemId || !interaction.guildId) {
			const embed = createErrorEmbed(
				"Error",
				"This action can only be performed within a server.",
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const qtyRaw = interaction.fields.getTextInputValue("quantity").trim();
		const reason =
			interaction.fields.getTextInputValue("reason")?.trim() || null;

		const quantity = Number.parseInt(qtyRaw, 10);
		if (Number.isNaN(quantity) || quantity <= 0) {
			const embed = createErrorEmbed(
				"Invalid Quantity",
				"Invalid quantity. Please provide a positive whole number.",
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const [reqState] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = reqState?.data as unknown as ElimsItemRequestConfig | null;

		const item = config?.allowedItems.find((i) => i.id === itemId);
		if (!item) {
			const embed = createErrorEmbed(
				"Item Unavailable",
				"The requested item is no longer available in the whitelist.",
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Resolve Torn user details if verified via Elims DB or guild key live call
		const resolvedUser = await resolveElimsUser(
			interaction.user.id,
			interaction.guildId,
		);

		const [createdRequest] = await db
			.insert(elimsItemRequests)
			.values({
				guildId: interaction.guildId,
				discordUserId: interaction.user.id,
				discordUsername: interaction.user.username,
				tornId: resolvedUser?.tornId ?? null,
				tornName: resolvedUser?.tornName ?? null,
				itemId: item.id,
				itemName: item.name,
				itemCategory: item.category || "General",
				quantity,
				status: "pending",
				isTest: false,
				reason,
			})
			.returning();

		if (!createdRequest) {
			const embed = createErrorEmbed(
				"Submission Failed",
				"Failed to record your request. Please try again.",
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const shortId = createdRequest.id.slice(0, 8);

		// Post to Granting Channel if configured
		if (config?.grantingChannelId) {
			const grantingChannel = await interaction.client.channels
				.fetch(config.grantingChannelId)
				.catch(() => null);

			if (grantingChannel && grantingChannel instanceof TextChannel) {
				const grantEmbed = new EmbedBuilder()
					.setTitle(`Item Request — ${item.name} x${quantity}`)
					.setColor(0xf59e0b) // Amber for pending
					.addFields(
						{
							name: "Requester",
							value: `<@${interaction.user.id}>`,
							inline: true,
						},
						{
							name: "Torn Identity",
							value: resolvedUser
								? `[${resolvedUser.tornName} [${resolvedUser.tornId}]](https://www.torn.com/profiles.php?XID=${resolvedUser.tornId})`
								: "Not verified",
							inline: true,
						},
						{
							name: "Item & Quantity",
							value: `**${item.name}** x${quantity}`,
							inline: true,
						},
					);

				if (reason) {
					grantEmbed.addFields({
						name: "Notes / Target",
						value: reason,
						inline: false,
					});
				}

				grantEmbed.setFooter({
					text: `Request ID: #${shortId} • Status: PENDING`,
				});
				grantEmbed.setTimestamp(new Date());

				const approveBtn = new ButtonBuilder()
					.setCustomId(`elims_grant_accept:${createdRequest.id}`)
					.setLabel("Approve")
					.setStyle(ButtonStyle.Success);

				const rejectBtn = new ButtonBuilder()
					.setCustomId(`elims_grant_reject:${createdRequest.id}`)
					.setLabel("Reject")
					.setStyle(ButtonStyle.Danger);

				const testBtn = new ButtonBuilder()
					.setCustomId(`elims_grant_test:${createdRequest.id}`)
					.setLabel("Mark as Test")
					.setStyle(ButtonStyle.Secondary);

				const grantRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
					approveBtn,
					rejectBtn,
					testBtn,
				);

				const grantMsg = await grantingChannel.send({
					embeds: [grantEmbed],
					components: [grantRow],
				});

				await db
					.update(elimsItemRequests)
					.set({ grantingMessageId: grantMsg.id })
					.where(eq(elimsItemRequests.id, createdRequest.id));
			}
		}

		const successEmbed = createSuccessEmbed(
			"Item Request Submitted",
			`Your item request has been submitted for review.\n\n` +
				`**Request ID**: #${shortId}\n` +
				`**Item**: ${item.name} x${quantity}\n` +
				`**Category**: ${item.category || "General"}` +
				(reason ? `\n**Notes**: ${reason}` : ""),
		);

		await interaction.reply({
			embeds: [successEmbed],
			flags: MessageFlags.Ephemeral,
		});
	} catch (err) {
		logger.error("Error in handleItemRequestModalSubmit:", err);
		const errorEmbed = createErrorEmbed(
			"Submission Error",
			"An error occurred while submitting your request.",
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
 * Handles Approve / Reject / Mark as Test buttons in the Granting Channel.
 */
export async function handleItemGrantingButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const [actionType, requestId] = interaction.customId.split(":");
		if (!requestId) return;

		const [reqState] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = reqState?.data as unknown as ElimsItemRequestConfig | null;

		// Verify officer / manager permission
		const member = interaction.member;
		const userRoles =
			member && "roles" in member && Array.isArray(member.roles)
				? member.roles
				: member &&
						"roles" in member &&
						member.roles &&
						typeof member.roles === "object" &&
						"cache" in member.roles
					? Array.from((member.roles.cache as Map<string, unknown>).keys())
					: [];

		const isAdmin =
			member &&
			"permissions" in member &&
			typeof member.permissions === "object" &&
			"has" in member.permissions &&
			(member.permissions as { has: (p: bigint) => boolean }).has(BigInt(0x8));
		const hasManagerRole =
			config?.managerRoleIds && config.managerRoleIds.length > 0
				? config.managerRoleIds.some((rId) => userRoles.includes(rId))
				: true;

		if (!isAdmin && !hasManagerRole) {
			const embed = createErrorEmbed(
				"Permission Denied",
				"You do not have permission to manage item requests.",
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const [request] = await db
			.select()
			.from(elimsItemRequests)
			.where(eq(elimsItemRequests.id, requestId));

		if (!request) {
			const embed = createErrorEmbed(
				"Request Not Found",
				"Item request record not found.",
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const shortId = request.id.slice(0, 8);

		if (actionType === "elims_grant_test") {
			const updatedTest = !request.isTest;
			await db
				.update(elimsItemRequests)
				.set({ isTest: updatedTest, updatedAt: new Date() })
				.where(eq(elimsItemRequests.id, requestId));

			const newLabel = updatedTest ? "Unmark Test" : "Mark as Test";
			const testBtn = new ButtonBuilder()
				.setCustomId(`elims_grant_test:${request.id}`)
				.setLabel(newLabel)
				.setStyle(ButtonStyle.Secondary);

			const approveBtn = new ButtonBuilder()
				.setCustomId(`elims_grant_accept:${request.id}`)
				.setLabel("Approve")
				.setStyle(ButtonStyle.Success);

			const rejectBtn = new ButtonBuilder()
				.setCustomId(`elims_grant_reject:${request.id}`)
				.setLabel("Reject")
				.setStyle(ButtonStyle.Danger);

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				approveBtn,
				rejectBtn,
				testBtn,
			);
			await interaction.update({ components: [row] });
			return;
		}

		if (request.status !== "pending") {
			const embed = createErrorEmbed(
				"Request Already Resolved",
				`This request has already been ${request.status} by ${request.handledByUsername ?? "an officer"}.`,
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const isAccept = actionType === "elims_grant_accept";
		const newStatus = isAccept ? "accepted" : "rejected";

		// Resolve handler Torn user details
		const guildId = interaction.guildId ?? request.guildId;
		const handlerUser = await resolveElimsUser(interaction.user.id, guildId);

		const [updatedRequest] = await db
			.update(elimsItemRequests)
			.set({
				status: newStatus,
				handledByDiscordId: interaction.user.id,
				handledByUsername: interaction.user.username,
				handledByTornId: handlerUser?.tornId ?? null,
				handledByTornName: handlerUser?.tornName ?? null,
				handledAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(elimsItemRequests.id, requestId))
			.returning();

		const statusLabel = isAccept ? "APPROVED" : "REJECTED";
		const statusColor = isAccept ? 0x10b981 : 0xf43f5e; // Emerald vs Rose

		// Update message embed & disable approve/reject buttons
		const existingEmbed = interaction.message.embeds[0];
		if (!existingEmbed) return;

		const updatedEmbed = EmbedBuilder.from(existingEmbed)
			.setColor(statusColor)
			.addFields({
				name: "Resolution",
				value: `${statusLabel} by <@${interaction.user.id}> at <t:${Math.floor(Date.now() / 1000)}:R>`,
				inline: false,
			})
			.setFooter({
				text: `Request ID: #${shortId} • Status: ${statusLabel}${updatedRequest?.isTest ? " (TEST)" : ""}`,
			});

		// Keep only test button or disable all
		const testBtn = new ButtonBuilder()
			.setCustomId(`elims_grant_test:${request.id}`)
			.setLabel(request.isTest ? "Unmark Test" : "Mark as Test")
			.setStyle(ButtonStyle.Secondary);

		const updatedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			testBtn,
		);

		await interaction.update({
			embeds: [updatedEmbed],
			components: [updatedRow],
		});

		// DM Notification to Requester (No Emojis!)
		try {
			const requesterUser = await interaction.client.users
				.fetch(request.discordUserId)
				.catch(() => null);
			if (requesterUser) {
				const dmEmbed = isAccept
					? createSuccessEmbed(
							"Item Request Approved",
							`Your request for **${request.quantity}x ${request.itemName}** has been approved.`,
						)
					: createErrorEmbed(
							"Item Request Rejected",
							`Your request for **${request.quantity}x ${request.itemName}** has been rejected.`,
						);

				dmEmbed.setFooter({ text: `Request #${shortId} • Sentinel` });

				const dmSent = await requesterUser
					.send({ embeds: [dmEmbed] })
					.then(() => true)
					.catch(() => false);
				if (dmSent) {
					await db
						.update(elimsItemRequests)
						.set({ dmSent: true })
						.where(eq(elimsItemRequests.id, requestId));
				}
			}
		} catch (err) {
			logger.warn(
				`Could not deliver DM to user ${request.discordUserId}:`,
				err,
			);
		}
	} catch (err) {
		logger.error("Error in handleItemGrantingButton:", err);
	}
}
