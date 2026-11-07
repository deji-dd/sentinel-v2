import { generateAndSendEmployeePositioning } from "@sentinel/utils";
import {
	type ChatInputCommandInteraction,
	SlashCommandBuilder,
} from "discord.js";

import { isDirectorUser } from "../lib/director-auth";
import { createBaseEmbed, EMBED_COLORS } from "../lib/embeds";

export const oilPositionsCommand = {
	data: new SlashCommandBuilder()
		.setName("oil-positions")
		.setDescription(
			"Shows recommended employee positioning and a full stat/pay breakdown for Succession Oil.",
		),

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!isDirectorUser(interaction.user.id)) {
			await interaction.reply({
				content: "You are not authorized to request employee positioning.",
				ephemeral: true,
			});
			return;
		}

		await interaction.deferReply({ ephemeral: true });

		try {
			await generateAndSendEmployeePositioning({
				useLiveData: true,
				fetchLiveData: async () => {
					const { tornApi } = await import("@sentinel/torn-api");
					const live = await tornApi.getPersonal("/company", {
						queryParams: { selections: ["profile", "employees", "stock"] },
					});
					return live as unknown as import("@sentinel/utils").CompanySnapshot;
				},
			});

			const successEmbed = createBaseEmbed(
				"Employee Positioning Delivered",
				"Recommended role changes and the full employee stat/pay breakdown have been dispatched directly to your Discord DMs.",
				EMBED_COLORS.SUCCESS,
			);

			await interaction.editReply({ embeds: [successEmbed] });
		} catch (error) {
			const errMessage = error instanceof Error ? error.message : String(error);
			const errorEmbed = createBaseEmbed(
				"Employee Positioning Failed",
				`An error occurred while generating employee positioning: \`${errMessage}\``,
				EMBED_COLORS.DANGER,
			);
			await interaction.editReply({ embeds: [errorEmbed] });
		}
	},
};
