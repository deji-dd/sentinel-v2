import { db, elimsTeams, eq, systemStates } from "@sentinel/database";
import {
	type Client,
	EmbedBuilder,
	type Message,
	TextChannel,
} from "discord.js";
import { EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

export const ELIMS_CONFIG_ID = "elims:guild_config";

export interface ElimsGuildConfigState {
	guildId: string;
	guildName?: string;
	guildIcon?: string | null;
	adminRoleIds?: string[];
	liveDataChannelId?: string | null;
	liveDataEmbedMessageId?: string | null;
	updatedAt?: string;
	[key: string]: unknown;
}

export interface LiveDataStandingsResult {
	embed: EmbedBuilder;
	totalTeams: number;
	activeTeams: number;
}

/**
 * Builds the persistent live data embed and refresh action row.
 * Sorts all elimination teams by Wins descending.
 */
export async function buildLiveDataEmbed(): Promise<LiveDataStandingsResult> {
	const teams = await db.select().from(elimsTeams);

	// Sort teams by Wins descending; tie-break by official rank (position ascending)
	const sorted = [...teams].sort((a, b) => {
		if (b.wins !== a.wins) {
			return b.wins - a.wins;
		}
		return a.position - b.position;
	});

	let activeCount = 0;

	for (const t of sorted) {
		if (!t.eliminated) {
			activeCount++;
		}
	}

	const embed = new EmbedBuilder()
		.setTitle("Live Standings")
		.setColor(EMBED_COLORS.PRIMARY)
		.setDescription(
			`**Teams Active:** ${activeCount}/${sorted.length}\n` +
				"*Ranked primarily by outgoing attacks.*",
		)
		.setTimestamp()
		.setFooter({ text: "Sentinel" });

	for (let i = 0; i < sorted.length; i++) {
		const team = sorted[i];
		if (!team) continue;

		const rankNum = i + 1;
		const statusTag = team.eliminated ? " [ELIMINATED]" : "";
		const fieldName = `#${rankNum} ${team.name}${statusTag}`;

		// Calculate W/L ratio
		const wlRatio =
			team.losses > 0
				? (team.wins / team.losses).toFixed(2)
				: team.wins > 0
					? `${team.wins.toFixed(2)}`
					: "0.00";

		const livesDisplay = team.eliminated ? "0 (Dead)" : `${team.lives} HP`;

		const fieldValue =
			`• **W/L Ratio:** ${wlRatio} (${team.wins.toLocaleString()}W - ${team.losses.toLocaleString()}L)\n` +
			`• **Tickets:** ${team.score.toLocaleString()} | **Lives:** ${livesDisplay} (Official: #${team.position})`;

		embed.addFields({
			name: fieldName,
			value: fieldValue,
			inline: false,
		});
	}

	return {
		embed,
		totalTeams: sorted.length,
		activeTeams: activeCount,
	};
}

let lastSerializedPayload = "";
let isLiveDataSyncing = false;

export interface UpdateElimsLiveDataOptions {
	previousChannelId?: string | null;
	previousMessageId?: string | null;
}

/**
 * Synchronizes the persistent live data embed in the configured Discord channel.
 * Cleanly handles restarts by editing existing messages in place and removing duplicate embeds.
 */
export async function updateElimsLiveDataChannel(
	client: Client,
	guildId?: string,
	options?: UpdateElimsLiveDataOptions,
): Promise<void> {
	// If a sync is already in flight, wait briefly to prevent race conditions on boot
	while (isLiveDataSyncing) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	isLiveDataSyncing = true;

	try {
		// Clean up old message if channel changed or was disabled
		if (options?.previousChannelId && options?.previousMessageId) {
			try {
				const prevChannel = await client.channels
					.fetch(options.previousChannelId)
					.catch(() => null);
				if (prevChannel && prevChannel instanceof TextChannel) {
					const prevMsg = await prevChannel.messages
						.fetch(options.previousMessageId)
						.catch(() => null);
					if (prevMsg) {
						await prevMsg.delete().catch(() => {});
					}
				}
			} catch (cleanupErr) {
				logger.warn(
					"Failed to delete previous live standings embed message:",
					cleanupErr,
				);
			}
		}

		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_CONFIG_ID));

		const config = state?.data as unknown as ElimsGuildConfigState | undefined;
		if (!config?.guildId) return;

		const targetGuildId = guildId ?? config.guildId;
		if (targetGuildId !== config.guildId) return;

		// If no channel is configured, do not post
		if (!config.liveDataChannelId) {
			return;
		}

		const channel = await client.channels
			.fetch(config.liveDataChannelId)
			.catch(() => null);

		if (!channel || !(channel instanceof TextChannel)) return;

		const { embed } = await buildLiveDataEmbed();
		const serialized = JSON.stringify({
			desc: embed.data.description,
			fields: embed.data.fields,
		});

		// 1. Try to fetch directly by known stored messageId
		let targetMessage: Message | null = null;
		if (config.liveDataEmbedMessageId) {
			targetMessage = await channel.messages
				.fetch(config.liveDataEmbedMessageId)
				.catch(() => null);
		}

		// 2. Scan recent messages (up to 100) to find any existing bot Live Standings messages
		const recentMessages = await channel.messages
			.fetch({ limit: 100 })
			.catch(() => null);

		const botLiveDataMessages = recentMessages
			? Array.from(recentMessages.values()).filter(
					(m) =>
						m.author.id === client.user?.id &&
						m.embeds.some((e) => e.title === "Live Standings"),
				)
			: [];

		// 3. If targetMessage wasn't found by stored ID, adopt the most recent matching bot message
		if (!targetMessage && botLiveDataMessages.length > 0) {
			targetMessage = botLiveDataMessages[0] ?? null;
		}

		// 4. Clean up any duplicate/stray Live Standings messages left over from prior runs/restarts
		if (targetMessage) {
			for (const msg of botLiveDataMessages) {
				if (msg.id !== targetMessage.id) {
					await msg.delete().catch(() => {});
				}
			}
		}

		let activeMessageId = targetMessage?.id;

		// 5. In-place edit or create if no existing message exists anywhere
		if (targetMessage) {
			await targetMessage.edit({
				embeds: [embed],
			});
			activeMessageId = targetMessage.id;
		} else {
			const sent = await channel.send({
				embeds: [embed],
			});
			activeMessageId = sent.id;
		}

		lastSerializedPayload = serialized;

		// 6. Update message ID in config if newly assigned or changed
		if (activeMessageId && activeMessageId !== config.liveDataEmbedMessageId) {
			const updatedConfig: ElimsGuildConfigState = {
				...config,
				liveDataEmbedMessageId: activeMessageId,
				updatedAt: new Date().toISOString(),
			};

			await db
				.update(systemStates)
				.set({
					data: updatedConfig as unknown as Record<string, unknown>,
					updatedAt: new Date(),
				})
				.where(eq(systemStates.id, ELIMS_CONFIG_ID));
		}
	} catch (err) {
		logger.error("Failed to update Elims live data channel embed:", err);
	} finally {
		isLiveDataSyncing = false;
	}
}

/**
 * Updates the existing persistent live data embed message in place.
 * Only executes Discord edit requests when payload content actually changes.
 */
export async function updateElimsLiveDataMessage(
	client: Client,
): Promise<void> {
	if (isLiveDataSyncing) return;
	isLiveDataSyncing = true;

	try {
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_CONFIG_ID));

		const config = state?.data as unknown as ElimsGuildConfigState | undefined;
		if (!config?.liveDataChannelId || !config?.liveDataEmbedMessageId) return;

		const { embed } = await buildLiveDataEmbed();
		const serialized = JSON.stringify({
			desc: embed.data.description,
			fields: embed.data.fields,
		});

		// Skip Discord API request if tournament standings data is unchanged
		if (serialized === lastSerializedPayload) {
			return;
		}

		const channel = await client.channels
			.fetch(config.liveDataChannelId)
			.catch(() => null);

		if (!channel || !(channel instanceof TextChannel)) return;

		const message = await channel.messages
			.fetch(config.liveDataEmbedMessageId)
			.catch(() => null);

		if (!message) {
			// Message was removed from Discord, recover without clutter
			isLiveDataSyncing = false;
			await updateElimsLiveDataChannel(client, config.guildId);
			return;
		}

		await message.edit({
			embeds: [embed],
		});
		lastSerializedPayload = serialized;
	} catch (err) {
		logger.error("Failed to perform scheduled live-data embed update:", err);
	} finally {
		isLiveDataSyncing = false;
	}
}

/**
 * Starts the periodic background sync loop to keep the persistent embed up to date.
 * Defaults to 10 seconds for reliable balance of live telemetry and Discord rate limit safety.
 */
export function startLiveDataSyncLoop(
	client: Client,
	intervalMs = 10000,
): ReturnType<typeof setInterval> {
	return setInterval(() => {
		void updateElimsLiveDataMessage(client);
	}, intervalMs);
}
