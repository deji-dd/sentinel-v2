import {
	and,
	db,
	eq,
	guildConfigs,
	guildMonitoredFactions,
	isNotNull,
} from "@sentinel/database";
import type { FactionMember, FactionMembersResponse } from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type Client,
	TextChannel,
} from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

const ITEMS_PER_PAGE = 15;

export interface MonitoredReviveMember {
	id: number;
	name: string;
	isRevivable: boolean;
	reviveSetting: string;
	state: string;
	statusDescription: string;
	until: number | null;
	lastAction?: FactionMember["last_action"] | null;
}

// In-memory cache of resolved members per monitorId to make button pagination snappy
const rosterCache = new Map<
	string,
	{
		members: MonitoredReviveMember[];
		factionName: string;
		factionId: number;
		timestamp: number;
	}
>();

/**
 * Purges historical/stray messages in the monitoring channel, keeping only the active status message.
 */
async function purgeChannelHistoricalMessages(
	channel: TextChannel,
	keepMessageId: string,
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
			`Failed to purge historical messages in channel ${channel.id}:`,
			err,
		);
	}
}

/**
 * Filters and transforms faction members based on revive settings and real-time status.
 */
export function filterAndSortReviveMembers(
	members: FactionMember[],
): MonitoredReviveMember[] {
	const filtered: MonitoredReviveMember[] = [];

	for (const m of members) {
		// Edge case 1: explicitly turned off
		if (m.revive_setting === "No one") {
			continue;
		}

		// Edge case 2: If setting is "Unknown", include only if currently revivable
		if (m.revive_setting === "Unknown" && !m.is_revivable) {
			continue;
		}

		// Edge case 3: If setting is "Everyone" or "Friends & faction" OR is_revivable is true
		filtered.push({
			id: m.id,
			name: m.name,
			isRevivable: m.is_revivable,
			reviveSetting: m.revive_setting,
			state: m.status?.state ?? "Okay",
			statusDescription: m.status?.description ?? "",
			until: m.status?.until ?? null,
			lastAction: m.last_action ?? null,
		});
	}

	// Sort order:
	// 1. Most recent action first (timestamp descending)
	// 2. Alphabetical by name fallback
	filtered.sort((a, b) => {
		const aTime = a.lastAction?.timestamp ?? 0;
		const bTime = b.lastAction?.timestamp ?? 0;
		if (aTime !== bTime) {
			return bTime - aTime;
		}
		return a.name.localeCompare(b.name, undefined, {
			sensitivity: "base",
			numeric: true,
		});
	});

	return filtered;
}

/**
 * Builds the paginated embed and action row buttons for the Revives Roster.
 */
export function buildRevivesPayload(
	monitorId: string,
	factionName: string,
	factionId: number,
	members: MonitoredReviveMember[],
	page = 1,
	itemsPerPage = ITEMS_PER_PAGE,
) {
	const sortedMembers = [...members].sort((a, b) => {
		const aTime = a.lastAction?.timestamp ?? 0;
		const bTime = b.lastAction?.timestamp ?? 0;
		if (aTime !== bTime) {
			return bTime - aTime;
		}
		return a.name.localeCompare(b.name, undefined, {
			sensitivity: "base",
			numeric: true,
		});
	});

	const totalPages = Math.max(
		1,
		Math.ceil(sortedMembers.length / itemsPerPage),
	);
	const currentPage = Math.min(Math.max(1, page), totalPages);
	const startIndex = (currentPage - 1) * itemsPerPage;
	const pageMembers = sortedMembers.slice(
		startIndex,
		startIndex + itemsPerPage,
	);

	const memberLines = pageMembers.map((m) => {
		const profileUrl = `https://www.torn.com/profiles.php?XID=${m.id}`;
		const seenText = m.lastAction?.timestamp
			? ` • Seen <t:${m.lastAction.timestamp}:R>`
			: "";

		return `[${m.name} [${m.id}]](${profileUrl})${seenText}`;
	});

	const description =
		sortedMembers.length === 0
			? "No members found with revives enabled or currently revivable."
			: memberLines.join("\n");

	const revivableCount = sortedMembers.filter((m) => m.isRevivable).length;

	const embed = createBaseEmbed(
		`${factionName} [${factionId}] — Revivable Players`,
		description,
		revivableCount > 0 ? 0x10b981 : EMBED_COLORS.PRIMARY,
	);

	embed.setFooter({
		text: `Sentinel • Page ${currentPage} of ${totalPages} • Revivable: ${revivableCount}`,
	});
	embed.setTimestamp();

	const components: ActionRowBuilder<ButtonBuilder>[] = [];

	if (totalPages > 1) {
		const prevButton = new ButtonBuilder()
			.setCustomId(`monitoring_revives_page:${monitorId}:${currentPage - 1}`)
			.setLabel("◀ Previous")
			.setStyle(ButtonStyle.Primary)
			.setDisabled(currentPage <= 1);

		const pageIndicator = new ButtonBuilder()
			.setCustomId(`monitoring_revives_info:${monitorId}`)
			.setLabel(`${currentPage} / ${totalPages}`)
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(true);

		const nextButton = new ButtonBuilder()
			.setCustomId(`monitoring_revives_page:${monitorId}:${currentPage + 1}`)
			.setLabel("Next ▶")
			.setStyle(ButtonStyle.Primary)
			.setDisabled(currentPage >= totalPages);

		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			prevButton,
			pageIndicator,
			nextButton,
		);

		components.push(row);
	}

	return { embeds: [embed], components };
}

/**
 * Handles interactive button pagination clicks for the Revives Roster.
 */
export async function handleFactionMonitoringButton(
	interaction: ButtonInteraction,
): Promise<void> {
	try {
		if (!interaction.customId.startsWith("monitoring_revives_page:")) return;

		const parts = interaction.customId.split(":");
		const monitorId = parts[1];
		const targetPage = parseInt(parts[2] ?? "1", 10) || 1;

		if (!monitorId) return;

		// 1. Check cache first
		const cached = rosterCache.get(monitorId);
		if (cached && Date.now() - cached.timestamp < 120_000) {
			const payload = buildRevivesPayload(
				monitorId,
				cached.factionName,
				cached.factionId,
				cached.members,
				targetPage,
			);
			await interaction.update(payload);
			return;
		}

		// 2. Fallback to fresh fetch
		const monitor = await db.query.guildMonitoredFactions.findFirst({
			where: eq(guildMonitoredFactions.id, monitorId),
		});

		if (!monitor) {
			await interaction.reply({
				content: "Monitored faction configuration not found.",
				flags: 64, // Ephemeral
			});
			return;
		}

		const res = (await tornApi.get("/faction/{id}/members", {
			pathParams: { id: monitor.factionId },
		})) as FactionMembersResponse;

		const members = filterAndSortReviveMembers(res.members ?? []);
		const factionName = monitor.factionName || `Faction ${monitor.factionId}`;

		rosterCache.set(monitorId, {
			members,
			factionName,
			factionId: monitor.factionId,
			timestamp: Date.now(),
		});

		const payload = buildRevivesPayload(
			monitorId,
			factionName,
			monitor.factionId,
			members,
			targetPage,
		);

		await interaction.update(payload);
	} catch (err) {
		logger.error(
			"Failed to handle faction monitoring revives pagination button:",
			err,
		);
	}
}

/**
 * Updates the designated revives channel for one or all active monitored factions.
 */
export async function updateFactionRevivesChannel(
	client: Client,
	guildId?: string,
	monitorId?: string,
): Promise<void> {
	try {
		const monitors = monitorId
			? await db.query.guildMonitoredFactions.findMany({
					where: eq(guildMonitoredFactions.id, monitorId),
				})
			: guildId
				? await db.query.guildMonitoredFactions.findMany({
						where: and(
							eq(guildMonitoredFactions.guildId, guildId),
							eq(guildMonitoredFactions.revivesEnabled, true),
							isNotNull(guildMonitoredFactions.revivesChannelId),
						),
					})
				: await db.query.guildMonitoredFactions.findMany({
						where: and(
							eq(guildMonitoredFactions.revivesEnabled, true),
							isNotNull(guildMonitoredFactions.revivesChannelId),
						),
					});

		for (const monitor of monitors) {
			if (!monitor.revivesChannelId || !monitor.revivesEnabled) continue;

			// Verify that the guild has the monitoring module enabled
			const guildConfig = await db.query.guildConfigs.findFirst({
				where: eq(guildConfigs.guildId, monitor.guildId),
			});

			if (!guildConfig?.moduleMonitoring) {
				continue;
			}

			try {
				const channel = (await client.channels
					.fetch(monitor.revivesChannelId)
					.catch(() => null)) as TextChannel | null;

				if (!channel || !(channel instanceof TextChannel)) {
					logger.warn(
						`Revives monitoring channel ${monitor.revivesChannelId} for guild ${monitor.guildId} not found or invalid.`,
					);
					continue;
				}

				// Fetch live members from Torn API
				const res = (await tornApi.get("/faction/{id}/members", {
					pathParams: { id: monitor.factionId },
				})) as FactionMembersResponse;

				const members = filterAndSortReviveMembers(res.members ?? []);
				const factionName =
					monitor.factionName || `Faction ${monitor.factionId}`;

				rosterCache.set(monitor.id, {
					members,
					factionName,
					factionId: monitor.factionId,
					timestamp: Date.now(),
				});

				const payload = buildRevivesPayload(
					monitor.id,
					factionName,
					monitor.factionId,
					members,
					1,
				);

				const firstMsgId = monitor.revivesMessageIds[0];
				let activeMsgId: string | null = null;

				// Try to edit existing tracked message in place to avoid channel spam
				const existingMsg = firstMsgId
					? await channel.messages.fetch(firstMsgId).catch(() => null)
					: null;

				if (existingMsg) {
					await existingMsg.edit({
						embeds: payload.embeds,
						components: payload.components,
					});
					activeMsgId = existingMsg.id;
				} else {
					const sentMsg = await channel.send({
						embeds: payload.embeds,
						components: payload.components,
					});
					activeMsgId = sentMsg.id;

					await db
						.update(guildMonitoredFactions)
						.set({
							revivesMessageIds: [sentMsg.id],
							lastRevivesCheckAt: new Date(),
							updatedAt: new Date(),
						})
						.where(eq(guildMonitoredFactions.id, monitor.id));
				}

				if (activeMsgId) {
					await db
						.update(guildMonitoredFactions)
						.set({
							lastRevivesCheckAt: new Date(),
							updatedAt: new Date(),
						})
						.where(eq(guildMonitoredFactions.id, monitor.id));

					await purgeChannelHistoricalMessages(channel, activeMsgId);
				}
			} catch (err) {
				logger.error(
					`Failed to update revives channel for faction ${monitor.factionId} (guild ${monitor.guildId}):`,
					err,
				);
			}
		}
	} catch (err) {
		logger.error("Failed to execute updateFactionRevivesChannel:", err);
	}
}
