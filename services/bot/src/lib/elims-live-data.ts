import { db, elimsTeams, eq, systemStates } from "@sentinel/database";
import {
	type ButtonInteraction,
	type Client,
	EmbedBuilder,
	TextChannel,
} from "discord.js";
import { EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

export const ELIMS_LIVE_DATA_CONFIG_ID = "elims:live_data_config";
export const ELIMS_LIVE_DATA_REFRESH_ID = "elims_live_data_refresh";

export interface ElimsLiveDataConfig {
	guildId: string;
	channelId: string;
	messageId: string;
	updatedAt: string;
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

/**
 * Handles the Refresh button interaction on the persistent embed.
 */
export async function handleLiveDataRefreshButton(
	interaction: ButtonInteraction,
): Promise<void> {
	await interaction.deferUpdate();

	try {
		const { embed } = await buildLiveDataEmbed();
		await interaction.editReply({
			embeds: [embed],
		});
	} catch (err) {
		logger.error("Failed to refresh live-data standings embed:", err);
	}
}

let lastSerializedPayload = "";
let isUpdatingLiveData = false;

/**
 * Updates the existing persistent live data embed message in place.
 * Only executes Discord edit requests when payload content actually changes.
 */
export async function updateElimsLiveDataMessage(
	client: Client,
): Promise<void> {
	if (isUpdatingLiveData) return;
	isUpdatingLiveData = true;

	try {
		const [state] = await db
			.select()
			.from(systemStates)
			.where(eq(systemStates.id, ELIMS_LIVE_DATA_CONFIG_ID));

		const config = state?.data as unknown as ElimsLiveDataConfig | undefined;
		if (!config?.channelId || !config?.messageId) return;

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
			.fetch(config.channelId)
			.catch(() => null);

		if (!channel || !(channel instanceof TextChannel)) return;

		const message = await channel.messages
			.fetch(config.messageId)
			.catch(() => null);

		if (!message) return;

		await message.edit({
			embeds: [embed],
		});
		lastSerializedPayload = serialized;
	} catch (err) {
		logger.error("Failed to perform scheduled live-data embed update:", err);
	} finally {
		isUpdatingLiveData = false;
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
