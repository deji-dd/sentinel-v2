import { db, eq, factions } from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import type { Client, EmbedBuilder, TextChannel } from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";

const logger = new Logger("TerritoryAlertDistributor");

const EVENT_COLORS = {
	ASSAULT_START: EMBED_COLORS.DANGER,
	ASSAULT_SUCCEED: EMBED_COLORS.SUCCESS,
	ASSAULT_FAIL: EMBED_COLORS.PRIMARY,
	PEACE_TREATY: EMBED_COLORS.WARNING,
	TT_CLAIM: EMBED_COLORS.SUCCESS,
	TT_DROP: EMBED_COLORS.DANGER,
	RACKET_SPAWN: 0x9b59b6,
	RACKET_DESPAWN: 0x95a5a6,
	RACKET_LEVEL_UP: EMBED_COLORS.SUCCESS,
	RACKET_LEVEL_DOWN: EMBED_COLORS.WARNING,
};

/**
 * Resolves a faction display string formatted as markdown hyperlink [Name [ID]](url)
 */
async function formatFactionLink(
	factionId: number | null | undefined,
): Promise<string> {
	if (!factionId) return "*None*";
	try {
		const faction = await db.query.factions.findFirst({
			where: eq(factions.id, factionId),
		});
		const name = faction?.name || `Faction ${factionId}`;
		return `[${name} [${factionId}]](https://www.torn.com/factions.php?step=profile&ID=${factionId})`;
	} catch {
		return `[Faction ${factionId}](https://www.torn.com/factions.php?step=profile&ID=${factionId})`;
	}
}

/**
 * Handles incoming territory IPC events from worker and dispatches alert embeds
 * to all Discord guilds configured with the territory module and matching filters.
 */
export async function handleTerritoryAlert(
	client: Client,
	action: string,
	data: Record<string, unknown>,
): Promise<void> {
	try {
		// Query all guilds with the territory module enabled and at least one alert channel configured
		const allConfigs = await db.query.guildConfigs.findMany();
		const configs = allConfigs.filter(
			(cfg) =>
				cfg.enabledModules.includes("territory") &&
				(cfg.ttFullChannelId !== null || cfg.ttFilteredChannelId !== null),
		);

		if (configs.length === 0) return;

		const territoryCode =
			typeof data.tt === "string"
				? data.tt
				: typeof data.id === "string"
					? data.id
					: "";

		/** Markdown hyperlink to the territory on the Torn city map. */
		const ttLink = territoryCode
			? `[${territoryCode}](https://www.torn.com/city.php#terrName=${territoryCode})`
			: "*Unknown*";

		const assaultingFactionId =
			typeof data.assaultingFaction === "number"
				? data.assaultingFaction
				: null;
		const defendingFactionId =
			typeof data.defendingFaction === "number" ? data.defendingFaction : null;
		const victorFactionId =
			typeof data.victorFaction === "number" ? data.victorFaction : null;
		const factionId =
			typeof data.factionId === "number" ? data.factionId : null;

		const involvedFactions = [
			assaultingFactionId,
			defendingFactionId,
			victorFactionId,
			factionId,
		].filter((id): id is number => id !== null);

		// Map each config to target channel IDs
		const dispatchList: { guildId: string; channelIds: string[] }[] = [];

		for (const cfg of configs) {
			const channelIds = new Set<string>();

			// 1. Full feed channel receives all territory events unconditionally
			if (cfg.ttFullChannelId) {
				channelIds.add(cfg.ttFullChannelId);
			}

			// 2. Filtered channel receives events matching territory or faction filters
			if (cfg.ttFilteredChannelId) {
				const hasTerritoryFilter = cfg.ttTerritoryIds.length > 0;
				const hasFactionFilter = cfg.ttFactionIds.length > 0;

				let territoryMatch = false;
				if (hasTerritoryFilter && territoryCode) {
					territoryMatch = cfg.ttTerritoryIds.includes(territoryCode);
				}

				let factionMatch = false;
				if (hasFactionFilter) {
					factionMatch = involvedFactions.some((id) =>
						cfg.ttFactionIds.includes(id),
					);
				}

				// If filters exist, must match at least one filter. If no filters configured, send all.
				const isMatch =
					!hasTerritoryFilter && !hasFactionFilter
						? true
						: territoryMatch || factionMatch;

				if (isMatch) {
					channelIds.add(cfg.ttFilteredChannelId);
				}
			}

			if (channelIds.size > 0) {
				dispatchList.push({
					guildId: cfg.guildId,
					channelIds: Array.from(channelIds),
				});
			}
		}

		if (dispatchList.length === 0) return;

		// Build Event Embed
		const assaultingStr = await formatFactionLink(assaultingFactionId);
		const defendingStr = await formatFactionLink(defendingFactionId);
		const victorStr = await formatFactionLink(victorFactionId);
		const factionStr = await formatFactionLink(factionId);

		let embed: EmbedBuilder;

		switch (action) {
			case "assault_start":
				embed = createBaseEmbed(
					`Assault Started • ${territoryCode}`,
					undefined,
					EVENT_COLORS.ASSAULT_START,
				).addFields(
					{ name: "Territory", value: ttLink, inline: true },
					{ name: "Assaulting Faction", value: assaultingStr, inline: true },
					{ name: "Defending Faction", value: defendingStr, inline: true },
				);
				break;

			case "assault_succeed":
				embed = createBaseEmbed(
					`Assault Succeeded • ${territoryCode}`,
					undefined,
					EVENT_COLORS.ASSAULT_SUCCEED,
				).addFields(
					{ name: "Territory", value: ttLink, inline: true },
					{ name: "Assaulting Faction", value: assaultingStr, inline: true },
					{ name: "Defending Faction", value: defendingStr, inline: true },
					{ name: "Victor", value: victorStr, inline: true },
				);
				break;

			case "assault_fail":
				embed = createBaseEmbed(
					`Assault Failed • ${territoryCode}`,
					undefined,
					EVENT_COLORS.ASSAULT_FAIL,
				).addFields(
					{ name: "Territory", value: ttLink, inline: true },
					{ name: "Assaulting Faction", value: assaultingStr, inline: true },
					{ name: "Defending Faction", value: defendingStr, inline: true },
				);
				break;

			case "peace_treaty":
				embed = createBaseEmbed(
					`Peace Treaty • ${territoryCode}`,
					undefined,
					EVENT_COLORS.PEACE_TREATY,
				).addFields(
					{ name: "Territory", value: ttLink, inline: true },
					{ name: "Assaulting Faction", value: assaultingStr, inline: true },
					{ name: "Defending Faction", value: defendingStr, inline: true },
				);
				break;

			case "tt_claim":
				embed = createBaseEmbed(
					`Territory Claimed • ${territoryCode}`,
					undefined,
					EVENT_COLORS.TT_CLAIM,
				).addFields(
					{ name: "Territory", value: ttLink, inline: true },
					{ name: "New Owner", value: factionStr, inline: true },
				);
				break;

			case "tt_drop":
				embed = createBaseEmbed(
					`Territory Dropped • ${territoryCode}`,
					undefined,
					EVENT_COLORS.TT_DROP,
				).addFields(
					{ name: "Territory", value: ttLink, inline: true },
					{ name: "Previous Owner", value: factionStr, inline: true },
				);
				break;

			case "racket_spawn":
			case "racket_despawn":
			case "racket_level_up":
			case "racket_level_down": {
				type RacketReward = {
					type: string;
					quantity: number;
					id: number | null;
				};
				type RacketData = {
					name?: string;
					level?: number;
					reward?: RacketReward;
					description?: string;
				};
				const racket = data.racket as RacketData | null | undefined;
				const racketName = racket?.name || "Unknown Racket";
				const rewardStr = racket?.reward
					? `${racket.reward.quantity}x ${racket.reward.type}`
					: null;

				let title = `Racket Alert • ${territoryCode}`;
				let color = EVENT_COLORS.RACKET_SPAWN;

				if (action === "racket_spawn") {
					title = `Racket Spawned • ${territoryCode}`;
					color = EVENT_COLORS.RACKET_SPAWN;
				} else if (action === "racket_despawn") {
					title = `Racket Despawned • ${territoryCode}`;
					color = EVENT_COLORS.RACKET_DESPAWN;
				} else if (action === "racket_level_up") {
					title = `Racket Leveled Up • ${territoryCode}`;
					color = EVENT_COLORS.RACKET_LEVEL_UP;
				} else if (action === "racket_level_down") {
					title = `Racket Leveled Down • ${territoryCode}`;
					color = EVENT_COLORS.RACKET_LEVEL_DOWN;
				}

				embed = createBaseEmbed(title, undefined, color).addFields(
					{ name: "Territory", value: ttLink, inline: true },
					{ name: "Owner Faction", value: factionStr, inline: true },
					{
						name: "Racket",
						value: racketName,
						inline: true,
					},
				);

				if (rewardStr) {
					embed.addFields({ name: "Reward", value: rewardStr, inline: true });
				}
				break;
			}

			default:
				return;
		}

		// Broadcast embed to all target channels
		for (const target of dispatchList) {
			for (const channelId of target.channelIds) {
				try {
					const channel = await client.channels.fetch(channelId);
					if (channel?.isTextBased() && "send" in channel) {
						await (channel as TextChannel).send({ embeds: [embed] });
					}
				} catch (sendErr) {
					logger.warn(
						`Failed to send territory alert to channel ${channelId} in guild ${target.guildId}:`,
						sendErr,
					);
				}
			}
		}
	} catch (err) {
		logger.error("Error in handleTerritoryAlert:", err);
	}
}
