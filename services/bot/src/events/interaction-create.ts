import {
	getGuildModules,
	isElimsGuildAsync,
	isTargetGuild,
} from "@sentinel/database";
import {
	type Collection,
	Events,
	type Interaction,
	MessageFlags,
} from "discord.js";
import type { BotCommand } from "../commands/index";
import {
	handleTeamBreakdownSelect,
	TEAM_BREAKDOWN_SELECT_ID,
} from "../commands/team-breakdown";
import { handleArmoryStockPageButton } from "../lib/elims-armory-storage";
import {
	handleItemGrantingButton,
	handleItemGrantRejectModalSubmit,
	handleItemRequestButton,
	handleItemRequestCategorySelect,
	handleItemRequestItemSelect,
	handleItemRequestModalSubmit,
	handleItemVerifySendButton,
	handleItemVerifySendModalSubmit,
} from "../lib/elims-item-requests";
import {
	handleKeyDonationButton,
	handleKeyDonationModalSubmit,
} from "../lib/elims-key-donation";
import {
	ELIMS_LIVE_DATA_REFRESH_ID,
	handleLiveDataRefreshButton,
} from "../lib/elims-live-data";
import {
	handleStockHolderAssignButton,
	handleStockHolderModalSubmit,
	handleStockHolderReclaimButton,
	handleStockHolderReclaimModalSubmit,
	handleStockHolderReclaimSelect,
	handleStockHolderUserSelect,
} from "../lib/elims-stock-holders";
import { createErrorEmbed } from "../lib/embeds";
import { handleFactionDirectoryButton } from "../lib/faction-map-channel";
import { handleFactionMonitoringButton } from "../lib/faction-monitoring-channel";
import {
	handleGiveawayCategorySelect,
	handleGiveawayCreateInitButton,
	handleGiveawayEntryButton,
	handleGiveawayItemPageButton,
	handleGiveawayItemSelect,
	handleGiveawayModalSubmit,
} from "../lib/giveaways";
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
						embeds: [
							createErrorEmbed(
								"Unauthorized Server",
								"This bot is private and restricted to authorized target servers.",
							),
						],
						flags: MessageFlags.Ephemeral,
					})
					.catch(() => {});
			}
			return;
		}

		try {
			if (interaction.isButton()) {
				if (interaction.customId === "elims_request_open") {
					await handleItemRequestButton(interaction);
				} else if (
					interaction.customId.startsWith("elims_armory_stock_page:")
				) {
					await handleArmoryStockPageButton(interaction);
				} else if (interaction.customId.startsWith("elims_grant_")) {
					await handleItemGrantingButton(interaction);
				} else if (interaction.customId.startsWith("elims_verify_send:")) {
					await handleItemVerifySendButton(interaction);
				} else if (interaction.customId.startsWith("faction_dir_page:")) {
					await handleFactionDirectoryButton(interaction);
				} else if (
					interaction.customId.startsWith("monitoring_revives_page:")
				) {
					await handleFactionMonitoringButton(interaction);
				} else if (interaction.customId === "giveaway_create_init") {
					await handleGiveawayCreateInitButton(interaction);
				} else if (interaction.customId.startsWith("giveaway_item_page:")) {
					await handleGiveawayItemPageButton(interaction);
				} else if (interaction.customId.startsWith("giveaway_entry:")) {
					await handleGiveawayEntryButton(interaction);
				} else if (interaction.customId === "elims_donate_key_button") {
					await handleKeyDonationButton(interaction);
				} else if (interaction.customId.startsWith("elims_holder_assign:")) {
					await handleStockHolderAssignButton(interaction);
				} else if (interaction.customId.startsWith("elims_holder_reclaim:")) {
					await handleStockHolderReclaimButton(interaction);
				} else if (interaction.customId === ELIMS_LIVE_DATA_REFRESH_ID) {
					await handleLiveDataRefreshButton(interaction);
				}
				return;
			}

			if (interaction.isUserSelectMenu()) {
				if (interaction.customId.startsWith("elims_holder_user_select:")) {
					await handleStockHolderUserSelect(interaction);
				}
				return;
			}

			if (interaction.isStringSelectMenu()) {
				if (interaction.customId.startsWith("elims_category_select")) {
					await handleItemRequestCategorySelect(interaction);
				} else if (interaction.customId.startsWith("elims_item_select")) {
					await handleItemRequestItemSelect(interaction);
				} else if (interaction.customId === "giveaway_category_select") {
					await handleGiveawayCategorySelect(interaction);
				} else if (interaction.customId.startsWith("giveaway_item_select:")) {
					await handleGiveawayItemSelect(interaction);
				} else if (
					interaction.customId.startsWith("elims_holder_reclaim_select:")
				) {
					await handleStockHolderReclaimSelect(interaction);
				} else if (interaction.customId === TEAM_BREAKDOWN_SELECT_ID) {
					await handleTeamBreakdownSelect(interaction);
				}
				return;
			}

			if (interaction.isModalSubmit()) {
				if (interaction.customId.startsWith("elims_request_modal:")) {
					await handleItemRequestModalSubmit(interaction);
				} else if (
					interaction.customId.startsWith("elims_grant_reject_modal:")
				) {
					await handleItemGrantRejectModalSubmit(interaction);
				} else if (
					interaction.customId.startsWith("elims_verify_send_modal:")
				) {
					await handleItemVerifySendModalSubmit(interaction);
				} else if (interaction.customId.startsWith("giveaway_config_modal:")) {
					await handleGiveawayModalSubmit(interaction);
				} else if (interaction.customId === "elims_donate_key_modal") {
					await handleKeyDonationModalSubmit(interaction);
				} else if (
					interaction.customId.startsWith("elims_holder_assign_modal:")
				) {
					await handleStockHolderModalSubmit(interaction);
				} else if (
					interaction.customId.startsWith("elims_holder_reclaim_modal:")
				) {
					await handleStockHolderReclaimModalSubmit(interaction);
				}
				return;
			}
		} catch (error) {
			logger.error(
				`Error handling component/modal interaction ${interaction.id}:`,
				error,
			);
			if (interaction.isRepliable()) {
				const errorEmbed = createErrorEmbed(
					"Interaction Failed",
					"An error occurred while processing this action.",
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
			return;
		}

		if (!interaction.isChatInputCommand()) return;

		const isElims = await isElimsGuildAsync(interaction.guildId);
		const command = commands.get(interaction.commandName);
		if (!command) {
			logger.warn(`No command matching ${interaction.commandName} was found.`);
			return;
		}

		// Enforce strict separation: normal commands cannot run on Elims guilds, and Elims-only commands cannot run on normal guilds
		if (isElims && command.scope === "normal") {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Command Unavailable",
						"Normal faction bot commands are not available on the tournament server.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (!isElims && command.scope === "elims") {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Command Unavailable",
						"Elims tournament commands are not available on this server.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (interaction.guildId && !isElims && command.module) {
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
					embeds: [
						createErrorEmbed(
							"Module Disabled",
							`The **${moduleLabel}** module is currently disabled for this server.`,
						),
					],
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
