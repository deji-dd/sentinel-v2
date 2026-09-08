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
import { syncElimsStockHoldersChannel } from "./elims-stock-holders";
import { createErrorEmbed, createSuccessEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";
import {
	type ParsedBuyLog,
	type ParsedDepositLog,
	parseArmoryChatInput,
} from "./torn-log-parser";

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

	// Only return items that actually have available stock (exclude currency from regular item pagination)
	for (const stock of stockMap.values()) {
		if (
			stock.itemId === "money" ||
			stock.itemName.trim().toLowerCase() === "money"
		) {
			continue;
		}
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
			`**How to Deposit Items & Money:**
Paste your Torn event log(s) **directly into this channel chat**! Sentinel will automatically record the deposit or purchase, update live stock, and post a confirmation receipt.

**Accepted Log Examples:**
• \`23:14:09 - 06/09/26 Lunette sent 2x Vicodin to you\`
• \`01:39:19 - 07/09/26 wrxodus sent $42,743,465 to you\`
• \`17:57:08 - 07/09/26 You bought a Donator Pack on BLS-Envoy's bazaar at $23,560,000 each for a total of $23,560,000\`
`,
		)
		.setColor(EMBED_COLORS.PRIMARY);

	// Display dedicated Armory Cash balance section if money is tracked
	const moneyStock = stockMap.get("money");
	if (moneyStock) {
		const prefix = moneyStock.available < 0 ? "-$" : "$";
		const absAvail = Math.abs(moneyStock.available).toLocaleString();
		embed.addFields({
			name: "Armory Cash",
			value: `Available: **${prefix}${absAvail}**  •  Deposited: $${moneyStock.deposited.toLocaleString()}  •  Spent: $${moneyStock.consumed.toLocaleString()}`,
			inline: false,
		});
	}

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
		.setLabel("Previous")
		.setStyle(ButtonStyle.Primary)
		.setDisabled(currentPage <= 1);

	const indicatorBtn = new ButtonBuilder()
		.setCustomId("elims_armory_stock_noop")
		.setLabel(`Page ${currentPage}/${totalPages}`)
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(true);

	const nextBtn = new ButtonBuilder()
		.setCustomId(`elims_armory_stock_page:${currentPage + 1}`)
		.setLabel("Next")
		.setStyle(ButtonStyle.Primary)
		.setDisabled(currentPage >= totalPages);

	const refreshBtn = new ButtonBuilder()
		.setCustomId(`elims_armory_stock_page:${currentPage}`)
		.setLabel("Refresh")
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
		eq(elimsArmoryDeposits.status, "available"),
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
 * Detects if an identical purchase log has already been recorded in the database.
 * Matching criteria: same guildId, timestamp/rawLog, item, and quantity.
 */
async function isDuplicateBuy(
	guildId: string,
	buy: ParsedBuyLog,
	resolvedItemName: string,
): Promise<boolean> {
	const itemLower = buy.itemName.trim().toLowerCase();
	const resolvedLower = resolvedItemName.trim().toLowerCase();

	const conditions = [
		eq(elimsArmoryDeposits.guildId, guildId),
		eq(elimsArmoryDeposits.quantity, buy.quantity),
		eq(elimsArmoryDeposits.status, "available"),
		sql<boolean>`(LOWER(${elimsArmoryDeposits.itemName}) = ${itemLower} OR LOWER(${elimsArmoryDeposits.itemName}) = ${resolvedLower})`,
	];

	if (buy.timestamp) {
		conditions.push(eq(elimsArmoryDeposits.logTimestamp, buy.timestamp));
	} else {
		conditions.push(eq(elimsArmoryDeposits.rawLog, buy.rawLog));
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
 * Supports:
 * 1. Item deposits (sent / traded)
 * 2. Money deposits (sent / traded)
 * 3. Item purchases (bought from bazaar, item market, or shop):
 *    - Adds the purchased item to armory available inventory.
 *    - Deducts the purchase cost from armory cash balance.
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

		const { deposits: parsedLogs, buys: parsedBuys } = parseArmoryChatInput(
			message.content,
		);

		// Case 1: Text could not be parsed
		if (parsedLogs.length === 0 && parsedBuys.length === 0) {
			await message.delete().catch(() => {});
			const reply = await message.channel
				.send({
					embeds: [
						createErrorEmbed(
							"Unable to Parse Armory Log",
							`<@${message.author.id}>, we couldn't recognize any deposit or purchase logs in your message. Please paste the exact Torn event log(s).

Accepted Log Examples:
• \`23:14:09 - 06/09/26 Lunette sent 2x Vicodin to you\`
• \`01:39:19 - 07/09/26 wrxodus sent $42,743,465 to you\`
• \`17:57:08 - 07/09/26 You bought a Donator Pack on BLS-Envoy's bazaar at $23,560,000 each for a total of $23,560,000\`
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
		const insertedBuys: Array<{
			name: string;
			quantity: number;
			totalCost: number;
			source: string | null;
			timestamp: string | null;
		}> = [];
		const skippedDuplicates: Array<{
			name: string;
			quantity: number;
			donor: string;
		}> = [];
		const seenBatchKeys = new Set<string>();

		// Process standard item & cash deposits
		for (const parsed of parsedLogs) {
			const isMoney = parsed.itemName.trim().toLowerCase() === "money";
			const itemInfo = isMoney
				? { id: "money", name: "Money", category: "Currency" }
				: await resolveTornItem(parsed.itemName, config.allowedItems);
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

			// Check existing database records
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

		// Process item purchase logs (add item, deduct cash)
		for (const buy of parsedBuys) {
			const itemInfo = await resolveTornItem(buy.itemName, config.allowedItems);
			const resolvedItemName = itemInfo.name;

			// Check in-batch duplicates
			const batchKey = `${buy.timestamp ?? "no-ts"}|buy|${resolvedItemName.trim().toLowerCase()}|${buy.quantity}|${buy.totalCost}`;
			if (seenBatchKeys.has(batchKey)) {
				skippedDuplicates.push({
					name: resolvedItemName,
					quantity: buy.quantity,
					donor: buy.source ?? "Armory Purchase",
				});
				continue;
			}

			// Check existing database records
			const isDuplicate = await isDuplicateBuy(guildId, buy, resolvedItemName);
			if (isDuplicate) {
				skippedDuplicates.push({
					name: resolvedItemName,
					quantity: buy.quantity,
					donor: buy.source ?? "Armory Purchase",
				});
				continue;
			}

			seenBatchKeys.add(batchKey);

			const vendorName = buy.source
				? buy.source.slice(0, 100)
				: "Armory Purchase";

			// Record 1: Add purchased items to armory available inventory
			await db.insert(elimsArmoryDeposits).values({
				guildId,
				discordUserId: message.author.id,
				discordUsername: message.author.username,
				tornName: vendorName,
				tornId: null,
				itemId: itemInfo.id,
				itemName: resolvedItemName,
				itemCategory: itemInfo.category,
				quantity: buy.quantity,
				rawLog: buy.rawLog,
				logTimestamp: buy.timestamp ?? null,
				logMessage: `Bought for $${buy.totalCost.toLocaleString()}${buy.source ? ` (${buy.source})` : ""}`,
				isTest: false,
				status: "available",
			});

			// Record 2: Deduct cash spent from armory cash balance
			if (buy.totalCost > 0) {
				await db.insert(elimsArmoryDeposits).values({
					guildId,
					discordUserId: message.author.id,
					discordUsername: message.author.username,
					tornName: vendorName,
					tornId: null,
					itemId: "money",
					itemName: "Money",
					itemCategory: "Currency",
					quantity: buy.totalCost,
					rawLog: buy.rawLog,
					logTimestamp: buy.timestamp ?? null,
					logMessage: `Purchase of ${buy.quantity.toLocaleString()}x ${resolvedItemName}`,
					isTest: false,
					status: "spent",
				});
			}

			insertedBuys.push({
				name: resolvedItemName,
				quantity: buy.quantity,
				totalCost: buy.totalCost,
				source: buy.source ?? null,
				timestamp: buy.timestamp ?? null,
			});
		}

		// Case 2a: All logs in message were duplicates -> send auto-deleting warning
		if (
			insertedItems.length === 0 &&
			insertedBuys.length === 0 &&
			skippedDuplicates.length > 0
		) {
			const reply = await message.channel
				.send({
					embeds: [
						createErrorEmbed(
							"Duplicate Armory Log",
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

		if (insertedItems.length === 0 && insertedBuys.length === 0) {
			return;
		}

		// Build permanent Deposit / Purchase Receipt Embed
		const totalActions = insertedItems.length + insertedBuys.length;
		const receiptTitle =
			insertedBuys.length > 0 && insertedItems.length === 0
				? "Armory Purchase Recorded"
				: insertedBuys.length > 0
					? "Armory Activity Recorded"
					: "Item Deposit Recorded";

		const receiptEmbed = createSuccessEmbed(
			receiptTitle,
			`Successfully recorded **${totalActions}** transaction(s):`,
		);

		receiptEmbed.addFields(
			{
				name: "Logged By",
				value: `<@${message.author.id}>`,
				inline: true,
			},
			{
				name: "Logged At",
				value: `<t:${Math.floor(Date.now() / 1000)}:f>`,
				inline: true,
			},
		);

		// Details for deposited items & money
		const detailLines: string[] = [];

		for (const item of insertedItems) {
			const donorDisplay = item.donorId
				? `[${item.donor} [${item.donorId}]](https://www.torn.com/profiles.php?XID=${item.donorId})`
				: `**${item.donor}**`;
			const attachedMsg = item.message ? `\n └ *"${item.message}"*` : "";

			if (item.name === "Money") {
				detailLines.push(
					`• **$${item.quantity.toLocaleString()}** from ${donorDisplay}${attachedMsg}`,
				);
			} else {
				detailLines.push(
					`• **${item.quantity.toLocaleString()}x** ${item.name} from ${donorDisplay}${attachedMsg}`,
				);
			}
		}

		// Details for purchases
		for (const b of insertedBuys) {
			const sourceDisplay = b.source ? ` (${b.source})` : "";
			detailLines.push(
				`• **${b.quantity.toLocaleString()}x** ${b.name} bought for **$${b.totalCost.toLocaleString()}**${sourceDisplay}\n └ Cash Deducted: **$${b.totalCost.toLocaleString()}**`,
			);
		}

		receiptEmbed.addFields({
			name: "Details",
			value: detailLines.slice(0, 15).join("\n"),
			inline: false,
		});

		if (detailLines.length > 15) {
			receiptEmbed.addFields({
				name: "Additional Transactions",
				value: `*...and ${detailLines.length - 15} more transaction(s)*`,
				inline: false,
			});
		}

		if (skippedDuplicates.length > 0) {
			receiptEmbed.addFields({
				name: "Skipped Duplicates",
				value: `${skippedDuplicates.length} transaction(s) were skipped because they were already recorded.`,
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
			void syncElimsStockHoldersChannel(message.client, guildId);
		}
	} catch (err) {
		logger.error("Error in handleArmoryStorageChatMessage:", err);
	}
}
