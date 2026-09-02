import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "../lib/embeds";
import { logger } from "../lib/logger";

export const ttSelectorCommand = {
	module: "territory" as const,
	data: new SlashCommandBuilder()
		.setName("tt-selector")
		.setDescription("Open the interactive territory selector."),

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		try {
			const selectorUrl = "https://tt-selector.blasted-labs.tech";

			const embed = createBaseEmbed(
				"Sentinel TT Selector",
				"Click the button below to launch the Territory Selector.",
				EMBED_COLORS.WARNING,
			);

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setLabel("Open TT Selector")
					.setStyle(ButtonStyle.Link)
					.setURL(selectorUrl),
			);

			await interaction.reply({
				embeds: [embed],
				components: [row],
				flags: MessageFlags.Ephemeral,
			});
		} catch (error) {
			logger.error("Error in tt-selector command:", error);
			const errorMsg = error instanceof Error ? error.message : String(error);
			const errorEmbed = createErrorEmbed("Error", errorMsg);

			if (interaction.replied || interaction.deferred) {
				await interaction
					.followUp({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral })
					.catch(() => {});
			} else {
				await interaction
					.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral })
					.catch(() => {});
			}
		}
	},
};
