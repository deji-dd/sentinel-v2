import {
	type Collection,
	Events,
	type Interaction,
	MessageFlags,
} from "discord.js";
import type { BotCommand } from "../commands/index";
import { createErrorEmbed } from "../lib/embeds";
import { handleFactionDirectoryButton } from "../lib/faction-map-channel";
import { logger } from "../lib/logger";

export const interactionCreateEvent = {
	name: Events.InteractionCreate,
	async execute(
		interaction: Interaction,
		commands: Collection<string, BotCommand>,
	): Promise<void> {
		if (interaction.isButton()) {
			if (interaction.customId.startsWith("faction_dir_page:")) {
				await handleFactionDirectoryButton(interaction);
			}
			return;
		}

		if (!interaction.isChatInputCommand()) return;

		const command = commands.get(interaction.commandName);
		if (!command) {
			logger.warn(`No command matching ${interaction.commandName} was found.`);
			return;
		}

		try {
			await command.execute(interaction);
		} catch (error) {
			logger.error(
				`Error executing slash command ${interaction.commandName}:`,
				error,
			);

			const errorEmbed = createErrorEmbed(
				"Execution Error",
				"An error occurred while executing this command.",
			);

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
} as const;
