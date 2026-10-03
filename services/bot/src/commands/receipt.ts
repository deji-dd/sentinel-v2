import {
	getMercContractById,
	getMercContractSummary,
	getMercContracts,
	type MercContract,
} from "@sentinel/database";
import {
	ActionRowBuilder,
	type ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	type StringSelectMenuInteraction,
} from "discord.js";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "../lib/embeds";
import { logger } from "../lib/logger";
import { buildMercContractReceiptPayload } from "../lib/merc-alert-distributor";
import type { BotCommand } from "./index";

export const MERC_RECEIPT_SELECT_ID = "merc_receipt_select";

/**
 * Builds the interactive dropdown row allowing users to choose from recent contracts/wars (max 25).
 */
export function createMercReceiptSelectActionRow(
	contracts: MercContract[],
): ActionRowBuilder<StringSelectMenuBuilder> {
	const selectMenu = new StringSelectMenuBuilder()
		.setCustomId(MERC_RECEIPT_SELECT_ID)
		.setPlaceholder("Select a past contract or war to view receipt...")
		.addOptions(
			contracts.slice(0, 25).map((c) => {
				const opponent = c.warOpponent?.name ? ` vs ${c.warOpponent.name}` : "";
				const label = `${c.factionName}${opponent}`.slice(0, 100);
				const dateStr = new Date(c.startTime || c.createdAt)
					.toISOString()
					.slice(0, 10);
				const warStr = c.warId ? `War #${c.warId}` : `ID: ${c.id.slice(0, 8)}`;
				const description =
					`[${c.status.toUpperCase()}] ${dateStr} • ${warStr}`.slice(0, 100);

				return {
					label,
					description,
					value: c.id,
				};
			}),
		);

	return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
		selectMenu,
	);
}

/**
 * Handles StringSelectMenu interactions when a user selects a past war/contract.
 */
export async function handleMercReceiptSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	const contractId = interaction.values[0];
	if (!contractId) return;

	await interaction.deferUpdate();

	try {
		const contract = await getMercContractById(
			contractId,
			interaction.guildId ?? undefined,
		);

		if (!contract) {
			const errorEmbed = createErrorEmbed(
				"Contract Not Found",
				`Unable to locate contract \`${contractId}\`. It may have been deleted.`,
			);
			await interaction.editReply({
				embeds: [errorEmbed],
				components: [],
			});
			return;
		}

		const summary = await getMercContractSummary(contract.id);
		const payload = buildMercContractReceiptPayload(contract, summary);

		await interaction.editReply({
			embeds: [payload.embed],
			files: payload.files,
			components: payload.components,
		});
	} catch (err) {
		logger.error("Failed to generate merc receipt from select menu:", err);
		const errorEmbed = createErrorEmbed(
			"Receipt Error",
			"An error occurred while generating the contract receipt and CSV exports.",
		);
		await interaction.editReply({
			embeds: [errorEmbed],
			components: [],
		});
	}
}

/**
 * Slash command to view mercenary contract receipts, payout summaries, and CSV exports.
 */
export const receiptCommand: BotCommand = {
	data: new SlashCommandBuilder()
		.setName("receipt")
		.setDescription(
			"View mercenary contract receipts, payout summaries, and CSV exports.",
		)
		.addStringOption((option) =>
			option
				.setName("contract")
				.setDescription("Optional: Contract ID to view directly")
				.setRequired(false),
		)
		.addBooleanOption((option) =>
			option
				.setName("private")
				.setDescription(
					"Whether to display the receipt only to you (default: False)",
				)
				.setRequired(false),
		),
	scope: "normal",

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!interaction.guildId) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Guild Only",
						"This command can only be used within a server.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const isPrivate = interaction.options.getBoolean("private") ?? false;
		const contractIdInput = interaction.options.getString("contract")?.trim();
		const replyFlags = isPrivate ? MessageFlags.Ephemeral : undefined;

		try {
			// Direct contract ID specified
			if (contractIdInput) {
				await interaction.deferReply(
					replyFlags ? { flags: replyFlags } : undefined,
				);

				const contract = await getMercContractById(
					contractIdInput,
					interaction.guildId,
				);

				if (!contract) {
					await interaction.editReply({
						embeds: [
							createErrorEmbed(
								"Contract Not Found",
								`No mercenary contract found with ID \`${contractIdInput}\` in this server.`,
							),
						],
					});
					return;
				}

				const summary = await getMercContractSummary(contract.id);
				const payload = buildMercContractReceiptPayload(contract, summary);

				await interaction.editReply({
					embeds: [payload.embed],
					files: payload.files,
					components: payload.components,
				});
				return;
			}

			// Prompt with interactive select menu of past wars / contracts
			const allContracts = await getMercContracts(interaction.guildId);
			if (allContracts.length === 0) {
				await interaction.reply({
					embeds: [
						createErrorEmbed(
							"No Contracts Found",
							"There are no mercenary contracts recorded for this server.",
						),
					],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const selectRow = createMercReceiptSelectActionRow(allContracts);
			const embed = createBaseEmbed(
				"Mercenary Contract Receipts",
				"Select a past contract or war from the dropdown below to view its receipt, payout breakdown, and CSV exports.",
				EMBED_COLORS.PRIMARY,
			);

			await interaction.reply({
				embeds: [embed],
				components: [selectRow],
				flags: replyFlags,
			});
		} catch (err) {
			logger.error("Failed to execute receipt command:", err);
			const errorEmbed = createErrorEmbed(
				"Command Failed",
				"An unexpected error occurred while executing the receipt command.",
			);

			if (interaction.deferred || interaction.replied) {
				await interaction.editReply({
					embeds: [errorEmbed],
					components: [],
				});
			} else {
				await interaction.reply({
					embeds: [errorEmbed],
					flags: MessageFlags.Ephemeral,
				});
			}
		}
	},
};
