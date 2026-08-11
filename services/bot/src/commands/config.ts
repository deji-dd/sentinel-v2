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

export const configCommand = {
	data: new SlashCommandBuilder()
		.setName("config")
		.setDescription(
			"Open the interactive web dashboard to configure Sentinel for this server.",
		),

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		try {
			const guildId = interaction.guildId;
			const baseUrl = "https://blasted-labs.tech/";
			const dashboardUrl = guildId ? `${baseUrl}/guilds/${guildId}` : baseUrl;

			const embed = createBaseEmbed(
				"Sentinel Dashboard",
				"Click the button below to configure Sentinel for this server.",
				EMBED_COLORS.PRIMARY,
			);

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setLabel("Open Dashboard")
					.setStyle(ButtonStyle.Link)
					.setURL(dashboardUrl)
					.setEmoji("⚙️"),
			);

			await interaction.reply({
				embeds: [embed],
				components: [row],
				flags: MessageFlags.Ephemeral,
			});
		} catch (error) {
			logger.error("Error in config command:", error);
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
