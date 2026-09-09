import {
	db,
	type ElimsItemRequestConfig,
	eq,
	systemStates,
} from "@sentinel/database";
import {
	type ChatInputCommandInteraction,
	EmbedBuilder,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import {
	getHolderStock,
	hasManagerPermission,
} from "../lib/elims-stock-holders";
import { createErrorEmbed, EMBED_COLORS } from "../lib/embeds";
import { logger } from "../lib/logger";
import type { BotCommand } from "./index";

const ELIMS_ITEM_REQUESTS_CONFIG_ID = "elims:item_requests_config";

export const assignedStockCommand: BotCommand = {
	data: new SlashCommandBuilder()
		.setName("assigned-stock")
		.setDescription("View armory stock currently assigned to you.")
		.addUserOption((option) =>
			option
				.setName("user")
				.setDescription(
					"Optional stockholder to check assigned stock for (Managers only)",
				)
				.setRequired(false),
		),
	scope: "elims",

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!interaction.guildId) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Guild Only",
						"This command can only be used within the elims server.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			const selectedUser = interaction.options.getUser("user");
			const targetUser = selectedUser ?? interaction.user;
			const isSelf = targetUser.id === interaction.user.id;

			if (!isSelf) {
				const [state] = await db
					.select()
					.from(systemStates)
					.where(eq(systemStates.id, ELIMS_ITEM_REQUESTS_CONFIG_ID));
				const config = state?.data as unknown as
					| ElimsItemRequestConfig
					| undefined;

				if (!hasManagerPermission(interaction, config)) {
					await interaction.editReply({
						embeds: [
							createErrorEmbed(
								"Permission Denied",
								"Only managers and administrators can view assigned stock for other stockholders.",
							),
						],
					});
					return;
				}
			}

			const isTest = false;
			const holdings = await getHolderStock(
				interaction.guildId,
				targetUser.id,
				isTest,
			);

			holdings.sort(
				(a, b) =>
					b.quantity - a.quantity || a.itemName.localeCompare(b.itemName),
			);

			if (holdings.length === 0) {
				const emptyEmbed = new EmbedBuilder()
					.setTitle(
						isSelf
							? "Your Assigned Stock"
							: `Assigned Stock — ${targetUser.username}`,
					)
					.setColor(EMBED_COLORS.PRIMARY)
					.setDescription(
						isSelf
							? "You do not currently have any armory stock assigned to you."
							: `<@${targetUser.id}> does not currently have any armory stock assigned.`,
					)
					.setFooter({ text: "Sentinel" })
					.setTimestamp();

				await interaction.editReply({ embeds: [emptyEmbed] });
				return;
			}

			const totalItems = holdings.reduce((sum, h) => sum + h.quantity, 0);

			const embed = new EmbedBuilder()
				.setTitle(
					isSelf
						? "Your Assigned Stock"
						: `Assigned Stock — ${targetUser.username}`,
				)
				.setColor(EMBED_COLORS.SUCCESS)
				.setDescription(
					isSelf
						? `You currently have **${totalItems.toLocaleString()}** item${totalItems === 1 ? "" : "s"} assigned.`
						: `<@${targetUser.id}> currently has **${totalItems.toLocaleString()}** item${totalItems === 1 ? "" : "s"} assigned.`,
				)
				.addFields({
					name: "Total Items",
					value: `**${totalItems.toLocaleString()}**`,
					inline: true,
				})
				.setFooter({ text: "Sentinel" })
				.setTimestamp();

			const firstItem = holdings[0];
			if (
				holdings.length === 1 &&
				firstItem?.itemId &&
				!Number.isNaN(Number(firstItem.itemId))
			) {
				embed.setThumbnail(
					`https://www.torn.com/images/items/${firstItem.itemId}/large.png`,
				);
			}

			const lines = holdings.map(
				(h) => `• **${h.itemName}** — **${h.quantity.toLocaleString()}x**`,
			);

			const CHUNK_SIZE = 1000;
			let currentChunk: string[] = [];
			let currentLength = 0;
			let chunkIndex = 1;

			for (const line of lines) {
				if (
					currentLength + line.length + 1 > CHUNK_SIZE &&
					currentChunk.length > 0
				) {
					embed.addFields({
						name:
							chunkIndex === 1 ? "Assigned Items" : "Assigned Items (cont.)",
						value: currentChunk.join("\n"),
						inline: false,
					});
					currentChunk = [line];
					currentLength = line.length;
					chunkIndex++;
				} else {
					currentChunk.push(line);
					currentLength += line.length + 1;
				}
			}

			if (currentChunk.length > 0) {
				embed.addFields({
					name: chunkIndex === 1 ? "Assigned Items" : "Assigned Items (cont.)",
					value: currentChunk.join("\n"),
					inline: false,
				});
			}

			await interaction.editReply({ embeds: [embed] });
		} catch (error) {
			logger.error("Error retrieving assigned stock:", error);
			const errorEmbed = createErrorEmbed(
				"Error",
				"Failed to fetch assigned stock. Please try again later.",
			);
			if (interaction.deferred || interaction.replied) {
				await interaction.editReply({ embeds: [errorEmbed] });
			} else {
				await interaction.reply({
					embeds: [errorEmbed],
					flags: MessageFlags.Ephemeral,
				});
			}
		}
	},
};
