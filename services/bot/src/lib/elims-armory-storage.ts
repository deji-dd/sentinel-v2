import {
	and,
	db,
	type ElimsItemRequestConfig,
	elimsArmoryDeposits,
	eq,
	getArmoryStock,
	type ItemStock,
	or,
	sql,
	systemStates,
	tornItems,
	type WhitelistedItem,
} from "@sentinel/database";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type Client,
	EmbedBuilder,
	type Message,
	TextChannel,
} from "discord.js";
import { createErrorEmbed, createSuccessEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";
import { type ParsedDepositLog, parseDepositLogs } from "./torn-log-parser";

const ELIMS_ITEM_REQUESTS_CONFIG_ID = "elims:item_requests_config";
const ITEMS_PER_PAGE = 10;

export { getArmoryStock, type ItemStock };

interface UnifiedStockItem {
	id: string;
	name: string;
	category: string;
	deposited: number;
	consumed: number;
	available: number;
}

/**
 * Resolves item ID, canonical name, and Torn category for a given item name or ID.
 * Checks config whitelisted items first, then queries the tornItems database table.
 */
export async function resolveTornItem(
	rawItemName: string,
	allowedItems?: WhitelistedItem[],
): Promise<{ id: string; name: string; category: string }> {
	const trimmed = rawItemName.trim();
	const lower = trimmed.toLowerCase();

	// 1. Check configured allowedItems if present and has a valid specific category
	const whitelisted = allowedItems?.find(
		(i) =>
			i.id.toLowerCase() === lower || i.name.trim().toLowerCase() === lower,
	);
	if (whitelisted?.category && whitelisted.category !== "General") {
		return {
			id: whitelisted.id,
			name: whitelisted.name,
			category: whitelisted.category,
		};
	}

	// 2. Query tornItems database table
	try {
		const [row] = await db
			.select({
				id: tornItems.id,
				name: tornItems.name,
				data: tornItems.data,
			})
			.from(tornItems)
			.where(
				or(
					eq(tornItems.id, trimmed),
					sql<boolean>`LOWER(${tornItems.name}) = ${lower}`,
				),
			)
			.limit(1);

		if (row) {
			const data = (row.data ?? {}) as Record<string, unknown>;
			const rawType = (data.type ?? data.category ?? "General") as string;
			return {
				id: row.id,
				name: row.name ?? whitelisted?.name ?? trimmed,
				category: rawType || "General",
			};
		}
	} catch (err) {
		logger.warn(`Failed to query tornItems for "${rawItemName}":`, err);
	}

	// 3. Fallback to whitelisted item details or "external"/"General"
	return {
		id: whitelisted?.id ?? "external",
		name: whitelisted?.name ?? trimmed,
		category: whitelisted?.category ?? "General",
	};
}

/**
 * Builds the persistent storage channel embed showing armory instructions and live item stock.
 * Paginated to cleanly present all whitelisted and stocked items.
 */
export async function buildArmoryStorageEmbed(
	guildId: string,
	page = 1,
): Promise<{
	embed: EmbedBuilder;
	row: ActionRowBuilder<ButtonBuilder>;
}> {
	const [state] = await db
		.select()
		.from(systemStates)
		.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
	const config = state?.data as unknown as ElimsItemRequestConfig | undefined;

	const stockMap = guildId
		? await getArmoryStock(guildId, false)
		: new Map<string, ItemStock>();

	const allowedItems: WhitelistedItem[] = config?.allowedItems ?? [];
	const itemMap = new Map<string, UnifiedStockItem>();

	// Only return items that actually have available stock
	for (const stock of stockMap.values()) {
		if (stock.available <= 0) continue;

		// Match with configured items or query tornItems for category and canonical name
		const itemInfo = await resolveTornItem(stock.itemName, allowedItems);

		const resolvedId =
			stock.itemId && stock.itemId !== "external" ? stock.itemId : itemInfo.id;
		const resolvedCategory =
			stock.category && stock.category !== "General"
				? stock.category
				: itemInfo.category;

		const key = (resolvedId || itemInfo.name).trim().toLowerCase();
		itemMap.set(key, {
			id: resolvedId,
			name: itemInfo.name || stock.itemName,
			category: resolvedCategory || "General",
			deposited: stock.deposited,
			consumed: stock.consumed,
			available: stock.available,
		});
	}

	const allItems = Array.from(itemMap.values()).sort((a, b) => {
		if (a.category !== b.category) {
			return a.category.localeCompare(b.category);
		}
		return a.name.localeCompare(b.name);
	});

	const totalPages = Math.max(1, Math.ceil(allItems.length / ITEMS_PER_PAGE));
	const currentPage = Math.min(Math.max(1, page), totalPages);
	const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
	const pageItems = allItems.slice(startIndex, startIndex + ITEMS_PER_PAGE);

	const embed = new EmbedBuilder()
		.setTitle("Eliminations Armory")
		.setDescription(
			`**How to Deposit Items:**
Paste your Torn event log(s) **directly into this channel chat**! Sentinel will automatically record the deposit, update live stock, and post a confirmation receipt.

**Accepted Log Examples:**
• \`23:14:09 - 06/09/26 Lunette sent 2x Vicodin to you\`
• \`19:58:41 - 05/09/26 LinFeng sent a Parcel to you with the message: Adhesive Plastic - SED\`
• \`05:36:39 - 11/12/25 The-Don-Salieri traded 100x Flash Grenade, 150x Pepper Spray, 18x Xanax to you [view]\`
`,
		)
		.setColor(EMBED_COLORS.PRIMARY);

	if (pageItems.length === 0) {
		embed.addFields({
			name: "Inventory",
			value: "*No items currently in stock.*",
			inline: false,
		});
	} else {
		for (const item of pageItems) {
			embed.addFields({
				name: `${item.name} (${item.category})`,
				value: `Available: **${item.available.toLocaleString()}**  •  Deposited: ${item.deposited.toLocaleString()}  •  Issued: ${item.consumed.toLocaleString()}`,
				inline: false,
			});
		}
	}

	embed.setFooter({
		text: `Page ${currentPage} of ${totalPages} • Total Items: ${allItems.length} • Sentinel Armory`,
	});
	embed.setTimestamp(new Date());

	const prevBtn = new ButtonBuilder()
		.setCustomId(`elims_armory_stock_page:${currentPage - 1}`)
		.setLabel("◀ Previous")
		.setStyle(ButtonStyle.Primary)
		.setDisabled(currentPage <= 1);

	const indicatorBtn = new ButtonBuilder()
		.setCustomId("elims_armory_stock_noop")
		.setLabel(`Page ${currentPage}/${totalPages}`)
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(true);

	const nextBtn = new ButtonBuilder()
		.setCustomId(`elims_armory_stock_page:${currentPage + 1}`)
		.setLabel("Next ▶")
		.setStyle(ButtonStyle.Primary)
		.setDisabled(currentPage >= totalPages);

	const refreshBtn = new ButtonBuilder()
		.setCustomId(`elims_armory_stock_page:${currentPage}`)
		.setLabel("🔄 Refresh")
		.setStyle(ButtonStyle.Secondary);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		prevBtn,
		indicatorBtn,
		nextBtn,
		refreshBtn,
	);

	return { embed, row };
}

let isUpdatingArmoryChannel = false;
let pendingArmoryUpdate = false;
const resendTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedules a delayed (debounced) resend of the armory stock embed.
 * Default 10-second delay ensures multiple deposits or rapid chat logs
 * don't flicker or re-post repeatedly.
 */
export function scheduleArmoryStorageResend(
	client: Client,
	guildId: string,
	delayMs = 10000,
): void {
	const existing = resendTimers.get(guildId);
	if (existing) {
		clearTimeout(existing);
	}

	const timer = setTimeout(() => {
		resendTimers.delete(guildId);
		void updateElimsArmoryStorageChannel(client, guildId, { resend: true });
	}, delayMs);

	resendTimers.set(guildId, timer);
}

/**
 * Updates or resends the persistent armory storage embed in the configured storageChannelId.
 * When options.resend is true, deletes the previous stock embed and sends a new one at the bottom.
 */
export async function updateElimsArmoryStorageChannel(
	client: Client,
	guildId?: string,
	options?: { resend?: boolean; page?: number },
): Promise<void> {
	if (isUpdatingArmoryChannel) {
		pendingArmoryUpdate = true;
		return;
	}
	isUpdatingArmoryChannel = true;
	try {
		do {
			pendingArmoryUpdate = false;
			await performArmoryStorageChannelUpdate(client, guildId, options);
		} while (pendingArmoryUpdate);
	} finally {
		isUpdatingArmoryChannel = false;
	}
}

async function performArmoryStorageChannelUpdate(
	client: Client,
	guildId?: string,
	options?: { resend?: boolean; page?: number },
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

		const { embed, row } = await buildArmoryStorageEmbed(
			targetGuildId,
			options?.page ?? 1,
		);

		// If resend is requested (e.g. after deposits), delete the old embed so the new one sits at the bottom
		if (options?.resend) {
			if (config.storageEmbedMessageId) {
				const oldMsg = await channel.messages
					.fetch(config.storageEmbedMessageId)
					.catch(() => null);
				if (oldMsg) {
					await oldMsg.delete().catch(() => {});
				}
			}

			// Clean up any other duplicate armory stock embeds in the recent 25 messages
			const recent = await channel.messages
				.fetch({ limit: 25 })
				.catch(() => null);
			if (recent) {
				for (const msg of recent.values()) {
					if (
						msg.author.id === client.user?.id &&
						msg.embeds.some((e) => e.title?.includes("Stock Overview"))
					) {
						await msg.delete().catch(() => {});
					}
				}
			}

			const sent = await channel.send({
				embeds: [embed],
				components: [row],
			});

			const updatedConfig: ElimsItemRequestConfig = {
				...config,
				storageEmbedMessageId: sent.id,
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
			return;
		}

		// Non-resend path (startup/config edit): Edit in-place if possible
		const targetMessage = config.storageEmbedMessageId
			? await channel.messages
					.fetch(config.storageEmbedMessageId)
					.catch(() => null)
			: null;

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
 * Handles pagination buttons on the Armory Stock Overview embed.
 */
export async function handleArmoryStockPageButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const parts = interaction.customId.split(":");
		const targetPage = Number.parseInt(parts[1] ?? "1", 10) || 1;
		const guildId = interaction.guildId ?? "";

		const { embed, row } = await buildArmoryStorageEmbed(guildId, targetPage);
		await interaction.update({
			embeds: [embed],
			components: [row],
		});
	} catch (err) {
		logger.error("Error in handleArmoryStockPageButton:", err);
	}
}

/**
 * Detects if an identical deposit log has already been recorded in the database.
 * Matching criteria: same guildId, timestamp, donor name, item, and quantity.
 */
async function isDuplicateDeposit(
	guildId: string,
	parsed: ParsedDepositLog,
	resolvedItemName: string,
): Promise<boolean> {
	const donorLower = parsed.donorName.trim().toLowerCase();
	const itemLower = parsed.itemName.trim().toLowerCase();
	const resolvedLower = resolvedItemName.trim().toLowerCase();

	const conditions = [
		eq(elimsArmoryDeposits.guildId, guildId),
		eq(elimsArmoryDeposits.quantity, parsed.quantity),
		sql<boolean>`LOWER(${elimsArmoryDeposits.tornName}) = ${donorLower}`,
		sql<boolean>`(LOWER(${elimsArmoryDeposits.itemName}) = ${itemLower} OR LOWER(${elimsArmoryDeposits.itemName}) = ${resolvedLower})`,
	];

	if (parsed.timestamp) {
		conditions.push(eq(elimsArmoryDeposits.logTimestamp, parsed.timestamp));
	} else {
		conditions.push(eq(elimsArmoryDeposits.rawLog, parsed.rawLog));
	}

	const [existing] = await db
		.select({ id: elimsArmoryDeposits.id })
		.from(elimsArmoryDeposits)
		.where(and(...conditions))
		.limit(1);

	return Boolean(existing);
}

/**
 * Handles incoming chat messages in the armory storage channel.
 * Users paste Torn event logs directly into chat.
 *
 * 1. If text cannot be parsed:
 *    - Deletes user's message immediately.
 *    - Sends an error embed with accepted format examples mentioning the user.
 *    - Auto-deletes the error embed after 10 seconds to keep chat clean.
 *
 * 2. If text CAN be parsed:
 *    - Deletes user's raw message immediately.
 *    - Detects duplicate logs (same timestamp, donor, item, quantity).
 *    - If all logs are duplicates, sends an auto-deleting warning (10s) and halts.
 *    - Inserts unique deposit record(s) into database with full metadata.
 *    - Sends a permanent Deposit Receipt embed showing items deposited.
 *    - Schedules a 10-second delayed resend of the Stock Overview embed so it remains at the bottom.
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

		// Check if depositor restrictions (roles or specific members) are configured
		const allowedRoles = config.depositorRoleIds ?? [];
		const allowedUsers = config.depositorUserIds ?? [];
		if (allowedRoles.length > 0 || allowedUsers.length > 0) {
			const memberRoles = message.member
				? Array.from(message.member.roles.cache.keys())
				: [];
			const hasAllowedRole = allowedRoles.some((rId) =>
				memberRoles.includes(rId),
			);
			const isAllowedUser = allowedUsers.includes(message.author.id);

			if (!hasAllowedRole && !isAllowedUser) {
				await message.delete().catch(() => {});
				const reply = await message.channel
					.send({
						embeds: [
							createErrorEmbed(
								"Access Denied",
								`<@${message.author.id}>, you are not authorized to deposit items in this channel.`,
							),
						],
					})
					.catch(() => null);
				if (reply) {
					setTimeout(() => {
						reply.delete().catch(() => {});
					}, 5000);
				}
				return;
			}
		}

		const parsedLogs = parseDepositLogs(message.content);

		// Case 1: Text could not be parsed
		if (parsedLogs.length === 0) {
			await message.delete().catch(() => {});
			const reply = await message.channel
				.send({
					embeds: [
						createErrorEmbed(
							"Unable to Parse Deposit Log",
							`<@${message.author.id}>, we couldn't recognize any deposit logs in your message. Please paste the exact Torn event log(s).

Accepted Log Examples:
• \`23:14:09 - 06/09/26 Lunette sent 2x Vicodin to you\`
• \`19:58:41 - 05/09/26 LinFeng sent a Parcel to you with the message: Adhesive Plastic - SED\`
• \`05:36:39 - 11/12/25 The-Don-Salieri traded 100x Flash Grenade, 150x Pepper Spray, 18x Xanax to you [view]\`
`,
						),
					],
				})
				.catch(() => null);

			if (reply) {
				setTimeout(() => {
					reply.delete().catch(() => {});
				}, 10000);
			}
			return;
		}

		// Case 2: Text parsed successfully -> delete user message immediately
		await message.delete().catch(() => {});

		const guildId = message.guildId;
		const insertedItems: Array<{
			name: string;
			quantity: number;
			donor: string;
			donorId: number | null;
			timestamp: string | null;
			message: string | null;
		}> = [];
		const skippedDuplicates: Array<{
			name: string;
			quantity: number;
			donor: string;
		}> = [];
		const seenBatchKeys = new Set<string>();

		for (const parsed of parsedLogs) {
			// Resolve canonical item info (ID, proper casing, and real Torn category)
			const itemInfo = await resolveTornItem(
				parsed.itemName,
				config.allowedItems,
			);
			const resolvedItemName = itemInfo.name;

			// Check in-batch duplicates
			const batchKey = `${parsed.timestamp ?? "no-ts"}|${parsed.donorName.trim().toLowerCase()}|${resolvedItemName.trim().toLowerCase()}|${parsed.quantity}`;
			if (seenBatchKeys.has(batchKey)) {
				skippedDuplicates.push({
					name: resolvedItemName,
					quantity: parsed.quantity,
					donor: parsed.donorName,
				});
				continue;
			}

			// Check existing database records: same timestamp, donor name, item, and quantity
			const isDuplicate = await isDuplicateDeposit(
				guildId,
				parsed,
				resolvedItemName,
			);
			if (isDuplicate) {
				skippedDuplicates.push({
					name: resolvedItemName,
					quantity: parsed.quantity,
					donor: parsed.donorName,
				});
				continue;
			}

			seenBatchKeys.add(batchKey);

			await db.insert(elimsArmoryDeposits).values({
				guildId,
				discordUserId: message.author.id,
				discordUsername: message.author.username,
				tornName: parsed.donorName,
				tornId: parsed.donorTornId,
				itemId: itemInfo.id,
				itemName: resolvedItemName,
				itemCategory: itemInfo.category,
				quantity: parsed.quantity,
				rawLog: parsed.rawLog,
				logTimestamp: parsed.timestamp ?? null,
				logMessage: parsed.message ?? null,
				isTest: false,
				status: "available",
			});

			insertedItems.push({
				name: resolvedItemName,
				quantity: parsed.quantity,
				donor: parsed.donorName,
				donorId: parsed.donorTornId,
				timestamp: parsed.timestamp ?? null,
				message: parsed.message ?? null,
			});
		}

		// Case 2a: All logs in message were duplicates -> send auto-deleting warning
		if (insertedItems.length === 0 && skippedDuplicates.length > 0) {
			const reply = await message.channel
				.send({
					embeds: [
						createErrorEmbed(
							"Duplicate Deposit Log",
							`<@${message.author.id}>, the ${
								skippedDuplicates.length === 1
									? "log you pasted has"
									: `${skippedDuplicates.length} logs you pasted have`
							} already been recorded in the armory.`,
						),
					],
				})
				.catch(() => null);

			if (reply) {
				setTimeout(() => {
					reply.delete().catch(() => {});
				}, 10000);
			}
			return;
		}

		if (insertedItems.length === 0) {
			return;
		}

		// Build permanent Deposit Receipt Embed (do NOT delete this message)
		const receiptEmbed = createSuccessEmbed(
			"Item Deposit Recorded",
			`Successfully logged **${insertedItems.length}** item transfer(s):`,
		);

		receiptEmbed.addFields(
			{
				name: "Deposited By",
				value: `<@${message.author.id}>`,
				inline: true,
			},
			{
				name: "Logged At",
				value: `<t:${Math.floor(Date.now() / 1000)}:f>`,
				inline: true,
			},
		);

		// Details for each deposited item
		const itemDetails = insertedItems.map((item) => {
			const donorDisplay = item.donorId
				? `[${item.donor} [${item.donorId}]](https://www.torn.com/profiles.php?XID=${item.donorId})`
				: `**${item.donor}**`;
			const attachedMsg = item.message ? `\n └ *"${item.message}"*` : "";

			return `• **${item.quantity.toLocaleString()}x** ${item.name} from ${donorDisplay}${attachedMsg}`;
		});

		receiptEmbed.addFields({
			name: "Details",
			value: itemDetails.slice(0, 15).join("\n"),
			inline: false,
		});

		if (itemDetails.length > 15) {
			receiptEmbed.addFields({
				name: "Additional Items",
				value: `*...and ${itemDetails.length - 15} more item(s)*`,
				inline: false,
			});
		}

		if (skippedDuplicates.length > 0) {
			receiptEmbed.addFields({
				name: "Skipped Duplicates",
				value: `⚠️ ${skippedDuplicates.length} transfer(s) were skipped because they were already recorded.`,
				inline: false,
			});
		}

		receiptEmbed.setFooter({
			text: "Sentinel",
		});
		receiptEmbed.setTimestamp(new Date());

		// Post the permanent receipt
		await message.channel.send({
			embeds: [receiptEmbed],
		});

		// Resend the paginated Armory Stock Overview embed at the bottom after a 10s delay
		if (message.client) {
			scheduleArmoryStorageResend(message.client, guildId, 10000);
		}
	} catch (err) {
		logger.error("Error in handleArmoryStorageChatMessage:", err);
	}
}
