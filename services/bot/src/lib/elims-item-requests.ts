import {
	and,
	db,
	type ElimsItemRequestConfig,
	elimsApiKeys,
	elimsItemRequests,
	eq,
	getArmoryStock,
	ne,
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
import { buildVerificationReminderMessage } from "./elims-verification-reminder";
import {
	createBaseEmbed,
	createErrorEmbed,
	createSuccessEmbed,
	EMBED_COLORS,
} from "./embeds";
import { logger } from "./logger";
import {
	parseSingleSentLog,
	validateSentLogAgainstRequest,
} from "./torn-log-parser";

const ELIMS_CONFIG_ID = "elims:guild_config";
const ELIMS_ITEM_REQUESTS_CONFIG_ID = "elims:item_requests_config";

export interface UserCompetitionElimination {
	name: "Elimination" | string;
	score: number;
	team: string;
	attacks: number;
}

export interface ResolvedElimsUser {
	tornId: number;
	tornName: string;
	competition?: UserCompetitionElimination | null;
	networth?: number | null;
}

/**
 * Computes unified approved item history for a requester in a guild.
 * Differentiates between test mode and live mode.
 * Combines quantities of the same item into unified totals (e.g. 10x Xanax instead of 5x Xanax, 5x Xanax).
 */
export async function getRequesterApprovedHistory(
	guildId: string,
	discordUserId: string,
	isTest: boolean,
	currentRequestId?: string,
): Promise<{ fieldName: string; fieldValue: string }> {
	const conditions = [
		eq(elimsItemRequests.guildId, guildId),
		eq(elimsItemRequests.discordUserId, discordUserId),
		eq(elimsItemRequests.status, "accepted"),
		eq(elimsItemRequests.isTest, isTest),
	];

	if (currentRequestId) {
		conditions.push(ne(elimsItemRequests.id, currentRequestId));
	}

	const approvedRequests = await db
		.select({
			itemName: elimsItemRequests.itemName,
			quantity: elimsItemRequests.quantity,
		})
		.from(elimsItemRequests)
		.where(and(...conditions));

	const fieldName = `Approved History`;

	if (approvedRequests.length === 0) {
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

	for (const req of approvedRequests) {
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
 * Resolves a Discord user's live Torn identity, competition stats, and networth.
 * Performs a live Torn API v2 call without database caching.
 */
export async function resolveElimsUser(
	discordId: string,
	guildId: string,
): Promise<ResolvedElimsUser | null> {
	const masterKey = process.env.ENCRYPTION_KEY ?? "";
	const guildKeys = await db
		.select()
		.from(elimsApiKeys)
		.where(
			and(eq(elimsApiKeys.guildId, guildId), eq(elimsApiKeys.isValid, true)),
		)
		.orderBy(elimsApiKeys.lastUsedAt);

	const candidateKeys: Array<{ key: string; id?: string }> = [];

	for (const k of guildKeys) {
		const rawKey =
			k.apiKeyEncrypted.length > 16 && masterKey
				? decryptApiKey(k.apiKeyEncrypted, masterKey)
				: k.apiKeyEncrypted;
		if (isValidApiKey(rawKey) && !candidateKeys.some((c) => c.key === rawKey)) {
			candidateKeys.push({ key: rawKey, id: k.id });
		}
	}

	if (candidateKeys.length === 0) {
		logger.warn(`No valid guild API keys configured for guild ${guildId}.`);
		return null;
	}

	const client = new TornApiClient();

	for (const candidate of candidateKeys) {
		try {
			// Single live Torn API v2 call resolving profile, competition, and networth directly from discordId
			const res = (await client.get("/user/{id}", {
				pathParams: { id: discordId },
				queryParams: {
					selections: "profile,competition,personalstats",
					cat: "networth",
				},
				apiKey: candidate.key,
			})) as {
				profile?: { id?: number; name?: string; faction_id?: number };
				name?: string; // Elimination
				score?: number;
				team?: string;
				attacks?: number;
				personalstats?: {
					networth?: { total?: number } | number;
				};
			};

			const tornId = res?.profile?.id;
			const tornName = res?.profile?.name;

			if (!tornId || !tornName) {
				continue;
			}

			let competition: UserCompetitionElimination | null = null;
			if (typeof res.score === "number") {
				competition = {
					name: res.name ?? "Elimination",
					score: res.score,
					team: res.team ?? "Unknown",
					attacks: res.attacks ?? 0,
				};
			}

			let networth: number | null = null;
			if (res.personalstats) {
				if (typeof res.personalstats.networth === "number") {
					networth = res.personalstats.networth;
				} else if (
					typeof res.personalstats.networth === "object" &&
					res.personalstats.networth !== null &&
					typeof res.personalstats.networth.total === "number"
				) {
					networth = res.personalstats.networth.total;
				}
			}

			if (candidate.id) {
				await db
					.update(elimsApiKeys)
					.set({ lastUsedAt: new Date() })
					.where(eq(elimsApiKeys.id, candidate.id))
					.catch(() => {});
			}

			return {
				tornId,
				tornName,
				competition,
				networth,
			};
		} catch (err) {
			logger.warn(`Live Torn user lookup failed for ${discordId}:`, err);
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

		embed.setFields({
			name: "Instructions",
			value:
				"Click **Request Items** to submit a supply request.\n" +
				"Use **[TEST] Request Items** to simulate a test request without affecting tournament inventory.",
			inline: false,
		});

		const requestButton = new ButtonBuilder()
			.setCustomId("elims_request_open")
			.setLabel("Request Items")
			.setStyle(ButtonStyle.Primary);

		const testRequestButton = new ButtonBuilder()
			.setCustomId("elims_request_test_open")
			.setLabel("[TEST] Request Items")
			.setStyle(ButtonStyle.Secondary);

		const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			requestButton,
			testRequestButton,
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

		const isTest = interaction.customId === "elims_request_test_open";

		// Extract unique categories (max 25 for select menu)
		const categories = Array.from(
			new Set(config.allowedItems.map((i) => i.category || "General")),
		).slice(0, 25);

		const selectMenu = new StringSelectMenuBuilder()
			.setCustomId(
				isTest ? "elims_category_select:test" : "elims_category_select:live",
			)
			.setPlaceholder(
				isTest
					? "Select an item category (TEST)..."
					: "Select an item category...",
			)
			.addOptions(
				categories.map((cat) => ({
					label: cat,
					value: cat,
					description: isTest
						? `Browse test requestable items in ${cat}`
						: `Browse requestable items in ${cat}`,
				})),
			);

		const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
			selectMenu,
		);

		const categoryEmbed = createBaseEmbed(
			isTest
				? "[TEST] Item Requests — Select Category"
				: "Item Requests — Select Category",
			isTest
				? "Select the category of supplies you would like to **test request** from the dropdown below:"
				: "Select the category of supplies you would like to request from the dropdown below:",
			isTest ? EMBED_COLORS.WARNING : EMBED_COLORS.PRIMARY,
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

		const isTest = interaction.customId.endsWith(":test");

		const selectMenu = new StringSelectMenuBuilder()
			.setCustomId(isTest ? "elims_item_select:test" : "elims_item_select:live")
			.setPlaceholder(
				isTest
					? `Select an item from ${selectedCategory} (TEST)...`
					: `Select an item from ${selectedCategory}...`,
			)
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
			isTest
				? `[TEST] Item Requests — ${selectedCategory}`
				: `Item Requests — ${selectedCategory}`,
			isTest
				? `Select the specific item you want to **test request** from **${selectedCategory}** below:`
				: `Select the specific item you need from **${selectedCategory}** below:`,
			isTest ? EMBED_COLORS.WARNING : EMBED_COLORS.PRIMARY,
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
			(i) => i.id === selectedItemId,
		);
		const itemName = selectedItem?.name ?? "Item";
		const maxNote = selectedItem?.maxRequestable
			? ` (Max: ${selectedItem.maxRequestable})`
			: "";

		const isTest = interaction.customId.endsWith(":test");

		const modal = new ModalBuilder()
			.setCustomId(
				isTest
					? `elims_request_test_modal:${selectedItemId}`
					: `elims_request_modal:${selectedItemId}`,
			)
			.setTitle(
				isTest
					? `[TEST] Request ${itemName.slice(0, 22)}`
					: `Request ${itemName.slice(0, 30)}`,
			);

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

		const isTest = interaction.customId.startsWith("elims_request_test_modal:");

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
				const [history, stockMap] = await Promise.all([
					getRequesterApprovedHistory(
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
					.setTitle(
						isTest
							? `[TEST] Item Request — ${item.name} x${quantity}`
							: `Item Request — ${item.name} x${quantity}`,
					)
					.setColor(isTest ? EMBED_COLORS.WARNING : 0xf59e0b) // Amber for pending
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

				grantEmbed.addFields({
					name: history.fieldName,
					value: history.fieldValue,
					inline: false,
				});

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
			isTest ? "[TEST] Item Request Submitted" : "Item Request Submitted",
			(isTest
				? `Your item request has been submitted for simulation.\n\n`
				: `Your item request has been submitted for review.\n\n`) +
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

		if (actionType !== "elims_grant_test" && request.status !== "pending") {
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

		// Acknowledge interaction immediately to prevent Discord client timeout rollback
		await interaction.deferUpdate();

		const guildId = interaction.guildId ?? request.guildId;

		if (actionType === "elims_grant_test") {
			const updatedTest = !request.isTest;
			await db
				.update(elimsItemRequests)
				.set({ isTest: updatedTest, updatedAt: new Date() })
				.where(eq(elimsItemRequests.id, requestId));

			const newLabel = updatedTest
				? "[TEST] Unmark Test"
				: "[TEST] Mark as Test";
			const testBtn = new ButtonBuilder()
				.setCustomId(`elims_grant_test:${request.id}`)
				.setLabel(newLabel)
				.setStyle(ButtonStyle.Secondary);

			const components: ButtonBuilder[] = [];
			// Only re-add Approve/Reject if the request is still pending!
			if (request.status === "pending") {
				const approveBtn = new ButtonBuilder()
					.setCustomId(`elims_grant_accept:${request.id}`)
					.setLabel("Approve")
					.setStyle(ButtonStyle.Success);

				const rejectBtn = new ButtonBuilder()
					.setCustomId(`elims_grant_reject:${request.id}`)
					.setLabel("Reject")
					.setStyle(ButtonStyle.Danger);

				components.push(approveBtn, rejectBtn);
			}

			components.push(testBtn);

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				components,
			);

			const existingEmbed = interaction.message.embeds[0];
			if (existingEmbed) {
				const updatedEmbed = EmbedBuilder.from(existingEmbed);
				updatedEmbed.setFooter({
					text: `Sentinel`,
				});

				const history = await getRequesterApprovedHistory(
					guildId,
					request.discordUserId,
					updatedTest,
					request.id,
				);

				const existingFields = existingEmbed.fields
					? existingEmbed.fields.map((f) => ({
							name: f.name,
							value: f.value,
							inline: f.inline,
						}))
					: [];

				const historyFieldIndex = existingFields.findIndex((f) =>
					f.name.startsWith("Approved History"),
				);

				if (historyFieldIndex !== -1) {
					existingFields[historyFieldIndex] = {
						name: history.fieldName,
						value: history.fieldValue,
						inline: false,
					};
					updatedEmbed.setFields(existingFields);
				} else {
					const resolutionIndex = existingFields.findIndex((f) =>
						f.name.startsWith("Resolution"),
					);
					if (resolutionIndex !== -1) {
						existingFields.splice(resolutionIndex, 0, {
							name: history.fieldName,
							value: history.fieldValue,
							inline: false,
						});
						updatedEmbed.setFields(existingFields);
					} else {
						updatedEmbed.addFields({
							name: history.fieldName,
							value: history.fieldValue,
							inline: false,
						});
					}
				}

				await interaction.editReply({
					embeds: [updatedEmbed],
					components: [row],
				});
			} else {
				await interaction.editReply({ components: [row] });
			}
			return;
		}

		if (actionType === "elims_grant_accept") {
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

		const hasHistoryField = existingEmbed.fields.some((f) =>
			f.name.startsWith("Approved History"),
		);
		if (!hasHistoryField) {
			const history = await getRequesterApprovedHistory(
				guildId,
				request.discordUserId,
				request.isTest,
				request.id,
			);
			updatedEmbed.addFields({
				name: history.fieldName,
				value: history.fieldValue,
				inline: false,
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
				"e.g.: 04:37:52 - 04/09/26 You sent 5x Flash Grenade to Fahquetu",
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

		// Validate against request (case-sensitive recipient name check)
		const validation = validateSentLogAgainstRequest(parsed, {
			recipientTornName: request.tornName ?? "",
			recipientTornId: request.tornId,
			itemName: request.itemName,
			quantity: request.quantity,
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

/**
 * Handles "[TEST] Mark as Test Verified" button.
 * Bypasses log verification and stops 1-minute reminders.
 */
export async function handleItemVerifyTestBypassButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		const requestId = interaction.customId.split(":")[1];
		if (!requestId) return;

		await interaction.deferUpdate();

		const [request] = await db
			.select()
			.from(elimsItemRequests)
			.where(eq(elimsItemRequests.id, requestId));

		if (!request) return;

		await db
			.update(elimsItemRequests)
			.set({
				verificationStatus: "verified",
				isTest: true,
				verifiedAt: new Date(),
				verifiedByDiscordId: interaction.user.id,
				verificationLog: `[TEST] Bypassed verification by approver <@${interaction.user.id}>`,
				updatedAt: new Date(),
			})
			.where(eq(elimsItemRequests.id, requestId));

		const successEmbed = createSuccessEmbed(
			"[TEST] Verification Bypassed",
			`Request #${request.id.slice(0, 8)} has been marked as **Test Verified**.\n\nYou will no longer receive verification reminders for this request.`,
		);

		await interaction.editReply({
			embeds: [successEmbed],
			components: [],
		});

		// Also update granting channel embed footer if accessible
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
							const updated = EmbedBuilder.from(grantMsg.embeds[0]).setFooter({
								text: `Sentinel`,
							});
							await grantMsg.edit({ embeds: [updated] }).catch(() => {});
						}
					}
				}
			} catch {}
		}
	} catch (err) {
		logger.error("Error in handleItemVerifyTestBypassButton:", err);
	}
}
