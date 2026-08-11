import { db } from "@sentinel/database";
import {
	AttachmentBuilder,
	type ChatInputCommandInteraction,
	SlashCommandBuilder,
} from "discord.js";
import { generateAllianceMapPng } from "../lib/alliance-map-generator";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "../lib/embeds";
import { getFactionToAllianceMap } from "../lib/faction-alliances";

const DISTINCT_COLORS = [
	"#e74c3c", // red
	"#27ae60", // green
	"#3498db", // blue
	"#f39c12", // orange
	"#9b59b6", // purple
	"#e91e63", // pink
	"#795548", // brown
	"#1abc9c", // teal
	"#f1c40f", // yellow
	"#34495e", // slate
];

const COLOR_UNALIGNED = "#95a5a6"; // neutral gray

function hashString(input: string): number {
	let hash = 0;
	for (let i = 0; i < input.length; i++) {
		hash = (hash << 5) - hash + input.charCodeAt(i);
		hash |= 0;
	}
	return Math.abs(hash);
}

function colorForAllianceName(name: string): string {
	if (name === "Unaligned") {
		return COLOR_UNALIGNED;
	}

	const hash = hashString(name);
	return DISTINCT_COLORS[hash % DISTINCT_COLORS.length] ?? COLOR_UNALIGNED;
}

export const allianceMapCommand = {
	data: new SlashCommandBuilder()
		.setName("alliance-map")
		.setDescription("Generate territory map color-coded by alliance control"),

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		try {
			await interaction.deferReply();

			const [ownershipRows, factionToAlliance] = await Promise.all([
				db.query.territoryStates.findMany(),
				getFactionToAllianceMap(),
			]);

			const allianceCounts = new Map<string, number>();
			const territoryFillById = new Map<string, string>();

			for (const row of ownershipRows) {
				if (!row.factionId) continue;

				const allianceName =
					factionToAlliance.get(row.factionId) ?? "Unaligned";
				const color = colorForAllianceName(allianceName);

				territoryFillById.set(row.id, color);
				allianceCounts.set(
					allianceName,
					(allianceCounts.get(allianceName) || 0) + 1,
				);
			}

			const pngBuffer = await generateAllianceMapPng(territoryFillById);

			const attachment = new AttachmentBuilder(pngBuffer, {
				name: "alliance-map.png",
			});

			const rankedAlliances = [...allianceCounts.entries()]
				.map(([alliance, territories]) => ({
					alliance,
					territories,
					color: colorForAllianceName(alliance),
				}))
				.sort(
					(a, b) =>
						b.territories - a.territories ||
						a.alliance.localeCompare(b.alliance),
				);

			const totalControlled = ownershipRows.filter(
				(row) => row.factionId !== null,
			).length;
			const neutralCount = ownershipRows.length - totalControlled;

			const embed = createBaseEmbed(
				"Territory Alliance Control Map",
				"Territories are color-coded by alliance.",
				EMBED_COLORS.PRIMARY,
			)
				.setImage("attachment://alliance-map.png")
				.addFields(
					{
						name: "Territories",
						value: `${ownershipRows.length}`,
						inline: true,
					},
					{ name: "Occupied", value: `${totalControlled}`, inline: true },
					{ name: "No Owner", value: `${neutralCount}`, inline: true },
					{
						name: "Alliances Visible",
						value: `${rankedAlliances.length}`,
						inline: true,
					},
				);

			if (rankedAlliances.length === 0) {
				embed.addFields({
					name: "Alliance Territory Count",
					value: "No currently controlled territories found.",
					inline: false,
				});
			} else {
				const MAX_ALLIANCE_FIELDS = 18;
				const displayAlliances = rankedAlliances.slice(0, MAX_ALLIANCE_FIELDS);

				for (const entry of displayAlliances) {
					embed.addFields({
						name: entry.alliance,
						value: `${entry.territories} territories`,
						inline: true,
					});
				}

				if (rankedAlliances.length > MAX_ALLIANCE_FIELDS) {
					const remaining = rankedAlliances.slice(MAX_ALLIANCE_FIELDS);
					const remainingText = remaining
						.map((e) => `• ${e.alliance}: ${e.territories}`)
						.join("\n");

					embed.addFields({
						name: "Other Alliances",
						value:
							remainingText.length > 1024
								? `${remainingText.substring(0, 1021)}...`
								: remainingText,
						inline: false,
					});
				}
			}

			await interaction.editReply({
				embeds: [embed],
				files: [attachment],
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const errorEmbed = createErrorEmbed("Error", errorMsg);

			await interaction.editReply({
				embeds: [errorEmbed],
			});
		}
	},
};
