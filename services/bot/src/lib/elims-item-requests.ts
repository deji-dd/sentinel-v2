import {
	and,
	asc,
	db,
	deductHolderStock,
	type ElimsItemRequestConfig,
	elimsItemRequests,
	eq,
	getArmoryStock,
	getStockHolders,
	ne,
	or,
	systemStates,
} from "@sentinel/database";
import type {
	ResolvedElimsUser,
	UserCompetitionElimination,
} from "@sentinel/schemas";
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
import { syncElimsStockHoldersChannel } from "./elims-stock-holders";
import { buildVerificationReminderMessage } from "./elims-verification-reminder";
import {
	createBaseEmbed,
	createErrorEmbed,
	createSuccessEmbed,
	EMBED_COLORS,
} from "./embeds";
import { sendElimsUserResolutionRequest } from "./ipc/server";
import { logger } from "./logger";
import {
	parseSingleSentLog,
	validateSentLogAgainstRequest,
} from "./torn-log-parser";

const ELIMS_CONFIG_ID = "elims:guild_config";
const ELIMS_ITEM_REQUESTS_CONFIG_ID = "elims:item_requests_config";

export const XANAX_ITEM_ID = "206";
const XANAX_REGEX = /\bxanax\b/i;
const XANAX_HOURS_PER_ITEM = 6;
const MS_PER_HOUR = 60 * 60 * 1000;
const XANAX_COOLDOWN_PER_ITEM_MS = XANAX_HOURS_PER_ITEM * MS_PER_HOUR;

export function isXanaxItem(itemId: string, itemName?: string): boolean {
	if (itemId === XANAX_ITEM_ID) return true;
	if (itemName && XANAX_REGEX.test(itemName)) return true;
	return false;
}

export interface XanaxCooldownStatus {
	isOnCooldown: boolean;
	cooldownExpiresAt?: Date;
	remainingMs?: number;
	totalXanaxInCooldownWindow?: number;
}

/**
 * Calculates the active Xanax cooldown for a user based on their approved Xanax requests.
 * Every approved Xanax imposes a 6-hour cooldown (e.g. 3 Xanax = 18 hours).
 * Applies retroactively to all past accepted requests.
 */
export async function getXanaxCooldownStatus(params: {
	guildId: string;
	discordUserId: string;
	tornId?: number | null;
	isTest?: boolean;
	now?: Date;
}): Promise<XanaxCooldownStatus> {
	const userCondition = params.tornId
		? or(
				eq(elimsItemRequests.discordUserId, params.discordUserId),
				eq(elimsItemRequests.tornId, params.tornId),
			)
		: eq(elimsItemRequests.discordUserId, params.discordUserId);

	const approvedRequests = await db
		.select({
			id: elimsItemRequests.id,
			quantity: elimsItemRequests.quantity,
			handledAt: elimsItemRequests.handledAt,
			updatedAt: elimsItemRequests.updatedAt,
			createdAt: elimsItemRequests.createdAt,
			itemId: elimsItemRequests.itemId,
			itemName: elimsItemRequests.itemName,
		})
		.from(elimsItemRequests)
		.where(
			and(
				eq(elimsItemRequests.guildId, params.guildId),
				userCondition,
				eq(elimsItemRequests.status, "accepted"),
				eq(elimsItemRequests.isTest, params.isTest ?? false),
			),
		)
		.orderBy(
			asc(elimsItemRequests.handledAt),
			asc(elimsItemRequests.updatedAt),
			asc(elimsItemRequests.createdAt),
		);

	const nowMs = (params.now ?? new Date()).getTime();
	let currentCooldownEnd = 0;
	let totalXanaxCounted = 0;

	for (const req of approvedRequests) {
		if (!isXanaxItem(req.itemId, req.itemName)) {
			continue;
		}

		// Fallback chain ensures historical requests before this update are covered
		const approvalTime = (
			req.handledAt ??
			req.updatedAt ??
			req.createdAt
		).getTime();
		const quantity = req.quantity;
		const cooldownDurationMs = quantity * XANAX_COOLDOWN_PER_ITEM_MS;

		const start = Math.max(approvalTime, currentCooldownEnd);
		currentCooldownEnd = start + cooldownDurationMs;
		totalXanaxCounted += quantity;
	}

	if (currentCooldownEnd > nowMs) {
		const remainingMs = currentCooldownEnd - nowMs;
		return {
			isOnCooldown: true,
			cooldownExpiresAt: new Date(currentCooldownEnd),
			remainingMs,
			totalXanaxInCooldownWindow: totalXanaxCounted,
		};
	}

	return {
		isOnCooldown: false,
	};
}

export type { ResolvedElimsUser, UserCompetitionElimination };

/**
 * Computes unified item history (approved or rejected) for a requester in a guild.
 * Combines quantities of the same item into unified totals (e.g. 10x Xanax instead of 5x Xanax, 5x Xanax).
 */
export async function getRequesterHistory(
	guildId: string,
	discordUserId: string,
	status: "accepted" | "rejected",
	isTest = false,
	currentRequestId?: string,
): Promise<{ fieldName: string; fieldValue: string }> {
	const conditions = [
		eq(elimsItemRequests.guildId, guildId),
		eq(elimsItemRequests.discordUserId, discordUserId),
		eq(elimsItemRequests.status, status),
		eq(elimsItemRequests.isTest, isTest),
	];

	if (currentRequestId) {
		conditions.push(ne(elimsItemRequests.id, currentRequestId));
	}

	const requests = await db
		.select({
			itemName: elimsItemRequests.itemName,
			quantity: elimsItemRequests.quantity,
		})
		.from(elimsItemRequests)
		.where(and(...conditions));

	const fieldName =
		status === "accepted" ? "Approved History" : "Rejected History";

	if (requests.length === 0) {
		return {
			fieldName,
			fieldValue: "None",
		};
	}

	const itemTotals = new Map<
		string,
		{ displayName: string; quantity: number }
	>();
	let totalAmount = 0;

	for (const req of requests) {
		const key = req.itemName.trim().toLowerCase();
		const existing = itemTotals.get(key);
		if (existing) {
			existing.quantity += req.quantity;
		} else {
			itemTotals.set(key, {
				displayName: req.itemName.trim(),
				quantity: req.quantity,
			});
		}
		totalAmount += req.quantity;
	}

	const lines: string[] = [];
	for (const { displayName, quantity } of itemTotals.values()) {
		lines.push(`• **${quantity.toLocaleString()}x** ${displayName}`);
	}
	lines.push(
		`**Total**: ${totalAmount.toLocaleString()} ${totalAmount === 1 ? "item" : "items"}`,
	);

	let fieldValue = lines.join("\n");
	if (fieldValue.length > 1024) {
		fieldValue = `${fieldValue.slice(0, 1020)}...`;
	}

	return {
		fieldName,
		fieldValue,
	};
}

/**
 * Computes unified approved item history for a requester in a guild.
 * Combines quantities of the same item into unified totals (e.g. 10x Xanax instead of 5x Xanax, 5x Xanax).
 */
export async function getRequesterApprovedHistory(
	guildId: string,
	discordUserId: string,
	isTest = false,
	currentRequestId?: string,
): Promise<{ fieldName: string; fieldValue: string }> {
	return getRequesterHistory(
		guildId,
		discordUserId,
		"accepted",
		isTest,
		currentRequestId,
	);
}

/**
 * Computes unified rejected item history for a requester in a guild.
 * Combines quantities of the same item into unified totals.
 */
export async function getRequesterRejectedHistory(
	guildId: string,
	discordUserId: string,
	isTest = false,
	currentRequestId?: string,
): Promise<{ fieldName: string; fieldValue: string }> {
	return getRequesterHistory(
		guildId,
		discordUserId,
		"rejected",
		isTest,
		currentRequestId,
	);
}

/**
 * Resolves a Discord user's live Torn identity, competition stats, and networth.
 * Delegates the lookup to the scheduler worker engine over IPC.
 */
export async function resolveElimsUser(
	discordId: string,
	guildId: string,
): Promise<ResolvedElimsUser | null> {
	return sendElimsUserResolutionRequest(discordId, guildId);
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

		embed.setFields({
			name: "Instructions",
			value:
				"Click **Request Items** below to submit a tournament supply request.",
			inline: false,
		});

		const requestButton = new ButtonBuilder()
			.setCustomId("elims_request_open")
			.setLabel("Request Items")
			.setStyle(ButtonStyle.Primary);

		const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			requestButton,
		);

		// Find any existing "Item Requests" embed messages from the bot in this channel
		const recentMessages = await channel.messages
			.fetch({ limit: 50 })
			.catch(() => null);

		const botItemRequestMessages = recentMessages
			? Array.from(recentMessages.values()).filter(
					(m) =>
						m.author.id === client.user?.id &&
						m.embeds.some((e) => e.title?.includes("Item Requests")),
				)
			: [];

		// Target message: config.embedMessageId if found, else newest message in channel
		const targetMessage = config.embedMessageId
			? (botItemRequestMessages.find((m) => m.id === config.embedMessageId) ??
				(await channel.messages.fetch(config.embedMessageId).catch(() => null)))
			: (botItemRequestMessages[0] ?? null);

		// Clean up any extra duplicate embeds in the channel to prevent flooding
		for (const msg of botItemRequestMessages) {
			if (targetMessage && msg.id !== targetMessage.id) {
				await msg.delete().catch(() => {});
			}
		}

		let activeMessageId = targetMessage?.id;

		if (targetMessage) {
			await targetMessage.edit({
				embeds: [embed],
				components: [actionRow],
			});
		} else {
			const sent = await channel.send({
				embeds: [embed],
				components: [actionRow],
			});
			activeMessageId = sent.id;
		}

		// Save message ID to config if new or changed
		if (activeMessageId && activeMessageId !== config.embedMessageId) {
			const updatedConfig: ElimsItemRequestConfig = {
				...config,
				embedMessageId: activeMessageId,
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

		const activeItems = config?.allowedItems?.filter((i) => !i.disabled) ?? [];
		if (!config || activeItems.length === 0) {
			const embed = createErrorEmbed(
				"Item Requests Unavailable",
				"Item requests are currently not configured or no items are available for request.",
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (config.blacklistedUserIds?.includes(interaction.user.id)) {
			const embed = createErrorEmbed(
				"Access Denied",
				"You have been blacklisted from requesting items.",
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
			new Set(activeItems.map((i) => i.category || "General")),
		).slice(0, 25);

		const selectMenu = new StringSelectMenuBuilder()
			.setCustomId("elims_category_select:live")
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

		const itemsInCategory = (config.allowedItems ?? [])
			.filter(
				(i) => !i.disabled && (i.category || "General") === selectedCategory,
			)
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
			.setCustomId("elims_item_select:live")
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
 * Checks if a user already has an active pending request for a given item.
 * Matches on Discord User ID or verified Torn ID.
 */
export async function hasPendingItemRequest(params: {
	guildId: string;
	discordUserId: string;
	itemId: string;
	tornId?: number | null;
	isTest?: boolean;
}): Promise<{ hasPending: boolean; existingRequestId?: string }> {
	const userCondition = params.tornId
		? or(
				eq(elimsItemRequests.discordUserId, params.discordUserId),
				eq(elimsItemRequests.tornId, params.tornId),
			)
		: eq(elimsItemRequests.discordUserId, params.discordUserId);

	const [existing] = await db
		.select({ id: elimsItemRequests.id })
		.from(elimsItemRequests)
		.where(
			and(
				eq(elimsItemRequests.guildId, params.guildId),
				userCondition,
				eq(elimsItemRequests.itemId, params.itemId),
				eq(elimsItemRequests.status, "pending"),
				eq(elimsItemRequests.isTest, params.isTest ?? false),
			),
		)
		.limit(1);

	if (existing) {
		return { hasPending: true, existingRequestId: existing.id };
	}

	return { hasPending: false };
}

/**
 * Handles Item StringSelectMenu selection -> displays Discord Modal for quantity.
 */
export async function handleItemRequestItemSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	try {
		const selectedItemId = interaction.values[0];
		if (!selectedItemId || !interaction.guildId) return;

		const [reqState] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
		const config = reqState?.data as unknown as ElimsItemRequestConfig | null;

		if (config?.blacklistedUserIds?.includes(interaction.user.id)) {
			const embed = createErrorEmbed(
				"Access Denied",
				"You have been blacklisted from requesting items.",
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const selectedItem = config?.allowedItems.find(
			(i) => i.id === selectedItemId && !i.disabled,
		);
		if (!selectedItem) {
			const embed = createErrorEmbed(
				"Item Unavailable",
				"The selected item is disabled or no longer available for request.",
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
		const itemName = selectedItem.name ?? "Item";

		// Guard: Reject if user already has an active pending request for this item
		const pendingCheck = await hasPendingItemRequest({
			guildId: interaction.guildId,
			discordUserId: interaction.user.id,
			itemId: selectedItemId,
		});

		if (pendingCheck.hasPending) {
			const reqTag = pendingCheck.existingRequestId
				? ` (Request #${pendingCheck.existingRequestId.slice(0, 8)})`
				: "";
			const embed = createErrorEmbed(
				"Pending Request Exists",
				`You already have a pending request for **${itemName}**${reqTag}.\n\nPlease wait for your existing request to be reviewed before requesting this item again.`,
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Guard: 6-hour cooldown per approved item for Xanax
		if (isXanaxItem(selectedItem.id, selectedItem.name)) {
			const resolvedUser = await resolveElimsUser(
				interaction.user.id,
				interaction.guildId,
			);
			const cooldownCheck = await getXanaxCooldownStatus({
				guildId: interaction.guildId,
				discordUserId: interaction.user.id,
				tornId: resolvedUser?.tornId ?? null,
			});

			if (cooldownCheck.isOnCooldown && cooldownCheck.cooldownExpiresAt) {
				const expiresTimestamp = Math.floor(
					cooldownCheck.cooldownExpiresAt.getTime() / 1000,
				);
				const embed = createErrorEmbed(
					"Xanax Cooldown Active",
					`You cannot request **${itemName}** right now.\n\n` +
						`Each approved Xanax incurs a **6-hour cooldown** before you can submit another request.\n\n` +
						`• **Available Again**: <t:${expiresTimestamp}:F> (<t:${expiresTimestamp}:R>)\n\n` +
						`Please wait until your cooldown expires before requesting Xanax again.`,
				);
				await interaction.reply({
					embeds: [embed],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
		}

		const maxNote = selectedItem.maxRequestable
			? ` (Max: ${selectedItem.maxRequestable})`
			: "";

		const modal = new ModalBuilder()
			.setCustomId(`elims_request_modal:${selectedItemId}`)
			.setTitle(`Request ${itemName.slice(0, 30)}`);

		const quantityInput = new TextInputBuilder()
			.setCustomId("quantity")
			.setLabel(`Quantity Needed${maxNote}`.slice(0, 45))
			.setStyle(TextInputStyle.Short)
			.setPlaceholder(
				selectedItem?.maxRequestable
					? `e.g. 5 (Max allowed: ${selectedItem.maxRequestable})`
					: "e.g. 5",
			)
			.setMinLength(1)
			.setMaxLength(6)
			.setRequired(true);

		const reasonInput = new TextInputBuilder()
			.setCustomId("reason")
			.setLabel("Reason / Notes (Optional)")
			.setStyle(TextInputStyle.Paragraph)
			.setPlaceholder("e.g. For war match / target: Team 4")
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

		if (config?.blacklistedUserIds?.includes(interaction.user.id)) {
			const embed = createErrorEmbed(
				"Access Denied",
				"You have been blacklisted from requesting items.",
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const item = config?.allowedItems.find(
			(i) => i.id === itemId && !i.disabled,
		);
		if (!item) {
			const embed = createErrorEmbed(
				"Item Unavailable",
				"The requested item is disabled or no longer available in the whitelist.",
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (item.maxRequestable && quantity > item.maxRequestable) {
			const embed = createErrorEmbed(
				"Quantity Exceeds Limit",
				`The maximum requestable quantity for **${item.name}** is **${item.maxRequestable}**. You requested **${quantity}**.\n\nPlease submit a request within the allowed limit.`,
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const isTest = false;

		// Resolve Torn user details if verified via Elims DB or guild key live call
		const resolvedUser = await resolveElimsUser(
			interaction.user.id,
			interaction.guildId,
		);

		// Guard: Reject if user already has an active pending request for this item
		const pendingCheck = await hasPendingItemRequest({
			guildId: interaction.guildId,
			discordUserId: interaction.user.id,
			itemId: item.id,
			tornId: resolvedUser?.tornId ?? null,
			isTest,
		});

		if (pendingCheck.hasPending) {
			const reqTag = pendingCheck.existingRequestId
				? ` (Request #${pendingCheck.existingRequestId.slice(0, 8)})`
				: "";
			const embed = createErrorEmbed(
				"Pending Request Exists",
				`You already have a pending request for **${item.name}**${reqTag}.\n\nPlease wait for your existing request to be reviewed before submitting another request for this item.`,
			);
			await interaction.reply({
				embeds: [embed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Guard: 6-hour cooldown per approved item for Xanax
		if (isXanaxItem(item.id, item.name)) {
			const cooldownCheck = await getXanaxCooldownStatus({
				guildId: interaction.guildId,
				discordUserId: interaction.user.id,
				tornId: resolvedUser?.tornId ?? null,
			});

			if (cooldownCheck.isOnCooldown && cooldownCheck.cooldownExpiresAt) {
				const expiresTimestamp = Math.floor(
					cooldownCheck.cooldownExpiresAt.getTime() / 1000,
				);
				const embed = createErrorEmbed(
					"Xanax Cooldown Active",
					`You cannot request **${item.name}** right now.\n\n` +
						`Each approved Xanax incurs a **6-hour cooldown** before you can submit another request.\n\n` +
						`• **Available Again**: <t:${expiresTimestamp}:F> (<t:${expiresTimestamp}:R>)\n\n` +
						`Please wait until your cooldown expires before requesting Xanax again.`,
				);
				await interaction.reply({
					embeds: [embed],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
		}

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
				isTest,
				reason,
				metadata: {
					competition: resolvedUser?.competition ?? null,
					networth: resolvedUser?.networth ?? null,
				},
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
				const [approvedHistory, rejectedHistory, stockMap] = await Promise.all([
					getRequesterApprovedHistory(
						interaction.guildId,
						interaction.user.id,
						isTest,
						createdRequest.id,
					),
					getRequesterRejectedHistory(
						interaction.guildId,
						interaction.user.id,
						isTest,
						createdRequest.id,
					),
					getArmoryStock(interaction.guildId, isTest),
				]);

				const itemStock =
					stockMap.get(item.id) ?? stockMap.get(item.name.trim().toLowerCase());
				const availableStock = itemStock?.available ?? 0;

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
							name: "Torn Profile",
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
						{
							name: "In Stock",
							value: `**${availableStock.toLocaleString()}** left`,
							inline: true,
						},
					);

				if (resolvedUser?.competition) {
					grantEmbed.addFields({
						name: "Score & Attacks",
						value: `Score: **${resolvedUser.competition.score.toLocaleString()}** • Attacks: **${resolvedUser.competition.attacks.toLocaleString()}**`,
						inline: true,
					});
				}

				if (
					resolvedUser?.networth !== null &&
					resolvedUser?.networth !== undefined
				) {
					grantEmbed.addFields({
						name: "Networth",
						value: `$${resolvedUser.networth.toLocaleString()}`,
						inline: true,
					});
				}

				if (reason) {
					grantEmbed.addFields({
						name: "Reason",
						value: reason,
						inline: false,
					});
				}

				grantEmbed.addFields(
					{
						name: approvedHistory.fieldName,
						value: approvedHistory.fieldValue,
						inline: true,
					},
					{
						name: rejectedHistory.fieldName,
						value: rejectedHistory.fieldValue,
						inline: true,
					},
				);

				grantEmbed.setFooter({
					text: `Sentinel`,
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

				const grantRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
					approveBtn,
					rejectBtn,
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
				(reason ? `\n**Reason**: ${reason}` : ""),
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
 * Handles Approve / Reject buttons in the Granting Channel.
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

		if (actionType === "elims_grant_reject") {
			const modal = new ModalBuilder()
				.setCustomId(`elims_grant_reject_modal:${requestId}`)
				.setTitle("Reject Item Request");

			const reasonInput = new TextInputBuilder()
				.setCustomId("rejection_reason")
				.setLabel("Reason for Rejection")
				.setStyle(TextInputStyle.Paragraph)
				.setPlaceholder("Optional reason for rejecting this request...")
				.setRequired(false)
				.setMaxLength(500);

			const row = new ActionRowBuilder<TextInputBuilder>().addComponents(
				reasonInput,
			);
			modal.addComponents(row);

			await interaction.showModal(modal);
			return;
		}

		if (actionType === "elims_grant_accept") {
			const guildId = interaction.guildId ?? request.guildId;

			// If Stock Holders channel is configured, approver MUST hold enough stock in their personal custody
			if (config?.stockHoldersChannelId) {
				const holders = await getStockHolders(
					guildId,
					request.isTest,
					request.itemId,
				);
				const holder = holders.find(
					(h) => h.discordUserId === interaction.user.id,
				);
				const heldQuantity = holder?.quantity ?? 0;

				if (!holder || heldQuantity < request.quantity) {
					const embed = createErrorEmbed(
						"Insufficient Holder Stock",
						`Cannot approve request for **${request.quantity.toLocaleString()}x ${request.itemName}**.\n\n` +
							`• **You Currently Hold:** ${heldQuantity.toLocaleString()} item(s)\n` +
							`• **Requested:** ${request.quantity.toLocaleString()} item(s)\n\n` +
							(!holder
								? `You are not registered as a stock holder for this item. Please have an armory manager assign stock to you in the Stock Holders channel.`
								: `You need **${(request.quantity - heldQuantity).toLocaleString()} more** of this item assigned to you before you can approve this request.`),
					);
					await interaction.reply({
						embeds: [embed],
						flags: MessageFlags.Ephemeral,
					});
					return;
				}
			} else {
				const stockMap = await getArmoryStock(guildId, request.isTest);
				const itemStock =
					stockMap.get(request.itemId) ??
					stockMap.get(request.itemName.trim().toLowerCase());
				const availableStock = itemStock?.available ?? 0;

				if (availableStock < request.quantity) {
					const missing = request.quantity - availableStock;
					const embed = createErrorEmbed(
						"Insufficient Storage Stock",
						`Cannot approve request for **${request.quantity.toLocaleString()}x ${request.itemName}**.\n\n` +
							`• **In Storage:** ${availableStock.toLocaleString()}\n` +
							`• **Requested:** ${request.quantity.toLocaleString()}\n` +
							`• **Missing:** ${missing.toLocaleString()} item(s)\n\n` +
							`Please wait for more deposits to be logged before approving this request.`,
					);
					await interaction.reply({
						embeds: [embed],
						flags: MessageFlags.Ephemeral,
					});
					return;
				}
			}
		}

		// Acknowledge interaction immediately to prevent Discord client timeout rollback
		await interaction.deferUpdate();

		const guildId = interaction.guildId ?? request.guildId;

		if (actionType === "elims_grant_accept") {
			if (config?.stockHoldersChannelId) {
				await deductHolderStock({
					guildId,
					discordUserId: interaction.user.id,
					itemId: request.itemId,
					quantity: request.quantity,
					isTest: request.isTest,
				});
				void syncElimsStockHoldersChannel(interaction.client, guildId);
			}

			await resolveItemRequest({
				request,
				status: "accepted",
				handlerDiscordId: interaction.user.id,
				handlerUsername: interaction.user.username,
				guildId,
				interaction,
			});
		}
	} catch (err) {
		logger.error("Error in handleItemGrantingButton:", err);
	}
}

interface ResolveItemRequestParams {
	request: typeof elimsItemRequests.$inferSelect;
	status: "accepted" | "rejected";
	handlerDiscordId: string;
	handlerUsername: string;
	guildId: string;
	rejectionReason?: string | null;
	interaction: ButtonInteraction | ModalSubmitInteraction;
}

async function resolveItemRequest({
	request,
	status,
	handlerDiscordId,
	handlerUsername,
	guildId,
	rejectionReason,
	interaction,
}: ResolveItemRequestParams): Promise<void> {
	const isAccept = status === "accepted";
	const handlerUser = await resolveElimsUser(handlerDiscordId, guildId);

	const metadata = (request.metadata as Record<string, unknown> | null) ?? {};
	if (rejectionReason) {
		metadata.rejectionReason = rejectionReason;
	}

	const [_] = await db
		.update(elimsItemRequests)
		.set({
			status,
			verificationStatus: isAccept ? "pending_verification" : "none",
			handledByDiscordId: handlerDiscordId,
			handledByUsername: handlerUsername,
			handledByTornId: handlerUser?.tornId ?? null,
			handledByTornName: handlerUser?.tornName ?? null,
			handledAt: new Date(),
			updatedAt: new Date(),
			metadata,
		})
		.where(eq(elimsItemRequests.id, request.id))
		.returning();

	const statusLabel = isAccept
		? "APPROVED (Awaiting Verification)"
		: "REJECTED";
	const statusColor = isAccept ? 0x0284c7 : 0xf43f5e; // Sky Blue (Awaiting Verification) vs Rose

	const handlerTornProfile = handlerUser
		? `[${handlerUser.tornName} [${handlerUser.tornId}]](https://www.torn.com/profiles.php?XID=${handlerUser.tornId})`
		: "Not verified";

	let existingEmbed = interaction.message?.embeds[0];
	let channelMessage = interaction.message;

	if (!existingEmbed && request.grantingMessageId) {
		const channel = interaction.channel;
		if (channel && "messages" in channel) {
			channelMessage = await channel.messages
				.fetch(request.grantingMessageId)
				.catch(() => null);
			existingEmbed = channelMessage?.embeds[0];
		}
	}

	if (existingEmbed) {
		const updatedEmbed = EmbedBuilder.from(existingEmbed);

		const hasApprovedHistory = existingEmbed.fields.some((f) =>
			f.name.startsWith("Approved History"),
		);
		const hasRejectedHistory = existingEmbed.fields.some((f) =>
			f.name.startsWith("Rejected History"),
		);
		if (!hasApprovedHistory) {
			const history = await getRequesterApprovedHistory(
				guildId,
				request.discordUserId,
				request.isTest,
				request.id,
			);
			updatedEmbed.addFields({
				name: history.fieldName,
				value: history.fieldValue,
				inline: true,
			});
		}
		if (!hasRejectedHistory) {
			const rejHistory = await getRequesterRejectedHistory(
				guildId,
				request.discordUserId,
				request.isTest,
				request.id,
			);
			updatedEmbed.addFields({
				name: rejHistory.fieldName,
				value: rejHistory.fieldValue,
				inline: true,
			});
		}

		updatedEmbed.setColor(statusColor).addFields(
			{
				name: "Resolution",
				value: `${statusLabel} by <@${handlerDiscordId}> at <t:${Math.floor(Date.now() / 1000)}:R>`,
				inline: true,
			},
			{
				name: "Handled By",
				value: handlerTornProfile,
				inline: true,
			},
		);

		if (rejectionReason) {
			updatedEmbed.addFields({
				name: "Rejection Reason",
				value: rejectionReason,
				inline: false,
			});
		}

		updatedEmbed.setFooter({
			text: `Sentinel`,
		});

		try {
			await interaction.editReply({
				embeds: [updatedEmbed],
				components: [],
			});
		} catch {
			if (channelMessage) {
				await channelMessage.edit({
					embeds: [updatedEmbed],
					components: [],
				});
			}
		}
	}

	// 2-Stage Verification: Send DM to approver if approved
	if (isAccept) {
		try {
			const approverUser = await interaction.client.users
				.fetch(handlerDiscordId)
				.catch(() => null);
			if (approverUser) {
				const { embed: verifyEmbed, row: verifyRow } =
					buildVerificationReminderMessage({
						id: request.id,
						itemName: request.itemName,
						quantity: request.quantity,
						tornName: request.tornName,
						tornId: request.tornId,
						handledAt: new Date(),
						createdAt: request.createdAt,
						isTest: request.isTest,
					});

				await approverUser
					.send({ embeds: [verifyEmbed], components: [verifyRow] })
					.catch((err) => {
						logger.warn(
							`Could not send verification DM to approver ${handlerDiscordId}:`,
							err,
						);
					});
			}
		} catch (err) {
			logger.warn("Error sending verification DM to approver:", err);
		}
	}

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

			dmEmbed.setFooter({ text: `Sentinel` });

			if (!isAccept && rejectionReason) {
				dmEmbed.addFields({
					name: "Rejection Reason",
					value: rejectionReason,
					inline: false,
				});
			}

			if (request.reason) {
				dmEmbed.addFields({
					name: isAccept ? "Reason" : "Your Notes",
					value: request.reason,
					inline: false,
				});
			}

			const dmSent = await requesterUser
				.send({ embeds: [dmEmbed] })
				.then(() => true)
				.catch(() => false);
			if (dmSent) {
				await db
					.update(elimsItemRequests)
					.set({ dmSent: true })
					.where(eq(elimsItemRequests.id, request.id));
			}
		}
	} catch (err) {
		logger.warn(`Could not deliver DM to user ${request.discordUserId}:`, err);
	}
}

/**
 * Handles submission of the rejection reason modal when an officer rejects an item request.
 */
export async function handleItemGrantRejectModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	try {
		const requestId = interaction.customId.split(":")[1];
		if (!requestId) return;

		await interaction.deferUpdate();

		const rejectionReason =
			interaction.fields.getTextInputValue("rejection_reason").trim() || null;

		const [request] = await db
			.select()
			.from(elimsItemRequests)
			.where(eq(elimsItemRequests.id, requestId));

		if (!request) return;

		if (request.status !== "pending") {
			return;
		}

		const guildId = interaction.guildId ?? request.guildId;
		await resolveItemRequest({
			request,
			status: "rejected",
			handlerDiscordId: interaction.user.id,
			handlerUsername: interaction.user.username,
			guildId,
			rejectionReason,
			interaction,
		});
	} catch (err) {
		logger.error("Error in handleItemGrantRejectModalSubmit:", err);
	}
}

/**
 * Handles clicking "Verify Send (Paste Log)" in an approver's DM.
 */
export async function handleItemVerifySendButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const requestId = interaction.customId.split(":")[1];
		if (!requestId) return;

		const modal = new ModalBuilder()
			.setCustomId(`elims_verify_send_modal:${requestId}`)
			.setTitle("Verify Sent Items");

		const logInput = new TextInputBuilder()
			.setCustomId("sent_log_text")
			.setLabel("Torn Sent Event Log")
			.setStyle(TextInputStyle.Paragraph)
			.setPlaceholder(
				"e.g.: 16:12:24 - 08/09/26 You sent 3x Xanax to Fahquetu with the message: Prelicked",
			)
			.setRequired(true)
			.setMaxLength(1000);

		const row = new ActionRowBuilder<TextInputBuilder>().addComponents(
			logInput,
		);
		modal.addComponents(row);

		await interaction.showModal(modal);
	} catch (err) {
		logger.error("Error in handleItemVerifySendButton:", err);
	}
}

/**
 * Handles submission of the "Verify Sent Items" modal by an approver.
 */
export async function handleItemVerifySendModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	try {
		const requestId = interaction.customId.split(":")[1];
		if (!requestId) return;

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const rawLog = interaction.fields.getTextInputValue("sent_log_text").trim();
		const parsed = parseSingleSentLog(rawLog);

		if (!parsed) {
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						"Invalid Sent Log",
						"Could not parse a valid Torn sent log. Example formats:\n" +
							"• `16:12:24 - 08/09/26 You sent 3x Xanax to Fahquetu with the message: Prelicked`\n" +
							"• `04:37:52 - 04/09/26 You sent 5x Flash Grenade to Fahquetu`\n" +
							"• `You sent a Business Class Ticket to BabyLuST`",
					),
				],
			});
			return;
		}

		const [request] = await db
			.select()
			.from(elimsItemRequests)
			.where(eq(elimsItemRequests.id, requestId));

		if (!request) {
			await interaction.editReply({
				embeds: [createErrorEmbed("Not Found", "Item request was not found.")],
			});
			return;
		}

		// Validate against request (case-sensitive recipient name check & timestamp verification)
		const validation = validateSentLogAgainstRequest(parsed, {
			recipientTornName: request.tornName ?? "",
			recipientTornId: request.tornId,
			itemName: request.itemName,
			quantity: request.quantity,
			requestCreatedAt: request.createdAt,
		});

		if (!validation.isValid) {
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						"Verification Mismatch",
						validation.error ?? "Log details did not match this request.",
					),
				],
			});
			return;
		}

		// Update database: verified!
		await db
			.update(elimsItemRequests)
			.set({
				verificationStatus: "verified",
				verifiedAt: new Date(),
				verifiedByDiscordId: interaction.user.id,
				verificationLog: parsed.rawLog,
				updatedAt: new Date(),
			})
			.where(eq(elimsItemRequests.id, requestId));

		// Update DM message if possible
		if (interaction.message) {
			const successEmbed = createSuccessEmbed(
				"Transfer Verified",
				`Transfer of **${request.quantity}x ${request.itemName}** to **${request.tornName}** was successfully verified!\n\n` +
					`**Verified Log:**\n\`${parsed.rawLog}\``,
			);
			await interaction.message
				.edit({ embeds: [successEmbed], components: [] })
				.catch(() => {});
		}

		// Update Granting Channel Embed
		if (request.grantingMessageId) {
			try {
				const [state] = await db
					.select()
					.from(systemStates)
					.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
				const config = state?.data as unknown as ElimsItemRequestConfig | null;

				if (config?.grantingChannelId) {
					const channel = await interaction.client.channels
						.fetch(config.grantingChannelId)
						.catch(() => null);
					if (channel instanceof TextChannel) {
						const grantMsg = await channel.messages
							.fetch(request.grantingMessageId)
							.catch(() => null);
						if (grantMsg?.embeds[0]) {
							const updated = EmbedBuilder.from(grantMsg.embeds[0])
								.setColor(0x10b981) // Emerald for verified
								.addFields({
									name: "Verification",
									value: `Verified by <@${interaction.user.id}> at <t:${Math.floor(Date.now() / 1000)}:R>`,
									inline: false,
								});

							updated.setFooter({
								text: `Sentinel`,
							});

							await grantMsg.edit({ embeds: [updated] }).catch(() => {});
						}
					}
				}
			} catch (err) {
				logger.warn(
					"Could not update granting channel embed on verification:",
					err,
				);
			}
		}

		await interaction.editReply({
			embeds: [
				createSuccessEmbed(
					"Verified Successfully",
					`Transfer verified for request #${request.id.slice(0, 8)}.\n\nThank you!`,
				),
			],
		});
	} catch (err) {
		logger.error("Error in handleItemVerifySendModalSubmit:", err);
	}
}
