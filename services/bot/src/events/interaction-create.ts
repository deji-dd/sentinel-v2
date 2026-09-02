import { getGuildModules, isTargetGuild } from "@sentinel/database";
import {
	type Collection,
	Events,
	type Interaction,
	MessageFlags,
} from "discord.js";
import type { BotCommand } from "../commands/index";
import { createErrorEmbed } from "../lib/embeds";
import { handleFactionDirectoryButton } from "../lib/faction-map-channel";
import { handleFactionMonitoringButton } from "../lib/faction-monitoring-channel";
import { logger } from "../lib/logger";

export const interactionCreateEvent = {
	name: Events.InteractionCreate,
	async execute(
		interaction: Interaction,
		commands: Collection<string, BotCommand>,
	): Promise<void> {
		if (interaction.guildId && !isTargetGuild(interaction.guildId)) {
			if (interaction.isRepliable()) {
				await interaction
					.reply({
						content:
							"This bot is private and restricted to authorized target servers.",
						flags: MessageFlags.Ephemeral,
					})
					.catch(() => {});
			}
			return;
		}

		if (interaction.isButton()) {
			if (interaction.customId.startsWith("faction_dir_page:")) {
				await handleFactionDirectoryButton(interaction);
			} else if (interaction.customId.startsWith("monitoring_revives_page:")) {
				await handleFactionMonitoringButton(interaction);
			}
			return;
		}

		if (!interaction.isChatInputCommand()) return;

		const command = commands.get(interaction.commandName);
		if (!command) {
			logger.warn(`No command matching ${interaction.commandName} was found.`);
			return;
		}

		if (interaction.guildId && command.module) {
			const modules = await getGuildModules(interaction.guildId);
			const isModuleDisabled =
				(command.module === "verification" && !modules.verification) ||
				(command.module === "territory" && !modules.territory) ||
				(command.module === "reaction_roles" && !modules.reactionRoles) ||
				(command.module === "monitoring" && !modules.monitoring);

			if (isModuleDisabled) {
				const moduleLabel =
					command.module.charAt(0).toUpperCase() +
					command.module.slice(1).replace("_", " ");
				await interaction.reply({
					content: `The **${moduleLabel}** module is currently disabled for this server.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
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
