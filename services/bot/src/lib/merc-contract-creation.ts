import {
	createMercContractToken,
	db,
	eq,
	getExpiredUnusedMercContractTokens,
	getMercChannelConfig,
	getMercContracts,
	guildConfigs,
	hasActiveMercContractForChannel,
	hasActiveMercContractTokenForChannel,
	markMercContractTokensArchived,
	mercChannelConfigs,
	mercContracts,
	updateMercChannelConfig,
} from "@sentinel/database";
import { TornApiClient } from "@sentinel/torn-api";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	ChannelType,
	type Client,
	MessageFlags,
	OverwriteType,
	PermissionFlagsBits,
	type TextChannel,
} from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

const DASHBOARD_URL =
	process.env.DASHBOARD_URL ||
	(process.env.NODE_ENV === "production"
		? "https://dashboard.blasted-labs.tech"
		: "http://localhost:3000");

/**
 * Finds a channel or category by exact ID or case-insensitive name in a guild.
 */
function resolveGuildChannel(
	guild: import("discord.js").Guild,
	nameOrId: string,
	expectedType?: ChannelType,
) {
	const raw = nameOrId.trim();
	const clean = raw.replace(/^#/, "").toLowerCase();

	const byId = guild.channels.cache.get(raw);
	if (byId && (expectedType === undefined || byId.type === expectedType)) {
		return byId;
	}

	if (typeof guild.channels.cache.find === "function") {
		return guild.channels.cache.find(
			(c) =>
				(expectedType === undefined || c.type === expectedType) &&
				c.name.toLowerCase() === clean,
		);
	}

	return Array.from(guild.channels.cache.values()).find(
		(c) =>
			(expectedType === undefined || c.type === expectedType) &&
			c.name?.toLowerCase() === clean,
	);
}

/**
 * Purges extraneous messages in a dedicated contract creation channel, retaining the active embed.
 */
async function purgeChannelExtraneousMessages(
	channel: TextChannel,
	keepMessageId?: string | null,
): Promise<void> {
	try {
		const fetched = await channel.messages
			.fetch({ limit: 50 })
			.catch(() => null);
		if (!fetched || fetched.size === 0) return;

		const toDelete = fetched.filter((m) => m.id !== keepMessageId);
		if (toDelete.size === 0) return;

		const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
		const bulkDeleteable = toDelete.filter(
			(m) => m.createdTimestamp > fourteenDaysAgo,
		);
		const olderDeleteable = toDelete.filter(
			(m) => m.createdTimestamp <= fourteenDaysAgo,
		);

		if (bulkDeleteable.size > 0) {
			await channel.bulkDelete(bulkDeleteable, true).catch(() => {});
		}

		for (const [, oldMsg] of olderDeleteable) {
			await oldMsg.delete().catch(() => {});
		}
	} catch (err) {
		logger.warn(
			`Failed to purge extraneous messages in #${channel.name}:`,
			err,
		);
	}
}

/**
 * Updates or deploys the permanent "Subversive Alliance Merc Service" embed in the contract creation channel.
 */
export async function updateMercContractCreationChannel(
	client: Client,
	targetGuildId?: string,
): Promise<void> {
	try {
		const configs = targetGuildId
			? await db
					.select()
					.from(mercChannelConfigs)
					.where(eq(mercChannelConfigs.guildId, targetGuildId))
			: await db.select().from(mercChannelConfigs);

		for (const config of configs) {
			if (!config.contractCreation) continue;

			const guild =
				client.guilds.cache.get(config.guildId) ||
				(await client.guilds.fetch(config.guildId).catch(() => null));
			if (!guild) continue;

			// Ensure channels cache is populated
			if (guild.channels.cache.size <= 1) {
				await guild.channels.fetch().catch(() => null);
			}

			const channel = resolveGuildChannel(
				guild,
				config.contractCreation,
				ChannelType.GuildText,
			) as TextChannel | null;
			if (!channel?.isTextBased()) {
				logger.warn(
					`Contract creation channel "${config.contractCreation}" not found in guild ${guild.name} (${guild.id})`,
				);
				continue;
			}

			const embed = createBaseEmbed(
				"Subversive Alliance Merc Service",
				"Need mercenary support for your upcoming or ongoing war? Click below to request a customized mercenary contract for your faction.",
				EMBED_COLORS.PRIMARY,
			);

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId("merc_create_contract_btn")
					.setLabel("Create Contract")
					.setStyle(ButtonStyle.Primary),
			);

			let activeMsgId = config.contractCreationMessageId ?? null;

			// Try to edit existing tracked message in place
			if (activeMsgId) {
				const existingMsg = await channel.messages
					.fetch(activeMsgId)
					.catch(() => null);
				if (existingMsg) {
					await existingMsg.edit({
						embeds: [embed],
						components: [row],
					});
					await purgeChannelExtraneousMessages(channel, activeMsgId);
					continue;
				}
			}

			// Otherwise, clean up and send a new permanent embed
			await purgeChannelExtraneousMessages(channel);
			const newMsg = await channel.send({
				embeds: [embed],
				components: [row],
			});

			activeMsgId = newMsg.id;
			await updateMercChannelConfig(config.guildId, {
				contractCreationMessageId: activeMsgId,
			});
		}
	} catch (err) {
		logger.error("Failed to update mercenary contract creation channel:", err);
	}
}

/**
 * Handles the "Create Contract" button click in Discord.
 */
export async function handleContractCreationButtonClick(
	interaction: ButtonInteraction,
): Promise<void> {
	if (!interaction.guildId || !interaction.guild) {
		await interaction.reply({
			content: "This action must be performed within a server.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const discordUserId = interaction.user.id;
	const apiKey = process.env.TORN_API_KEY;

	if (!apiKey) {
		await interaction.editReply({
			content:
				"Torn API key is currently not configured on the bot. Please contact server administration.",
		});
		return;
	}

	try {
		// Call Torn API v2 /user/{id}/profile with Discord ID
		const apiClient = new TornApiClient();
		const profileRes = await apiClient.get<{
			profile?: {
				id: number;
				name: string;
				faction_id?: number | null;
			};
		}>("/user/{id}/profile", {
			apiKey,
			pathParams: { id: discordUserId },
		});

		const profile = profileRes?.profile;
		if (!profile?.faction_id) {
			await interaction.editReply({
				content:
					"Unable to verify an active Torn faction for your Discord account. Please ensure your Torn account is linked to Discord and you are currently in a faction.",
			});
			return;
		}

		const factionId = profile.faction_id;
		let factionName = `Faction ${factionId}`;
		try {
			const factionRes = await apiClient.get<{
				basic?: {
					id: number;
					name: string;
					tag?: string;
				};
			}>("/faction/{id}/basic", {
				apiKey,
				pathParams: { id: factionId },
			});
			if (factionRes?.basic?.name) {
				factionName = factionRes.basic.name;
			}
		} catch (err) {
			logger.warn(
				`Failed to fetch basic faction information for faction ${factionId}:`,
				err,
			);
		}

		// Guard 1: Existing Active/Upcoming Contract
		// Initial contract must end before a new contract can be created
		const existingContracts = await getMercContracts(interaction.guildId);
		const activeContract = existingContracts.find(
			(c) =>
				c.factionId === factionId &&
				(c.status === "active" || c.status === "upcoming"),
		);

		if (activeContract) {
			let existingChannel: TextChannel | null = null;
			if (activeContract.clientChannelId) {
				try {
					const ch = await interaction.guild.channels.fetch(
						activeContract.clientChannelId,
					);
					if (ch?.isTextBased()) {
						existingChannel = ch as TextChannel;
					}
				} catch {
					// Channel might have been deleted or inaccessible
				}
			}

			if (existingChannel) {
				// Ensure clicking user from the same faction has access to the channel
				await existingChannel.permissionOverwrites.edit(interaction.user.id, {
					ViewChannel: true,
					SendMessages: true,
					ReadMessageHistory: true,
					EmbedLinks: true,
				});

				await existingChannel.send({
					content: `📢 <@${interaction.user.id}> from **${factionName}** accessed the mercenary service.`,
				});

				await interaction.editReply({
					content: `An active or upcoming mercenary contract is already in progress for **${factionName}** in <#${existingChannel.id}>. The current contract must conclude before a new contract can be created.`,
				});
				return;
			}

			await interaction.editReply({
				content: `An active or upcoming mercenary contract is already in progress for **${factionName}** (Contract ID: \`${activeContract.id}\`). The current contract must conclude before a new contract can be created.`,
			});
			return;
		}

		// Fetch mercenary channel config & guild roles
		const mercConfig = await getMercChannelConfig(interaction.guildId);
		const [guildConfigRow] = await db
			.select()
			.from(guildConfigs)
			.where(eq(guildConfigs.guildId, interaction.guildId));

		const mercManagerRoleId = guildConfigRow?.mercManagerRoleId;

		// Format sanitized channel name: max 32 chars, lowercase, hyphens for spaces
		const rawName = factionName || `faction-${factionId}`;
		const cleanChannelName =
			rawName
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 32) || `faction-${factionId}`;

		// Resolve Client Category
		let parentCategory: import("discord.js").CategoryChannel | null = null;
		if (mercConfig.clientCategory) {
			const cat = resolveGuildChannel(
				interaction.guild,
				mercConfig.clientCategory,
				ChannelType.GuildCategory,
			);
			if (cat && cat.type === ChannelType.GuildCategory) {
				parentCategory = cat as import("discord.js").CategoryChannel;
			}
		}

		// Guard 2: Same Channel Reuse
		// Check if a channel for this faction already exists under Client Category
		let clientChannel: TextChannel | null = null;
		let isReusedChannel = false;

		if (parentCategory) {
			const existingCh = interaction.guild.channels.cache.find(
				(ch) =>
					ch.parentId === parentCategory.id &&
					ch.name.toLowerCase() === cleanChannelName.toLowerCase() &&
					ch.type === ChannelType.GuildText,
			);
			if (existingCh?.isTextBased()) {
				clientChannel = existingCh as TextChannel;
				isReusedChannel = true;
			}
		}

		if (clientChannel) {
			// Ensure user has permissions in the existing channel
			await clientChannel.permissionOverwrites.edit(interaction.user.id, {
				ViewChannel: true,
				SendMessages: true,
				ReadMessageHistory: true,
				EmbedLinks: true,
			});
		} else {
			// Create private client channel
			const permissionOverwrites = [
				{
					id: interaction.guild.roles.everyone.id,
					deny: [PermissionFlagsBits.ViewChannel],
				},
				{
					id: interaction.client.user.id,
					allow: [
						PermissionFlagsBits.ViewChannel,
						PermissionFlagsBits.SendMessages,
						PermissionFlagsBits.ManageChannels,
						PermissionFlagsBits.EmbedLinks,
						PermissionFlagsBits.AttachFiles,
						PermissionFlagsBits.ReadMessageHistory,
					],
				},
				{
					id: interaction.user.id,
					allow: [
						PermissionFlagsBits.ViewChannel,
						PermissionFlagsBits.SendMessages,
						PermissionFlagsBits.ReadMessageHistory,
						PermissionFlagsBits.EmbedLinks,
					],
				},
			];

			if (mercManagerRoleId) {
				permissionOverwrites.push({
					id: mercManagerRoleId,
					allow: [
						PermissionFlagsBits.ViewChannel,
						PermissionFlagsBits.SendMessages,
						PermissionFlagsBits.ReadMessageHistory,
						PermissionFlagsBits.EmbedLinks,
						PermissionFlagsBits.AttachFiles,
					],
				});
			}

			clientChannel = await interaction.guild.channels.create({
				name: cleanChannelName,
				type: ChannelType.GuildText,
				parent: parentCategory?.id,
				permissionOverwrites,
				reason: `Mercenary contract client channel for ${interaction.user.tag} (${factionName} [${factionId}])`,
			});
		}

		// Create single-use expiring session token (30m)
		const token = await createMercContractToken({
			guildId: interaction.guildId,
			channelId: clientChannel.id,
			discordUserId,
			discordUsername: interaction.user.tag || interaction.user.username,
			factionId,
			factionName,
			ttlMinutes: 30,
		});

		const baseUrl = DASHBOARD_URL.replace(/\/+$/, "");
		const formUrl = `${baseUrl}/#/merc/create?token=${token}`;

		const welcomeEmbed = createBaseEmbed(
			"Subversive Alliance Merc Service",
			`Welcome <@${interaction.user.id}>! This is your private mercenary channel.\n\nPlease click the button below to configure your contract terms, target filters, and war timing.`,
			EMBED_COLORS.PRIMARY,
		);

		const expDate = new Date(Date.now() + 1800 * 1000);
		const expEpoch = Math.floor(expDate.getTime() / 1000);
		const pad = (n: number) => n.toString().padStart(2, "0");
		const expTct = `${pad(expDate.getUTCHours())}:${pad(expDate.getUTCMinutes())}:${pad(expDate.getUTCSeconds())} TCT`;

		welcomeEmbed.addFields(
			{
				name: "Faction",
				value: `[${factionName}](https://www.torn.com/factions.php?step=profile&ID=${factionId})`,
				inline: true,
			},
			{
				name: "Session Expiration",
				value: `\`${expTct}\` (<t:${expEpoch}:R>)`,
				inline: true,
			},
		);

		const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setStyle(ButtonStyle.Link)
				.setLabel("Create Contract")
				.setURL(formUrl),
		);

		await clientChannel.send({
			content: `<@${interaction.user.id}>`,
			embeds: [welcomeEmbed],
			components: [actionRow],
		});

		await interaction.editReply({
			content: isReusedChannel
				? `Reusing your faction's private consultation channel: <#${clientChannel.id}>. Please check the channel to configure your contract.`
				: `Your private contract channel has been created: <#${clientChannel.id}>`,
		});
	} catch (err) {
		logger.error("Error creating mercenary client channel:", err);
		await interaction.editReply({
			content:
				"An unexpected error occurred while processing your contract request. Please try again or alert server management.",
		});
	}
}

/**
 * Handles the "Archive Channel" button click on contract conclusion.
 */
export async function handleArchiveChannelButtonClick(
	interaction: ButtonInteraction,
): Promise<void> {
	if (!interaction.guildId || !interaction.guild) {
		await interaction.reply({
			content: "This action must be performed within a server.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const parts = interaction.customId.split(":");
	const contractId = parts[1];

	if (!contractId) return;

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	try {
		const [guildConfigRow] = await db
			.select()
			.from(guildConfigs)
			.where(eq(guildConfigs.guildId, interaction.guildId));

		const mercManagerRoleId = guildConfigRow?.mercManagerRoleId;
		const botAdminId = process.env.DISCORD_USER_ID;

		// Verify authorized user (Merc Manager or Bot Owner or Guild Owner)
		const member = interaction.member;
		let memberRoles: string[] = [];
		if (Array.isArray(member?.roles)) {
			memberRoles = member.roles;
		} else if (
			member?.roles &&
			"cache" in member.roles &&
			(member.roles as unknown as { cache: Map<string, unknown> }).cache
		) {
			memberRoles = Array.from(
				(
					member.roles as unknown as { cache: Map<string, unknown> }
				).cache.keys(),
			);
		}

		const isManager =
			(mercManagerRoleId && memberRoles.includes(mercManagerRoleId)) ||
			interaction.user.id === botAdminId ||
			interaction.guild.ownerId === interaction.user.id;

		if (!isManager) {
			await interaction.editReply({
				content:
					"Only Mercenary Managers or the Bot Administrator can archive this channel.",
			});
			return;
		}

		// Find contract and client channel
		const [contractRow] = await db
			.select()
			.from(mercContracts)
			.where(eq(mercContracts.id, contractId));

		const channel = interaction.channel as TextChannel | null;
		if (!channel) {
			await interaction.editReply({
				content: "Unable to resolve this channel.",
			});
			return;
		}

		// Disable archive button on message
		if (interaction.message) {
			const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId("merc_archived_btn")
					.setLabel("Archived")
					.setStyle(ButtonStyle.Secondary)
					.setDisabled(true),
			);
			await interaction.message
				.edit({ components: [disabledRow] })
				.catch(() => {});
		}

		// Strip client permissions and move to archive category
		const success = await archiveMercClientChannel(
			interaction.client,
			interaction.guildId,
			channel.id,
			contractRow?.clientDiscordId ?? null,
			`📁 Channel archived by <@${interaction.user.id}>. Client access has been revoked.`,
		);

		if (!success) {
			await interaction.editReply({
				content: "Failed to archive channel. Please verify bot permissions.",
			});
			return;
		}

		await interaction.editReply({
			content: "Channel successfully archived.",
		});
	} catch (err) {
		logger.error("Error archiving contract channel:", err);
		await interaction.editReply({
			content: "Failed to archive channel. Please verify bot permissions.",
		});
	}
}

/**
 * Archives a mercenary client channel:
 * 1. Revokes ViewChannel and SendMessages for the client user.
 * 2. Moves the channel to archiveCategory (if configured).
 * 3. Sends a notification message in the channel.
 */
export async function archiveMercClientChannel(
	client: Client,
	guildId: string,
	channelId: string,
	clientDiscordId?: string | null,
	reasonMessage?: string,
): Promise<boolean> {
	try {
		const guild =
			client.guilds.cache.get(guildId) ||
			(await client.guilds.fetch(guildId).catch(() => null));
		if (!guild) {
			logger.warn(`archiveMercClientChannel: Guild ${guildId} not found.`);
			return false;
		}

		// Ensure channels cache is populated
		if (guild.channels.cache.size <= 1) {
			await guild.channels.fetch().catch(() => null);
		}

		const channel =
			guild.channels.cache.get(channelId) ||
			(await guild.channels.fetch(channelId).catch(() => null));
		if (!channel?.isTextBased()) {
			logger.warn(
				`archiveMercClientChannel: Channel ${channelId} not found in guild ${guild.name}.`,
			);
			return false;
		}

		const textChannel = channel as TextChannel;

		// 1. Remove all non-admin members from the channel (revoking client/user access)
		const overwrites = textChannel.permissionOverwrites?.cache
			? Array.from(textChannel.permissionOverwrites.cache.values())
			: [];

		for (const overwrite of overwrites) {
			if (overwrite.type === OverwriteType.Member) {
				// Never remove the bot itself
				if (client.user && overwrite.id === client.user.id) continue;

				// Server administrators cannot (and should not) be removed
				const member =
					guild.members?.cache?.get(overwrite.id) ||
					(guild.members?.fetch
						? await guild.members.fetch(overwrite.id).catch(() => null)
						: null);
				if (member?.permissions?.has(PermissionFlagsBits.Administrator)) {
					continue;
				}

				if (typeof textChannel.permissionOverwrites.delete === "function") {
					await textChannel.permissionOverwrites
						.delete(overwrite.id)
						.catch(async () => {
							if (typeof textChannel.permissionOverwrites.edit === "function") {
								await textChannel.permissionOverwrites
									.edit(overwrite.id, {
										ViewChannel: false,
										SendMessages: false,
									})
									.catch(() => {});
							}
						});
				} else if (
					typeof textChannel.permissionOverwrites.edit === "function"
				) {
					await textChannel.permissionOverwrites
						.edit(overwrite.id, {
							ViewChannel: false,
							SendMessages: false,
						})
						.catch(() => {});
				}
			}
		}

		// Also explicitly handle clientDiscordId if specified and not already removed
		if (clientDiscordId && clientDiscordId !== client.user?.id) {
			const clientMember =
				guild.members?.cache?.get(clientDiscordId) ||
				(guild.members?.fetch
					? await guild.members.fetch(clientDiscordId).catch(() => null)
					: null);
			if (!clientMember?.permissions?.has(PermissionFlagsBits.Administrator)) {
				if (typeof textChannel.permissionOverwrites.delete === "function") {
					await textChannel.permissionOverwrites
						.delete(clientDiscordId)
						.catch(async () => {
							if (typeof textChannel.permissionOverwrites.edit === "function") {
								await textChannel.permissionOverwrites
									.edit(clientDiscordId, {
										ViewChannel: false,
										SendMessages: false,
									})
									.catch(() => {});
							}
						});
				} else if (
					typeof textChannel.permissionOverwrites.edit === "function"
				) {
					await textChannel.permissionOverwrites
						.edit(clientDiscordId, {
							ViewChannel: false,
							SendMessages: false,
						})
						.catch(() => {});
				}
			}
		}

		// Ensure @everyone explicitly denies ViewChannel on the archived channel
		if (
			guild.roles?.everyone?.id &&
			typeof textChannel.permissionOverwrites.edit === "function"
		) {
			await textChannel.permissionOverwrites
				.edit(guild.roles.everyone.id, {
					ViewChannel: false,
				})
				.catch(() => {});
		}

		// 2. Move to archive category if configured
		const mercConfig = await getMercChannelConfig(guildId);
		if (mercConfig.archiveCategory) {
			const archiveCat = resolveGuildChannel(
				guild,
				mercConfig.archiveCategory,
				ChannelType.GuildCategory,
			);
			if (archiveCat && archiveCat.type === ChannelType.GuildCategory) {
				if (textChannel.parentId !== archiveCat.id) {
					// Guard against name clashing in archive category:
					// Check if another channel in the archive category already has this name
					const nameClash = Array.from(guild.channels.cache.values()).some(
						(ch) =>
							ch.parentId === archiveCat.id &&
							ch.id !== textChannel.id &&
							ch.name.toLowerCase() === textChannel.name.toLowerCase(),
					);

					if (nameClash && typeof textChannel.setName === "function") {
						const dateSuffix = new Date()
							.toISOString()
							.slice(5, 10)
							.replace("-", ""); // e.g. "1002"
						const randSuffix = Math.random().toString(36).slice(2, 6);
						const suffix = `-${dateSuffix}-${randSuffix}`;
						const baseName = textChannel.name
							.slice(0, 32 - suffix.length)
							.replace(/-+$/, "");
						const uniqueName = `${baseName}${suffix}`;
						await textChannel.setName(uniqueName).catch((err) => {
							logger.warn(
								`Failed to rename clashing archived channel #${textChannel.name} to #${uniqueName}:`,
								err,
							);
						});
					}

					await textChannel
						.setParent(archiveCat.id, { lockPermissions: false })
						.catch((err) => {
							logger.warn(
								`Failed to move channel #${textChannel.name} to archive category:`,
								err,
							);
						});
				}
			}
		}

		// 3. Set channel topic with archive timestamp for automated 1-week retention tracking
		const archivedIso = new Date().toISOString();
		if (typeof textChannel.setTopic === "function") {
			await textChannel
				.setTopic(`Archived on ${archivedIso} | Mercenary Client Channel`)
				.catch(() => {});
		}

		// 4. Post notification in the channel
		const message =
			reasonMessage ||
			"Channel automatically archived because the contract creation link expired without submission. Client access has been revoked.";
		await textChannel.send({ content: message }).catch(() => {});

		return true;
	} catch (err) {
		logger.error(`Error archiving mercenary client channel ${channelId}:`, err);
		return false;
	}
}

/**
 * Scans the archive category across all guilds and permanently deletes channels
 * that have been archived for >= 7 days (1 week).
 */
export async function cleanupOldArchivedMercChannels(
	client: Client,
	maxAgeDays = 7,
): Promise<number> {
	const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
	const now = Date.now();
	let cleanedCount = 0;

	for (const guild of client.guilds.cache.values()) {
		try {
			const mercConfig = await getMercChannelConfig(guild.id);
			if (!mercConfig.archiveCategory) continue;

			const archiveCat = resolveGuildChannel(
				guild,
				mercConfig.archiveCategory,
				ChannelType.GuildCategory,
			);
			if (!archiveCat || archiveCat.type !== ChannelType.GuildCategory) {
				continue;
			}

			// Ensure channels cache is populated
			if (guild.channels.cache.size <= 1) {
				await guild.channels.fetch().catch(() => null);
			}

			const archivedChannels = Array.from(guild.channels.cache.values()).filter(
				(ch): ch is TextChannel =>
					ch.parentId === archiveCat.id && ch.type === ChannelType.GuildText,
			);

			for (const ch of archivedChannels) {
				try {
					let isEligible = false;

					// 1. Check topic for explicit archive ISO date
					if (ch.topic) {
						const match = ch.topic.match(/Archived on ([\d-T:.Z]+)/i);
						if (match?.[1]) {
							const archiveDate = new Date(match[1]);
							if (
								!Number.isNaN(archiveDate.getTime()) &&
								now - archiveDate.getTime() >= maxAgeMs
							) {
								isEligible = true;
							}
						}
					}

					// 2. Fallback: check creation date and last message timestamp
					if (!isEligible && ch.createdAt) {
						const createdTime = ch.createdAt.getTime();
						if (now - createdTime >= maxAgeMs) {
							// If channel is >= 7 days old, verify no recent messages exist
							if (ch.messages && typeof ch.messages.fetch === "function") {
								const messages = await ch.messages
									.fetch({ limit: 1 })
									.catch(() => null);
								const lastMsg = messages?.first?.();
								if (!lastMsg || now - lastMsg.createdTimestamp >= maxAgeMs) {
									isEligible = true;
								}
							} else {
								isEligible = true;
							}
						}
					}

					if (isEligible) {
						await ch.delete(
							`Mercenary archive retention policy: auto-cleaning channel older than ${maxAgeDays} days.`,
						);
						logger.info(
							`Cleaned up ${maxAgeDays}-day-old archived channel #${ch.name} (${ch.id}) in guild ${guild.name}.`,
						);
						cleanedCount++;
					}
				} catch (chErr) {
					logger.warn(
						`Failed to evaluate/delete archived channel #${ch.name} (${ch.id}):`,
						chErr,
					);
				}
			}
		} catch (gErr) {
			logger.warn(
				`Error processing archive channel cleanup for guild ${guild.name} (${guild.id}):`,
				gErr,
			);
		}
	}

	return cleanedCount;
}

/**
 * Scans for expired, unused contract session tokens and automatically archives the created client channel.
 */
export async function processExpiredMercContractTokens(
	client: Client,
): Promise<number> {
	const expiredTokens = await getExpiredUnusedMercContractTokens();
	if (expiredTokens.length === 0) return 0;

	let archivedCount = 0;
	const processedTokens: string[] = [];

	// Group tokens by channelId to avoid processing the same channel multiple times in one pass
	const channelTokenMap = new Map<string, typeof expiredTokens>();
	const noChannelTokens: string[] = [];

	for (const token of expiredTokens) {
		if (!token.channelId) {
			noChannelTokens.push(token.token);
			continue;
		}
		const existing = channelTokenMap.get(token.channelId) ?? [];
		existing.push(token);
		channelTokenMap.set(token.channelId, existing);
	}

	for (const [channelId, tokens] of channelTokenMap.entries()) {
		const firstToken = tokens[0];
		if (!firstToken) continue;

		// Guard 1: Check if an active or upcoming contract is using this channel
		const contractExists = await hasActiveMercContractForChannel(channelId);
		if (contractExists) {
			// Contract was created, do not archive channel
			for (const t of tokens) {
				processedTokens.push(t.token);
			}
			continue;
		}

		// Guard 2: Check if there is another unexpired, unused token for this channel
		const hasActiveToken =
			await hasActiveMercContractTokenForChannel(channelId);
		if (hasActiveToken) {
			// Newer unexpired link exists, don't archive yet; just mark this expired token as archived
			for (const t of tokens) {
				processedTokens.push(t.token);
			}
			continue;
		}

		// Auto-archive the channel
		logger.info(
			`Auto-archiving mercenary client channel ${channelId} (Faction ${firstToken.factionId}): contract creation link expired without submission.`,
		);

		await archiveMercClientChannel(
			client,
			firstToken.guildId,
			channelId,
			firstToken.discordUserId,
			"Channel automatically archived because the contract creation link expired without submission. Client access has been revoked.",
		);

		archivedCount++;
		for (const t of tokens) {
			processedTokens.push(t.token);
		}
	}

	const allToMark = [...processedTokens, ...noChannelTokens];
	if (allToMark.length > 0) {
		await markMercContractTokensArchived(allToMark);
	}

	return archivedCount;
}

/**
 * Starts a periodic background scheduler in the bot to check for expired contract creation tokens (default: 30s cadence).
 */
export function startMercExpiredTokenArchiver(
	client: Client,
	cadenceMs = 30_000,
): NodeJS.Timeout {
	// Run initial pass after 5s
	setTimeout(() => {
		void processExpiredMercContractTokens(client).catch((err) => {
			logger.warn("Error running initial expired token archiver pass:", err);
		});
	}, 5_000);

	// Run initial 1-week archived channel retention cleanup pass after 10s
	setTimeout(() => {
		void cleanupOldArchivedMercChannels(client).catch((err) => {
			logger.warn("Error running initial archived channel cleanup pass:", err);
		});
	}, 10_000);

	// Hourly archived channel retention cleanup (pruning channels >= 1 week old)
	setInterval(
		() => {
			void cleanupOldArchivedMercChannels(client).catch((err) => {
				logger.warn(
					"Error running periodic archived channel cleanup pass:",
					err,
				);
			});
		},
		60 * 60 * 1000,
	);

	return setInterval(async () => {
		try {
			await processExpiredMercContractTokens(client);
		} catch (err) {
			logger.warn("Error running periodic expired token archiver pass:", err);
		}
	}, cadenceMs);
}
