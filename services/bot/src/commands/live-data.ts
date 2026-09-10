import { db, systemStates } from "@sentinel/database";
import {
	type ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import {
	buildLiveDataEmbed,
	ELIMS_LIVE_DATA_CONFIG_ID,
	type ElimsLiveDataConfig,
} from "../lib/elims-live-data";
import { createErrorEmbed } from "../lib/embeds";
import { logger } from "../lib/logger";
import type { BotCommand } from "./index";

export const liveDataCommand: BotCommand = {
	data: new SlashCommandBuilder()
		.setName("live-data")
		.setDescription(
			"Posts a persistent live standings dashboard of elimination teams sorted by wins.",
		),
	scope: "elims",

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!interaction.guildId) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Guild Only",
						"This command can only be used within the tournament server.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Persistent embeds in channels are posted publicly
		await interaction.deferReply();

		try {
			const { embed } = await buildLiveDataEmbed();

			const message = await interaction.editReply({
				embeds: [embed],
			});

			// Save the message reference in systemStates for automated background updating
			const configData: ElimsLiveDataConfig = {
				guildId: interaction.guildId,
				channelId: interaction.channelId,
				messageId: message.id,
				updatedAt: new Date().toISOString(),
			};

			await db
				.insert(systemStates)
				.values({
					id: ELIMS_LIVE_DATA_CONFIG_ID,
					data: configData,
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: systemStates.id,
					set: {
						data: configData,
						updatedAt: new Date(),
					},
				});

			logger.info(
				`Elims live-data standings message created: guild=${interaction.guildId}, channel=${interaction.channelId}, message=${message.id}`,
			);
		} catch (err) {
			logger.error("Failed to post live-data standings embed:", err);
			const errorEmbed = createErrorEmbed(
				"Live Data Failed",
				"An error occurred while building the tournament live standings.",
			);
			await interaction.editReply({
				embeds: [errorEmbed],
			});
		}
	},
};
