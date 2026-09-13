import { db, elimsArmoryDeposits, sql } from "@sentinel/database";
import {
	AttachmentBuilder,
	type ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { createErrorEmbed, createSuccessEmbed } from "../lib/embeds";
import { logger } from "../lib/logger";
import type { BotCommand } from "./index";
import { escapeCsvField } from "./team-breakdown";

interface DonationRow {
	tornId: number | null;
	tornName: string | null;
	discordUsername: string;
	itemName: string;
	itemCategory: string;
	totalQuantity: number;
}

/**
 * Queries all armory deposit records and aggregates total donated quantity
 * per unique (donator, item) pair, returning a sorted CSV attachment.
 */
async function generateDonationSummary(): Promise<{
	attachment: AttachmentBuilder;
	totalRows: number;
	totalItems: number;
}> {
	const rows = await db
		.select({
			tornId: elimsArmoryDeposits.tornId,
			tornName: elimsArmoryDeposits.tornName,
			discordUsername: elimsArmoryDeposits.discordUsername,
			itemName: elimsArmoryDeposits.itemName,
			itemCategory: elimsArmoryDeposits.itemCategory,
			totalQuantity: sql<number>`CAST(SUM(${elimsArmoryDeposits.quantity}) AS INTEGER)`,
		})
		.from(elimsArmoryDeposits)
		.groupBy(
			elimsArmoryDeposits.tornId,
			elimsArmoryDeposits.tornName,
			elimsArmoryDeposits.discordUsername,
			elimsArmoryDeposits.itemName,
			elimsArmoryDeposits.itemCategory,
		)
		.orderBy(
			sql`LOWER(COALESCE(${elimsArmoryDeposits.tornName}, ${elimsArmoryDeposits.discordUsername}))`,
			sql`LOWER(${elimsArmoryDeposits.itemName})`,
		);

	const typed = rows as DonationRow[];

	const headers = [
		"Torn Name",
		"Torn ID",
		"Profile Link",
		"Discord Username",
		"Item",
		"Category",
		"Total Qty",
	];
	const csvLines = [headers.join(",")];

	let totalItems = 0;
	for (const r of typed) {
		const profileLink = r.tornId
			? `https://www.torn.com/profiles.php?XID=${r.tornId}`
			: "";
		totalItems += r.totalQuantity;
		csvLines.push(
			[
				escapeCsvField(r.tornName ?? r.discordUsername),
				escapeCsvField(r.tornId),
				escapeCsvField(profileLink),
				escapeCsvField(r.discordUsername),
				escapeCsvField(r.itemName),
				escapeCsvField(r.itemCategory),
				escapeCsvField(r.totalQuantity),
			].join(","),
		);
	}

	const csvContent = `${csvLines.join("\n")}\n`;
	const attachment = new AttachmentBuilder(Buffer.from(csvContent, "utf-8"), {
		name: "donation-summary.csv",
	});

	return { attachment, totalRows: typed.length, totalItems };
}

export const donationSummaryCommand: BotCommand = {
	data: new SlashCommandBuilder()
		.setName("donation-summary")
		.setDescription(
			"Export a CSV summary of all armory donations grouped by donator and item.",
		),
	scope: "elims",

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!interaction.guildId) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Guild Only",
						"This command can only be used within the tournament server.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			const { attachment, totalRows, totalItems } =
				await generateDonationSummary();

			const embed = createSuccessEmbed(
				"Donation Summary",
				`Exported **${totalRows.toLocaleString()}** donation line${totalRows === 1 ? "" : "s"} ` +
					`totalling **${totalItems.toLocaleString()}** item${totalItems === 1 ? "" : "s"}.\n\n` +
					"Download the attached CSV file below.",
			);

			await interaction.editReply({ embeds: [embed], files: [attachment] });
		} catch (err) {
			logger.error("Failed to generate donation summary:", err);
			await interaction.editReply({
				embeds: [
					createErrorEmbed(
						"Export Failed",
						"An error occurred while generating the donation summary CSV.",
					),
				],
			});
		}
	},
};
