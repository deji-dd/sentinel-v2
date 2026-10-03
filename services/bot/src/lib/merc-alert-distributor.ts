import {
	db,
	eq,
	getMercChannelConfig,
	type MercContract,
	type MercContractSummaryReport,
	mercContracts,
} from "@sentinel/database";
import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type Client,
	type EmbedBuilder,
	type Message,
	MessageFlags,
	type TextChannel,
} from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";
import { formatTctTimestamp } from "./torn-log-parser";

const API_BASE_URL =
	process.env.API_URL ||
	(process.env.PORT
		? `http://127.0.0.1:${process.env.PORT}`
		: "http://127.0.0.1:3002");

export function parseToEpochSeconds(ts: string | Date | number): number {
	if (typeof ts === "number") {
		return ts < 1e11 ? Math.floor(ts) : Math.floor(ts / 1000);
	}
	if (ts instanceof Date) {
		return Math.floor(ts.getTime() / 1000);
	}
	if (typeof ts === "string") {
		const num = Number(ts);
		if (!Number.isNaN(num) && /^\d+$/.test(ts.trim())) {
			return num < 1e11 ? Math.floor(num) : Math.floor(num / 1000);
		}
		const parsed = new Date(ts).getTime();
		if (!Number.isNaN(parsed)) {
			return Math.floor(parsed / 1000);
		}
	}
	return Math.floor(Date.now() / 1000);
}

function formatStats(num: number | null | undefined): string {
	if (!num || !Number.isFinite(num)) return "Unknown";
	if (num >= 1e15) return `${(num / 1e15).toFixed(2)}Q`;
	if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
	if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
	if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
	if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k`;
	return Math.round(num).toLocaleString();
}

/**
 * Finds a guild TextChannel by its ID or name (ignoring leading #, case-insensitive, with common aliases).
 */
export async function resolveChannelByName(
	client: Client,
	guildId: string,
	channelNameOrId: string,
): Promise<TextChannel | null> {
	if (!channelNameOrId?.trim()) {
		logger.warn(`Cannot resolve empty channel identifier in guild ${guildId}`);
		return null;
	}

	try {
		const guild =
			client.guilds.cache.get(guildId) ||
			(await client.guilds.fetch(guildId).catch(() => null));
		if (!guild) {
			logger.warn(`Guild ${guildId} not found in bot client cache or fetch`);
			return null;
		}

		// Ensure channels cache is populated if empty or minimal
		if (guild.channels.cache.size <= 1) {
			await guild.channels.fetch().catch(() => null);
		}

		const raw = channelNameOrId.trim();
		const cleanTargetName = raw.replace(/^#/, "").toLowerCase();

		// 1. Match by exact Discord channel ID
		const byId = guild.channels.cache.get(raw);
		if (byId?.isTextBased()) {
			return byId as TextChannel;
		}

		// 2. Match by exact channel name (case-insensitive)
		const byName = guild.channels.cache.find(
			(c) => c.isTextBased() && c.name.toLowerCase() === cleanTargetName,
		);
		if (byName) {
			return byName as TextChannel;
		}

		// 3. Fallback alias matches
		let fallbackName: string | null = null;
		if (cleanTargetName === "targets") fallbackName = "merc-targets";
		else if (cleanTargetName === "merc-targets") fallbackName = "targets";
		else if (
			cleanTargetName === "merc-logs" ||
			cleanTargetName === "merc-log"
		) {
			fallbackName = cleanTargetName === "merc-logs" ? "merc-log" : "merc-logs";
		}

		if (fallbackName) {
			const byFallback = guild.channels.cache.find(
				(c) => c.isTextBased() && c.name.toLowerCase() === fallbackName,
			);
			if (byFallback) {
				return byFallback as TextChannel;
			}
		}

		const available = guild.channels.cache
			.filter((c) => c.isTextBased())
			.map((c) => `#${c.name} (${c.id})`)
			.join(", ");
		logger.warn(
			`Channel "${channelNameOrId}" not found in guild "${guild.name}" (${guildId}). Available channels: ${available || "none"}`,
		);
		return null;
	} catch (err) {
		logger.error(
			`Error resolving channel "${channelNameOrId}" in guild ${guildId}:`,
			err,
		);
		return null;
	}
}

/**
 * Posts an upcoming mercenary contract announcement to the designated channel.
 * Strictly zero emojis.
 */
export async function postMercContractAnnouncement(
	client: Client,
	guildId: string,
	channelName: string,
	contract: MercContract,
	mercRoleId?: string | null,
): Promise<void> {
	try {
		const channel = await resolveChannelByName(client, guildId, channelName);
		if (!channel) {
			logger.warn(
				`Upcoming contracts channel "${channelName}" not found in guild ${guildId}`,
			);
			return;
		}

		const startDate = new Date(contract.startTime);
		const startEpoch = Math.floor(startDate.getTime() / 1000);
		const startTct = formatTctTimestamp(startDate);

		const endDate = contract.endTime ? new Date(contract.endTime) : null;
		const endEpoch = endDate ? Math.floor(endDate.getTime() / 1000) : null;
		const endTct = endDate ? formatTctTimestamp(endDate) : null;

		const factionProfileUrl = `https://www.torn.com/factions.php?step=profile&ID=${contract.factionId}`;

		let statusLabel = "UPCOMING CONTRACT";
		let embedColor = EMBED_COLORS.PRIMARY;
		if (contract.status === "active") {
			statusLabel = "ACTIVE CONTRACT";
			embedColor = EMBED_COLORS.SUCCESS;
		} else if (contract.status === "paused") {
			statusLabel = "PAUSED CONTRACT";
			embedColor = EMBED_COLORS.WARNING;
		} else if (contract.status === "completed") {
			statusLabel = "COMPLETED CONTRACT";
			embedColor = EMBED_COLORS.DARK;
		}

		const embed = createBaseEmbed(
			`[${statusLabel}] ${contract.factionName} [${contract.factionId}]`,
			`Contract registered for [${contract.factionName} [${contract.factionId}]](${factionProfileUrl}).`,
			embedColor,
		);

		embed.addFields(
			{
				name: "Status",
				value: contract.status.toUpperCase(),
				inline: true,
			},
			{
				name: "Start Time",
				value: `\`${startTct} TCT\` (<t:${startEpoch}:R>)`,
				inline: true,
			},
			{
				name: "End Time",
				value: contract.endOnWarEnd
					? "Ends on War Conclusion"
					: endEpoch && endTct
						? `\`${endTct} TCT\` (<t:${endEpoch}:R>)`
						: "No Expiration",
				inline: true,
			},
			{
				name: "Standard Hit Value",
				value: `$${(contract.hitPrice ?? 0).toLocaleString()}`,
				inline: true,
			},
			{
				name: "Stricken Hit Value",
				value: contract.strickenHitPrice
					? `$${contract.strickenHitPrice.toLocaleString()}`
					: "Not Applicable",
				inline: true,
			},
			{
				name: "Target Statuses",
				value: [
					contract.terms.statuses.online ? "Online" : null,
					contract.terms.statuses.idle
						? `Idle (${contract.terms.idleDurationMinutes ?? 15}m min)`
						: null,
					contract.terms.statuses.offline ? "Offline" : null,
				]
					.filter(Boolean)
					.join(", "),
				inline: true,
			},
			{
				name: "Level Range",
				value: `Level ${contract.terms.levelRange[0]} - ${contract.terms.levelRange[1]}`,
				inline: true,
			},
		);

		if (contract.autoStopPrice && contract.autoStopPrice > 0) {
			embed.addFields({
				name: "Auto-Stop Budget",
				value: `$${contract.autoStopPrice.toLocaleString()}`,
				inline: true,
			});
		}

		embed.setFooter({ text: `Contract ID: ${contract.id}` });

		const baseUrl =
			process.env.DASHBOARD_URL ||
			(process.env.NODE_ENV === "production"
				? "https://dashboard.blasted-labs.tech"
				: "http://localhost:3000");
		const receiptUrl = `${baseUrl}/#/merc/receipt/${contract.id}`;

		const receiptRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setStyle(ButtonStyle.Link)
				.setLabel("Live Receipt")
				.setURL(receiptUrl),
		);

		// If message was already posted, edit it in place rather than creating duplicate messages
		let existingMsg: Message | null = null;
		if (contract.upcomingMessageId) {
			try {
				existingMsg = await channel.messages.fetch(contract.upcomingMessageId);
			} catch {
				// message was deleted or not found
			}
		}

		if (existingMsg) {
			await existingMsg.edit({
				embeds: [embed],
				components: [receiptRow],
			});
			logger.info(
				`Edited existing announcement message ${existingMsg.id} for contract ${contract.id} (${contract.status})`,
			);
			return;
		}

		// Initial post: include role mention and record message ID
		const mentionContent = mercRoleId ? `<@&${mercRoleId}>` : undefined;
		const sentMessage = await channel.send({
			content: mentionContent,
			embeds: [embed],
			components: [receiptRow],
		});

		try {
			const channelConfig = await getMercChannelConfig(guildId);
			const isUpcoming =
				channelConfig.upcomingContracts &&
				(channel.name.toLowerCase() ===
					channelConfig.upcomingContracts.toLowerCase() ||
					channel.id === channelConfig.upcomingContracts);

			if (isUpcoming) {
				await db
					.update(mercContracts)
					.set({
						upcomingMessageId: sentMessage.id,
						upcomingChannelId: channel.id,
					})
					.where(eq(mercContracts.id, contract.id));
			}
		} catch (dbErr) {
			logger.warn(
				`Failed to record upcoming contract message ID for contract ${contract.id}:`,
				dbErr,
			);
		}
	} catch (err) {
		logger.error("Failed to post mercenary contract announcement:", err);
	}
}

/**
 * Deletes the respective announcement embed from the upcoming contracts channel when a contract concludes.
 * Checks stored upcomingMessageId/upcomingChannelId and falls back to scanning the upcoming channel for matching embeds.
 */
export async function deleteUpcomingContractAnnouncement(
	client: Client,
	guildId: string,
	contract: {
		id: string;
		factionId: number;
		upcomingMessageId?: string | null;
		upcomingChannelId?: string | null;
	},
): Promise<void> {
	try {
		const channelConfig = await getMercChannelConfig(guildId);
		let targetChannel: TextChannel | null = null;

		// 1. If stored upcomingChannelId exists, try resolving by ID or name
		if (contract.upcomingChannelId) {
			const ch = await resolveChannelByName(
				client,
				guildId,
				contract.upcomingChannelId,
			);
			if (ch && "messages" in ch) {
				targetChannel = ch as TextChannel;
			}
		}

		// 2. If not found, resolve via configured upcomingContracts channel
		if (!targetChannel && channelConfig.upcomingContracts) {
			const ch = await resolveChannelByName(
				client,
				guildId,
				channelConfig.upcomingContracts,
			);
			if (ch && "messages" in ch) {
				targetChannel = ch as TextChannel;
			}
		}

		if (!targetChannel) {
			logger.warn(
				`Could not resolve upcoming contracts channel for guild ${guildId} to delete announcement for contract ${contract.id}`,
			);
			return;
		}

		let deleted = false;

		// 3. Try deleting via specific messageId if stored
		if (contract.upcomingMessageId) {
			try {
				const msg = await targetChannel.messages.fetch(
					contract.upcomingMessageId,
				);
				if (msg) {
					await msg.delete();
					deleted = true;
					logger.info(
						`Deleted upcoming contract announcement message ${contract.upcomingMessageId} for contract ${contract.id}`,
					);
				}
			} catch {
				logger.warn(
					`Message ${contract.upcomingMessageId} not found directly in #${targetChannel.name}, falling back to scan...`,
				);
			}
		}

		// 4. Fallback guard: scan recent messages in the upcoming channel for matching embed
		if (!deleted) {
			const recentMessages = await targetChannel.messages.fetch({ limit: 50 });
			for (const [, msg] of recentMessages) {
				if (msg.author.id !== client.user?.id) continue;

				const matches = msg.embeds.some((e) => {
					const hasContractId = e.footer?.text?.includes(contract.id);
					const hasFactionTag =
						e.title?.includes(`[${contract.factionId}]`) ||
						e.description?.includes(`[${contract.factionId}]`);
					const isUpcoming = e.title
						?.toUpperCase()
						.includes("[UPCOMING CONTRACT]");
					return (hasContractId || hasFactionTag) && isUpcoming;
				});

				if (matches) {
					await msg.delete();
					deleted = true;
					logger.info(
						`Deleted matched upcoming contract announcement embed (Message ID: ${msg.id}) for contract ${contract.id}`,
					);
					break;
				}
			}
		}

		// Clear message ID from DB record
		try {
			await db
				.update(mercContracts)
				.set({ upcomingMessageId: null })
				.where(eq(mercContracts.id, contract.id));
		} catch {}
	} catch (err) {
		logger.error(
			`Failed to delete upcoming contract announcement for contract ${contract.id}:`,
			err,
		);
	}
}

/**
 * Builds interactive button ActionRow for a mercenary target embed. Zero emojis.
 */
function buildMercTargetActionRow(
	contractId: string,
	targetId: number,
	status: "open" | "claimed",
): ActionRowBuilder<ButtonBuilder> {
	const row = new ActionRowBuilder<ButtonBuilder>();

	if (status === "open") {
		row.addComponents(
			new ButtonBuilder()
				.setCustomId(`merc_claim:${contractId}:${targetId}`)
				.setLabel("Claim Target")
				.setStyle(ButtonStyle.Primary),
		);
	} else {
		row.addComponents(
			new ButtonBuilder()
				.setCustomId(`merc_release:${contractId}:${targetId}`)
				.setLabel("Release Target")
				.setStyle(ButtonStyle.Secondary),
		);
	}

	row.addComponents(
		new ButtonBuilder()
			.setStyle(ButtonStyle.Link)
			.setLabel("Profile")
			.setURL(`https://www.torn.com/profiles.php?XID=${targetId}`),
		new ButtonBuilder()
			.setStyle(ButtonStyle.Link)
			.setLabel("Attack")
			.setURL(`https://www.torn.com/page.php?sid=attack&user2ID=${targetId}`),
	);

	return row;
}

export interface MercTargetAlertData {
	targetId: number;
	targetName: string;
	targetLevel: number;
	estimatedBs: number;
	hospitalUntil: number | null;
	status: "open" | "claimed";
	claimedBy?: {
		discordId: string;
		discordTag: string;
		tornId?: number;
		tornName?: string;
	};
	claimedAt?: number;
	isStrickenEligible?: boolean;
	rwCooldownUntil?: number | null;
}

/**
 * Posts or reposts a mercenary target alert embed into the targets channel. Zero emojis.
 */
export async function postMercTargetAlert(
	client: Client,
	guildId: string,
	channelName: string,
	contractId: string,
	target: MercTargetAlertData,
	mercRoleId?: string | null,
): Promise<string | null> {
	try {
		const channel = await resolveChannelByName(client, guildId, channelName);
		if (!channel) return null;

		const targetProfileUrl = `https://www.torn.com/profiles.php?XID=${target.targetId}`;
		let desc = `Target: [${target.targetName} [${target.targetId}]](${targetProfileUrl})\nLevel ${target.targetLevel} | Estimated BS: ${formatStats(target.estimatedBs)}`;

		if (target.isStrickenEligible) {
			desc += "\n\n**STRICKEN HIT ELIGIBLE**";
		}

		const embed = createBaseEmbed(
			target.isStrickenEligible
				? `[STRICKEN TARGET] ${target.targetName} [${target.targetId}]`
				: `Target: ${target.targetName} [${target.targetId}]`,
			desc,
			target.isStrickenEligible
				? EMBED_COLORS.DANGER
				: target.status === "claimed"
					? EMBED_COLORS.WARNING
					: EMBED_COLORS.PRIMARY,
		);

		if (
			target.hospitalUntil &&
			target.hospitalUntil > Math.floor(Date.now() / 1000)
		) {
			embed.addFields({
				name: "Hospital Exit",
				value: `<t:${target.hospitalUntil}:R> (<t:${target.hospitalUntil}:T>)`,
				inline: true,
			});
		}

		if (
			target.rwCooldownUntil &&
			target.rwCooldownUntil > Math.floor(Date.now() / 1000)
		) {
			embed.addFields({
				name: "Ranked War Cooldown",
				value: `<t:${target.rwCooldownUntil}:R> (<t:${target.rwCooldownUntil}:T>) - Immune`,
				inline: true,
			});
		}

		const statusText =
			target.status === "claimed"
				? `Claimed by ${target.claimedBy?.tornName ?? target.claimedBy?.discordTag ?? "Teammate"} (<t:${Math.floor((target.claimedAt || Date.now()) / 1000)}:R>)`
				: "Available for Claim";

		embed.addFields({
			name: "Status",
			value: statusText,
			inline: true,
		});

		const row = buildMercTargetActionRow(
			contractId,
			target.targetId,
			target.status,
		);
		const mentionContent = mercRoleId ? `<@&${mercRoleId}>` : undefined;

		const msg = await channel.send({
			content: mentionContent,
			embeds: [embed],
			components: [row],
		});

		logger.info(
			`Posted merc target alert for ${target.targetName} [${target.targetId}] in #${channel.name} (${guildId}), messageId=${msg.id}`,
		);

		return msg.id;
	} catch (err) {
		logger.error("Failed to post mercenary target alert:", err);
		return null;
	}
}

/**
 * Updates an existing mercenary target alert embed when claimed or released. Zero emojis.
 */
export async function updateMercTargetAlert(
	client: Client,
	guildId: string,
	channelName: string,
	messageId: string,
	contractId: string,
	target: MercTargetAlertData,
): Promise<void> {
	try {
		const channel = await resolveChannelByName(client, guildId, channelName);
		if (!channel) return;

		const message = await channel.messages.fetch(messageId).catch(() => null);
		if (!message) return;

		const targetProfileUrl = `https://www.torn.com/profiles.php?XID=${target.targetId}`;
		let desc = `Target: [${target.targetName} [${target.targetId}]](${targetProfileUrl})\nLevel ${target.targetLevel} | Estimated BS: ${formatStats(target.estimatedBs)}`;

		if (target.isStrickenEligible) {
			desc += "\n\n**STRICKEN HIT ELIGIBLE**";
		}

		const embed = createBaseEmbed(
			target.isStrickenEligible
				? `[STRICKEN TARGET] ${target.targetName} [${target.targetId}]`
				: `Target: ${target.targetName} [${target.targetId}]`,
			desc,
			target.isStrickenEligible
				? EMBED_COLORS.DANGER
				: target.status === "claimed"
					? EMBED_COLORS.WARNING
					: EMBED_COLORS.PRIMARY,
		);

		if (
			target.hospitalUntil &&
			target.hospitalUntil > Math.floor(Date.now() / 1000)
		) {
			embed.addFields({
				name: "Hospital Exit",
				value: `<t:${target.hospitalUntil}:R> (<t:${target.hospitalUntil}:T>)`,
				inline: true,
			});
		}

		if (
			target.rwCooldownUntil &&
			target.rwCooldownUntil > Math.floor(Date.now() / 1000)
		) {
			embed.addFields({
				name: "Ranked War Cooldown",
				value: `<t:${target.rwCooldownUntil}:R> (<t:${target.rwCooldownUntil}:T>) - Immune`,
				inline: true,
			});
		}

		const statusText =
			target.status === "claimed"
				? `Claimed by ${target.claimedBy?.tornName ?? target.claimedBy?.discordTag ?? "Teammate"} (<t:${Math.floor((target.claimedAt || Date.now()) / 1000)}:R>)`
				: "Available for Claim";

		embed.addFields({
			name: "Status",
			value: statusText,
			inline: true,
		});

		const row = buildMercTargetActionRow(
			contractId,
			target.targetId,
			target.status,
		);
		await message.edit({ embeds: [embed], components: [row] });
	} catch (err) {
		logger.warn("Failed to update mercenary target alert:", err);
	}
}

/**
 * Deletes a mercenary target alert message (when target invalidated or downed).
 */
export async function deleteMercTargetAlert(
	client: Client,
	guildId: string,
	channelName: string,
	messageId: string,
): Promise<void> {
	try {
		const channel = await resolveChannelByName(client, guildId, channelName);
		if (!channel) return;

		const message = await channel.messages.fetch(messageId).catch(() => null);
		if (message) {
			await message.delete().catch(() => {});
		}
	} catch (err) {
		logger.warn("Failed to delete mercenary target alert:", err);
	}
}

/**
 * Deletes every active target alert message belonging to a contract.
 * Used when a contract is paused so no mercenary can claim a live target
 * while the contract is halted.
 */
export async function deleteAllMercTargetAlerts(
	client: Client,
	guildId: string,
	channelName: string,
	contractId: string,
): Promise<number> {
	try {
		const channel = await resolveChannelByName(client, guildId, channelName);
		if (!channel) return 0;

		// Target alerts live in the dedicated targets channel and are always
		// bot-authored Sentinel embeds. Hit logs go to a separate merc-log
		// channel, so restricting to this channel is sufficient.
		const messages = await channel.messages.fetch({ limit: 100 });
		let deleted = 0;

		for (const message of messages.values()) {
			const embed = message.embeds?.[0];
			if (!embed) continue;
			if (message.author.bot && embed.footer?.text === "Sentinel") {
				await message.delete().catch(() => {});
				deleted++;
			}
		}

		logger.info(
			`Cleared ${deleted} target alert(s) from ${channelName} for paused contract ${contractId}.`,
		);
		return deleted;
	} catch (err) {
		logger.warn("Failed to delete all mercenary target alerts:", err);
		return 0;
	}
}

/**
 * Posts a validated hit log to the Merc Log channel. Zero emojis.
 */
export async function postMercHitLog(
	client: Client,
	guildId: string,
	channelName: string,
	hitData: {
		attackerName: string;
		attackerId: number;
		defenderName: string;
		defenderId: number;
		result: string;
		isStricken: boolean;
		payoutValue: number;
		attackId: number;
		attackCode?: string;
		timestamp: string | Date | number;
	},
): Promise<void> {
	try {
		const channel = await resolveChannelByName(client, guildId, channelName);
		if (!channel) return;

		const logId = hitData.attackCode || hitData.attackId;
		const attackUrl = `https://www.torn.com/page.php?sid=attackLog&ID=${logId}`;

		let payoutDesc = `Payout: $${hitData.payoutValue.toLocaleString()}`;
		if (hitData.isStricken && hitData.payoutValue > 0) {
			payoutDesc = `Payout: $${hitData.payoutValue.toLocaleString()} [STRICKEN HIT]`;
		} else if (hitData.payoutValue === 0) {
			payoutDesc = "Payout: $0 (No payout - not a hospitalization)";
		}

		const desc = `${hitData.attackerName} [${hitData.attackerId}] ${hitData.result.toLowerCase()} ${hitData.defenderName} [${hitData.defenderId}]\n${payoutDesc}`;

		const embedColor = hitData.isStricken
			? EMBED_COLORS.DANGER
			: hitData.payoutValue > 0
				? EMBED_COLORS.SUCCESS
				: EMBED_COLORS.PRIMARY;

		const embedTitle = hitData.isStricken
			? `[STRICKEN HIT] ${hitData.attackerName} [${hitData.attackerId}]`
			: hitData.payoutValue > 0
				? `[VALIDATED HIT] ${hitData.attackerName} [${hitData.attackerId}]`
				: `[HIT REPORTED] ${hitData.attackerName} [${hitData.attackerId}]`;

		const embed = createBaseEmbed(embedTitle, desc, embedColor);

		const epochSec = parseToEpochSeconds(hitData.timestamp);
		const hitDate = new Date(epochSec * 1000);
		const pad = (n: number) => n.toString().padStart(2, "0");
		const tctTimeString = `${pad(hitDate.getUTCHours())}:${pad(hitDate.getUTCMinutes())}:${pad(hitDate.getUTCSeconds())} TCT`;

		embed.addFields(
			{
				name: "Attack Log",
				value: `[View Attack Log](${attackUrl})`,
				inline: true,
			},
			{
				name: "Time",
				value: `\`${tctTimeString}\` (<t:${epochSec}:R>)`,
				inline: true,
			},
		);

		await channel.send({ embeds: [embed] });
	} catch (err) {
		logger.error("Failed to post mercenary hit log:", err);
	}
}

export interface MercContractReceiptPayload {
	embed: EmbedBuilder;
	files: AttachmentBuilder[];
	components: ActionRowBuilder<ButtonBuilder>[];
	targetCsv: string;
}

/**
 * Builds the standardized receipt embed, CSV attachments, and web receipt button for a mercenary contract.
 * Shared across war end summary notifications and the /receipt Discord slash command.
 */
export function buildMercContractReceiptPayload(
	contract: MercContract,
	summary: MercContractSummaryReport,
): MercContractReceiptPayload {
	// CSV 1: Merc Payouts & Hit Breakdown (Combined)
	let csvCombined =
		"Mercenary Name,Torn ID,Faction,Total Hits,Standard Hits,Stricken Hits,Total Payout ($)\n";
	for (const m of summary.mercPayouts) {
		const fName =
			m.attackerFactionName ??
			(m.attackerFactionId ? `Faction #${m.attackerFactionId}` : "N/A");
		csvCombined += `"${m.attackerName.replace(/"/g, '""')}",${m.attackerId},"${fName.replace(/"/g, '""')}",${m.totalHits},${m.standardHits},${m.strickenHits},${m.totalPayout}\n`;
	}

	// CSV Per-Faction Merc Payouts (e.g. 2 different factions split)
	const mercAttachments: AttachmentBuilder[] = [
		new AttachmentBuilder(Buffer.from(csvCombined, "utf-8"), {
			name: `merc_payouts_combined_${contract.id}.csv`,
		}),
	];

	if (summary.factionPayouts && summary.factionPayouts.length > 0) {
		for (const fp of summary.factionPayouts) {
			const safeFaction = fp.factionName
				.replace(/[^a-zA-Z0-9_-]/g, "_")
				.toLowerCase();
			let csvFaction =
				"Mercenary Name,Torn ID,Faction,Total Hits,Standard Hits,Stricken Hits,Total Payout ($)\n";
			for (const m of fp.mercs) {
				csvFaction += `"${m.attackerName.replace(/"/g, '""')}",${m.attackerId},"${fp.factionName.replace(/"/g, '""')}",${m.totalHits},${m.standardHits},${m.strickenHits},${m.totalPayout}\n`;
			}
			mercAttachments.push(
				new AttachmentBuilder(Buffer.from(csvFaction, "utf-8"), {
					name: `merc_payouts_${safeFaction}_${contract.id}.csv`,
				}),
			);
		}
	}

	// CSV Target Hit Breakdown (Client receipt)
	let csvTarget =
		"Target Name,Torn ID,Total Times Hit,Standard Hits Received,Stricken Hits Received\n";
	for (const t of summary.targetBreakdown) {
		csvTarget += `"${t.defenderName.replace(/"/g, '""')}",${t.defenderId},${t.totalHits},${t.standardHitsReceived},${t.strickenHitsReceived}\n`;
	}

	const targetFile = new AttachmentBuilder(Buffer.from(csvTarget, "utf-8"), {
		name: `target_hit_breakdown_${contract.id}.csv`,
	});

	const isCompleted = contract.status === "completed";
	const titlePrefix = isCompleted
		? "[CONTRACT CONCLUDED]"
		: "[CONTRACT RECEIPT]";
	const statusDesc = isCompleted
		? "Contract has completed."
		: `Status: ${contract.status.toUpperCase()}`;

	const embed = createBaseEmbed(
		`${titlePrefix} ${contract.factionName} [${contract.factionId}]`,
		`${statusDesc}\n\nTotal Validated Hits: ${summary.totalHits}\nTotal Payout: $${summary.totalPayout.toLocaleString()}`,
		EMBED_COLORS.PRIMARY,
	);

	embed.addFields(
		{
			name: "Participating Mercenaries",
			value: `${summary.mercPayouts.length}`,
			inline: true,
		},
		{
			name: "Targets Hit",
			value: `${summary.targetBreakdown.length}`,
			inline: true,
		},
	);

	if (summary.factionPayouts && summary.factionPayouts.length > 0) {
		for (const fp of summary.factionPayouts) {
			embed.addFields({
				name: `${fp.factionName} Payout`,
				value: `${fp.mercs.length} mercs • ${fp.totalHits} hits • $${fp.totalPayout.toLocaleString()}`,
				inline: true,
			});
		}
	}

	embed.setFooter({ text: `Contract ID: ${contract.id}` });

	const baseUrl =
		process.env.DASHBOARD_URL ||
		(process.env.NODE_ENV === "production"
			? "https://dashboard.blasted-labs.tech"
			: "http://localhost:3000");
	const receiptUrl = `${baseUrl}/#/merc/receipt/${contract.id}`;

	const receiptRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setStyle(ButtonStyle.Link)
			.setLabel("View Web Receipt")
			.setURL(receiptUrl),
	);

	return {
		embed,
		files: [...mercAttachments, targetFile],
		components: [receiptRow],
		targetCsv: csvTarget,
	};
}

/**
 * Posts contract conclusion summary and attaches two CSV files to Merc Log. Zero emojis.
 */
export async function postMercContractEndSummary(
	client: Client,
	guildId: string,
	channelName: string,
	contract: MercContract,
	summary: MercContractSummaryReport,
): Promise<void> {
	try {
		// Guard: auto-delete respective announcement embed from upcoming contracts channel
		await deleteUpcomingContractAnnouncement(client, guildId, contract);

		const channel = await resolveChannelByName(client, guildId, channelName);
		if (!channel) return;

		const payload = buildMercContractReceiptPayload(contract, summary);

		await channel.send({
			embeds: [payload.embed],
			files: payload.files,
			components: payload.components,
		});

		// If contract has a designated client private channel, post conclusion summary + target CSV + archive button
		if (contract.clientChannelId) {
			try {
				const clientChan = await resolveChannelByName(
					client,
					guildId,
					contract.clientChannelId,
				);
				if (clientChan) {
					const clientFile = new AttachmentBuilder(
						Buffer.from(payload.targetCsv, "utf-8"),
						{
							name: `target_hit_breakdown_${contract.id}.csv`,
						},
					);

					const clientEmbed = createBaseEmbed(
						`[CONTRACT CONCLUDED] ${contract.factionName} [${contract.factionId}]`,
						`Your mercenary contract has concluded.\n\nTotal Hits Completed: **${summary.totalHits}**\nTotal Cost: **$${summary.totalPayout.toLocaleString()}**\n\nThe full breakdown of hits against your faction members is attached below as a CSV.`,
						EMBED_COLORS.PRIMARY,
					);

					const archiveRow =
						new ActionRowBuilder<ButtonBuilder>().addComponents(
							new ButtonBuilder()
								.setCustomId(`merc_archive_channel:${contract.id}`)
								.setLabel("Archive Channel")
								.setStyle(ButtonStyle.Danger),
						);

					await clientChan.send({
						embeds: [clientEmbed],
						files: [clientFile],
						components: [archiveRow],
					});
				}
			} catch (cErr) {
				logger.warn(
					`Failed to post conclusion summary to client channel ${contract.clientChannelId}:`,
					cErr,
				);
			}
		}
	} catch (err) {
		logger.error(
			"Failed to post contract end summary and CSV attachments:",
			err,
		);
	}
}

/**
 * Handles Discord button click for claiming a mercenary target.
 */
export async function handleMercClaimButton(
	interaction: ButtonInteraction,
): Promise<void> {
	const parts = interaction.customId.split(":");
	const contractId = parts[1];
	const targetId = Number.parseInt(parts[2] ?? "", 10);
	if (!contractId || !targetId || Number.isNaN(targetId)) return;

	try {
		const res = await fetch(`${API_BASE_URL}/v2/merc/targets/claim-discord`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contractId,
				targetId,
				discordUserId: interaction.user.id,
				discordUsername: interaction.user.tag || interaction.user.username,
			}),
		});

		const json = (await res.json()) as { success?: boolean; error?: string };
		if (json.success) {
			await interaction.reply({
				content:
					"Target claim confirmed. You have 20 seconds to initiate attack once the target exits hospital and Ranked War cooldown concludes.",
				flags: MessageFlags.Ephemeral,
			});
		} else {
			await interaction.reply({
				content: json.error || "Unable to claim target.",
				flags: MessageFlags.Ephemeral,
			});
		}
	} catch {
		await interaction
			.reply({
				content: "Internal error processing claim. Please try again.",
				flags: MessageFlags.Ephemeral,
			})
			.catch(() => {});
	}
}

/**
 * Handles Discord button click for releasing a claimed mercenary target.
 */
export async function handleMercReleaseButton(
	interaction: ButtonInteraction,
): Promise<void> {
	const parts = interaction.customId.split(":");
	const contractId = parts[1];
	const targetId = Number.parseInt(parts[2] ?? "", 10);
	if (!contractId || !targetId || Number.isNaN(targetId)) return;

	try {
		const res = await fetch(`${API_BASE_URL}/v2/merc/targets/release-discord`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contractId,
				targetId,
				discordUserId: interaction.user.id,
			}),
		});

		const json = (await res.json()) as { success?: boolean; error?: string };
		if (json.success) {
			await interaction.reply({
				content: "Target claim released.",
				flags: MessageFlags.Ephemeral,
			});
		} else {
			await interaction.reply({
				content: json.error || "Unable to release claim.",
				flags: MessageFlags.Ephemeral,
			});
		}
	} catch {
		await interaction
			.reply({
				content: "Internal error processing release.",
				flags: MessageFlags.Ephemeral,
			})
			.catch(() => {});
	}
}
