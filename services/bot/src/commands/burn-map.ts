import {
	count,
	db,
	eq,
	factions,
	gte,
	territoryStates,
	warLedgers,
} from "@sentinel/database";
import {
	AttachmentBuilder,
	type ChatInputCommandInteraction,
	SlashCommandBuilder,
} from "discord.js";
import { generateBurnMapPng } from "../lib/burn-map-generator";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "../lib/embeds";
import { logger } from "../lib/logger";
import { getBurnedTerritories } from "../lib/territory-burn-logic";

export const burnMapCommand = {
	module: "territory" as const,
	data: new SlashCommandBuilder()
		.setName("burn-map")
		.setDescription("Generate a visual burn map for a faction")
		.addIntegerOption((opt) =>
			opt
				.setName("faction_id")
				.setDescription("Faction ID to generate burn map for")
				.setRequired(true),
		),

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		try {
			await interaction.deferReply();

			const factionId = interaction.options.getInteger("faction_id", true);

			// 1. Get faction details from Drizzle DB
			const factionRecord = await db.query.factions.findFirst({
				where: eq(factions.id, factionId),
			});

			const factionName = factionRecord?.name || `Faction ${factionId}`;
			const factionDisplay = `${factionName} (${factionId})`;

			// 2. Fetch war ledger from last 90 days
			const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
			const wars = await db.query.warLedgers.findMany({
				where: gte(warLedgers.startTime, ninetyDaysAgo),
				orderBy: (warLedgers, { desc }) => [desc(warLedgers.startTime)],
			});

			// 3. Get current territory count for faction via Drizzle count aggregation
			const ownedRes = await db
				.select({ count: count() })
				.from(territoryStates)
				.where(eq(territoryStates.factionId, factionId));
			const currentTerritoryCount = ownedRes[0]?.count ?? 0;

			// 4. Get all territory blueprints or state IDs
			const allBlueprints = await db.query.territoryBlueprints.findMany();
			const allBlueprintIds = allBlueprints.map((t) => t.id);

			const territoryIdsList =
				allBlueprintIds.length > 0
					? allBlueprintIds
					: (await db.query.territoryStates.findMany()).map((t) => t.id);

			// 5. Get burned territories
			const burnedTerritories = getBurnedTerritories(
				factionId,
				territoryIdsList,
				wars,
				currentTerritoryCount,
			);

			const stats = {
				totalTerritories: territoryIdsList.length,
				burnedCount: burnedTerritories.length,
				availableCount: territoryIdsList.length - burnedTerritories.length,
			};

			logger.info(
				`Generating burn map for faction ${factionId} (${burnedTerritories.length} burned territories)`,
			);

			const pngBuffer = await generateBurnMapPng(
				burnedTerritories,
				factionDisplay,
				stats,
			);

			const attachment = new AttachmentBuilder(pngBuffer, {
				name: `burn-map-${factionId}.png`,
			});

			const embedColor =
				burnedTerritories.length > 0
					? EMBED_COLORS.DANGER
					: EMBED_COLORS.SUCCESS;

			const embed = createBaseEmbed("Territory Burn Map", undefined, embedColor)
				.setImage(`attachment://burn-map-${factionId}.png`)
				.addFields(
					{ name: "Faction", value: factionDisplay, inline: true },
					{
						name: "Status",
						value:
							burnedTerritories.length === 0
								? "No burned territories"
								: `${burnedTerritories.length} burned`,
						inline: true,
					},
				);

			if (wars.length === 0) {
				embed.addFields({
					name: "Data Warning",
					value:
						"No war history found in the last 90 days. All territories shown as available.",
					inline: false,
				});
			}

			await interaction.editReply({
				embeds: [embed],
				files: [attachment],
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("Error in burn-map command:", errorMsg);

			const errorEmbed = createErrorEmbed("Error", errorMsg);

			await interaction.editReply({
				embeds: [errorEmbed],
			});
		}
	},
};
