import {
	ChannelType,
	type ChatInputCommandInteraction,
	type GuildTextBasedChannel,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} from "discord.js";
import { createErrorEmbed, createSuccessEmbed } from "../lib/embeds";
import { logger } from "../lib/logger";

/**
 * Slash command to bulk delete messages from a channel.
 */
export const purgeCommand = {
	data: new SlashCommandBuilder()
		.setName("purge")
		.setDescription("Bulk delete messages from a channel.")
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
		.setContexts(InteractionContextType.Guild)
		.addIntegerOption((option) =>
			option
				.setName("amount")
				.setDescription("Number of messages to delete (1-100, default: 10)")
				.setMinValue(1)
				.setMaxValue(100)
				.setRequired(false),
		)
		.addUserOption((option) =>
			option
				.setName("user")
				.setDescription("Filter deletion to messages sent by a specific user")
				.setRequired(false),
		)
		.addChannelOption((option) =>
			option
				.setName("channel")
				.setDescription(
					"Target channel to delete messages from (default: current channel)",
				)
				.addChannelTypes(
					ChannelType.GuildText,
					ChannelType.GuildAnnouncement,
					ChannelType.PublicThread,
					ChannelType.PrivateThread,
					ChannelType.GuildVoice,
				)
				.setRequired(false),
		),

	/**
	 * Executes the purge command.
	 *
	 * @param interaction - The command interaction received from Discord.
	 */
	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		try {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });

			if (!interaction.guild) {
				const errorEmbed = createErrorEmbed(
					"Guild Required",
					"This command can only be executed within a Discord server.",
				);
				await interaction.editReply({ embeds: [errorEmbed] });
				return;
			}

			const channelOption = interaction.options.getChannel("channel");
			const targetChannel = (channelOption ||
				interaction.channel) as GuildTextBasedChannel | null;

			if (!targetChannel?.isTextBased() || !("bulkDelete" in targetChannel)) {
				const errorEmbed = createErrorEmbed(
					"Invalid Channel",
					"The selected channel does not support bulk message deletion.",
				);
				await interaction.editReply({ embeds: [errorEmbed] });
				return;
			}

			// Permissions check for Sentinel bot in target channel
			const me =
				interaction.guild.members.me ||
				(await interaction.guild.members.fetchMe());
			const botPermissions = targetChannel.permissionsFor(me);
			if (
				!botPermissions?.has(PermissionFlagsBits.ManageMessages) ||
				!botPermissions?.has(PermissionFlagsBits.ReadMessageHistory)
			) {
				const errorEmbed = createErrorEmbed(
					"Missing Permissions",
					`Sentinel requires **Manage Messages** and **Read Message History** permissions in ${targetChannel.toString()}.`,
				);
				await interaction.editReply({ embeds: [errorEmbed] });
				return;
			}

			// Permissions check for executing user in target channel
			const memberPermissions = targetChannel.permissionsFor(
				interaction.user.id,
			);
			if (!memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
				const errorEmbed = createErrorEmbed(
					"Permission Denied",
					`You need **Manage Messages** permissions in ${targetChannel.toString()} to use this command.`,
				);
				await interaction.editReply({ embeds: [errorEmbed] });
				return;
			}

			const amount = interaction.options.getInteger("amount") ?? 10;
			const targetUser = interaction.options.getUser("user");

			let deletedCount = 0;
			let requestedCount = amount;

			if (targetUser) {
				const fetchedMessages = await targetChannel.messages.fetch({
					limit: amount,
				});
				const userMessages = fetchedMessages.filter(
					(msg) => msg.author.id === targetUser.id,
				);
				requestedCount = userMessages.size;

				if (userMessages.size === 0) {
					const infoEmbed = createSuccessEmbed(
						"No Messages Found",
						`No messages from ${targetUser.toString()} were found within the last ${amount} messages in ${targetChannel.toString()}.`,
					);
					await interaction.editReply({ embeds: [infoEmbed] });
					return;
				}

				const deletedMessages = await targetChannel.bulkDelete(
					userMessages,
					true,
				);
				deletedCount = deletedMessages.size;
			} else {
				const deletedMessages = await targetChannel.bulkDelete(amount, true);
				deletedCount = deletedMessages.size;
			}

			let ageNote = "";
			if (requestedCount > deletedCount) {
				ageNote =
					"\n\n*Note: Messages older than 14 days cannot be bulk deleted due to Discord API restrictions.*";
			}

			const successEmbed = createSuccessEmbed(
				"Purge Complete",
				`Successfully deleted **${deletedCount}** message${deletedCount === 1 ? "" : "s"} in ${targetChannel.toString()}${
					targetUser ? ` sent by ${targetUser.toString()}` : ""
				}.${ageNote}`,
			);

			await interaction.editReply({ embeds: [successEmbed] });
		} catch (error) {
			logger.error("Error executing purge command:", error);
			const errorMsg = error instanceof Error ? error.message : String(error);
			const errorEmbed = createErrorEmbed("Purge Failed", errorMsg);

			if (interaction.deferred || interaction.replied) {
				await interaction.editReply({ embeds: [errorEmbed] }).catch(() => {});
			} else {
				await interaction
					.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral })
					.catch(() => {});
			}
		}
	},
};
