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

export const inviteCommand = {
	data: new SlashCommandBuilder()
		.setName("invite")
		.setDescription(
			"Generate an invite link to add Sentinel to other Discord servers.",
		),

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		try {
			const clientId =
				interaction.client.user?.id || process.env.DISCORD_CLIENT_ID;

			if (!clientId) {
				const errorEmbed = createErrorEmbed(
					"Configuration Error",
					"Discord client ID is not configured.",
				);

				await interaction.reply({
					embeds: [errorEmbed],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			// Permissions: Administrator (bit 8)
			const permissions = ["Administrator"];
			const permissionBits = BigInt(8);

			const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permissionBits}&scope=bot+applications.commands`;

			const embed = createBaseEmbed(
				"Invite Bot to Server",
				"Click the link or button below to add Sentinel to another Discord server:",
				EMBED_COLORS.PRIMARY,
			).addFields(
				{
					name: "Invite Link",
					value: `[Add Sentinel Bot](${inviteUrl})`,
				},
				{
					name: "Permissions Requested",
					value: permissions.join(", "),
				},
			);

			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setLabel("Add to Server")
					.setStyle(ButtonStyle.Link)
					.setURL(inviteUrl),
			);

			await interaction.reply({
				embeds: [embed],
				components: [row],
			});
		} catch (error) {
			logger.error("Error in invite command:", error);
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
