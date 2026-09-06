import { isElimsGuildAsync } from "@sentinel/database";
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

export const dashboardCommand = {
	data: new SlashCommandBuilder()
		.setName("dashboard")
		.setDescription(
			"Get an interactive embed with your server dashboard link.",
		),

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		try {
			const guildId = interaction.guildId;
			const isElims = await isElimsGuildAsync(guildId);

			if (isElims) {
				// Tournament Elims Server Context
				const elimsDashboardUrl =
					process.env.ELIMS_DASHBOARD_URL ||
					(process.env.NODE_ENV === "production"
						? "https://elims.blasted-labs.tech"
						: "http://localhost:5175");

				const embed = createBaseEmbed(
					"Nine Lives — Dashboard",
					"Manage stuff ig.",
					EMBED_COLORS.PRIMARY,
				);

				const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder()
						.setLabel("Open Dashboard")
						.setStyle(ButtonStyle.Link)
						.setURL(elimsDashboardUrl),
				);

				await interaction.reply({
					embeds: [embed],
					components: [row],
					flags: MessageFlags.Ephemeral,
				});
			} else {
				// Standard Sentinel Faction / Server Context
				const baseUrl =
					process.env.DASHBOARD_URL ||
					(process.env.NODE_ENV === "production"
						? "https://sentinel.blasted-labs.tech"
						: "http://localhost:3000");

				const guildDashboardUrl = guildId
					? `${baseUrl}/guilds/${guildId}`
					: baseUrl;

				const embed = createBaseEmbed(
					"Sentinel — Guild Dashboard",
					"Access the dashboard to configure server verification, territory war alert channels, faction maps, and reaction roles.",
					EMBED_COLORS.PRIMARY,
				);

				embed.addFields({
					name: "Server",
					value: interaction.guild?.name ?? "This Server",
					inline: true,
				});

				const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder()
						.setLabel("Open Dashboard")
						.setStyle(ButtonStyle.Link)
						.setURL(guildDashboardUrl),
				);

				await interaction.reply({
					embeds: [embed],
					components: [row],
					flags: MessageFlags.Ephemeral,
				});
			}
		} catch (error) {
			logger.error("Error in dashboard command:", error);
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
