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
	type ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "../lib/embeds";
import { logger } from "../lib/logger";

export const assaultCheckCommand = {
	data: new SlashCommandBuilder()
		.setName("assault-check")
		.setDescription("Check if a faction can assault a territory")
		.addIntegerOption((opt) =>
			opt
				.setName("faction_id")
				.setDescription("Faction ID to check")
				.setRequired(true),
		)
		.addStringOption((opt) =>
			opt
				.setName("territory_id")
				.setDescription("Territory ID or code (e.g. JCA)")
				.setRequired(true),
		),

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		try {
			await interaction.deferReply();

			const factionId = interaction.options.getInteger("faction_id", true);
			const territoryId = interaction.options
				.getString("territory_id", true)
				.toUpperCase();

			// 1. Fetch faction details from Drizzle DB
			const factionObj = await db.query.factions.findFirst({
				where: eq(factions.id, factionId),
			});
			const factionName = factionObj?.name || `Faction ${factionId}`;
			const factionDisplay = `[${factionName} [${factionId}]](https://www.torn.com/factions.php?step=profile&ID=${factionId})`;

			// 2. Query territory state from Drizzle DB
			const ttState = await db.query.territoryStates.findFirst({
				where: eq(territoryStates.id, territoryId),
			});

			// 3. Fetch war ledger history (last 90 days)
			const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
			const wars = await db.query.warLedgers.findMany({
				where: gte(warLedgers.startTime, ninetyDaysAgo),
				orderBy: (warLedgers, { desc }) => [desc(warLedgers.startTime)],
			});

			const embed = createBaseEmbed(
				`Assault Check • ${territoryId}`,
				undefined,
				EMBED_COLORS.PRIMARY,
			).addFields(
				{ name: "Faction", value: factionDisplay, inline: true },
				{ name: "Territory", value: `\`${territoryId}\``, inline: true },
			);

			if (ttState) {
				const ownerStr = ttState.factionId
					? `[Faction ${ttState.factionId}](https://www.torn.com/factions.php?step=profile&ID=${ttState.factionId})`
					: "*Unclaimed*";
				embed.addFields({
					name: "Current Owner",
					value: ownerStr,
					inline: true,
				});
			}

			let canAssault = true;
			const issues: string[] = [];
			const infoNotes: string[] = [];

			// 4. Get current owned territory count for faction via Drizzle count aggregation
			const ownedRes = await db
				.select({ count: count() })
				.from(territoryStates)
				.where(eq(territoryStates.factionId, factionId));
			const ownedTerritories = ownedRes[0]?.count ?? 0;

			if (ownedTerritories > 0) {
				infoNotes.push(
					`Faction currently owns **${ownedTerritories}** territory/territories.`,
				);
			} else {
				infoNotes.push("Faction currently owns **0** territories.");
			}

			// 5. Check specific territory war history for 72h cooldowns
			const territoryWars = wars.filter((w) => w.tt === territoryId);
			if (territoryWars.length > 0) {
				const recentLossOnTerritory = territoryWars.find(
					(w) =>
						(w.assaultingFaction === factionId ||
							w.defendingFaction === factionId) &&
						w.victorFaction !== factionId,
				);

				if (recentLossOnTerritory) {
					const lossTrigger = 72 * 3600 * 1000; // 72h
					const timeSinceLoss =
						Date.now() - recentLossOnTerritory.startTime.getTime();

					if (timeSinceLoss < lossTrigger) {
						canAssault = false;
						const hoursRemaining = Math.ceil(
							(lossTrigger - timeSinceLoss) / (3600 * 1000),
						);
						issues.push(
							`Faction lost a war on \`${territoryId}\` **${hoursRemaining}h** ago. 72h cooldown active on this territory.`,
						);
					}
				}
			}

			// 6. Status Summary
			if (canAssault) {
				embed.setColor(EMBED_COLORS.SUCCESS).addFields({
					name: "Status",
					value:
						"**ELIGIBLE TO ASSAULT**\nNo active 72h cooldown blocking this assault.",
				});
			} else {
				embed.setColor(EMBED_COLORS.DANGER).addFields({
					name: "Status",
					value: "**COOLDOWN ACTIVE**\nAssault cannot be initiated right now.",
				});
			}

			if (issues.length > 0) {
				embed.addFields({ name: "Cooldown Issues", value: issues.join("\n") });
			}
			if (infoNotes.length > 0) {
				embed.addFields({ name: "Information", value: infoNotes.join("\n") });
			}

			await interaction.editReply({ embeds: [embed] });
		} catch (error) {
			logger.error("Error executing assault-check command:", error);
			const errMsg = error instanceof Error ? error.message : "Internal error";
			const errEmbed = createErrorEmbed(
				"Error executing assault-check",
				errMsg,
			);

			if (interaction.deferred || interaction.replied) {
				await interaction.editReply({ embeds: [errEmbed] });
			} else {
				await interaction.reply({
					embeds: [errEmbed],
					flags: MessageFlags.Ephemeral,
				});
			}
		}
	},
};
