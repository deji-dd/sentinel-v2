import { generateAndSendDirectorBriefing } from "@sentinel/utils";
import {
	type ChatInputCommandInteraction,
	SlashCommandBuilder,
} from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "../lib/embeds";

export const oilBriefingCommand = {
	data: new SlashCommandBuilder()
		.setName("oil-briefing")
		.setDescription(
			"Generates an on-demand live strategic director briefing for Succession Oil.",
		),

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		const allowedUserId = process.env.DISCORD_USER_ID;
		if (allowedUserId && interaction.user.id !== allowedUserId) {
			await interaction.reply({
				content: "You are not authorized to request director briefings.",
				ephemeral: true,
			});
			return;
		}

		await interaction.deferReply({ ephemeral: true });

		try {
			// History is intentionally not passed: generateAndSendDirectorBriefing
			// loads the canonical rolling window (loadRollingHistory) itself. The
			// hand-rolled mapper that used to live here was a near-duplicate of it
			// and had already drifted out of sync.
			await generateAndSendDirectorBriefing({
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
				"Oil Rig Director Briefing Delivered",
				"Your comprehensive operational analysis, role optimization, and week-to-date performance logs have been dispatched directly to your Discord DMs.",
				EMBED_COLORS.SUCCESS,
			);

			await interaction.editReply({ embeds: [successEmbed] });
		} catch (error) {
			const errMessage = error instanceof Error ? error.message : String(error);
			const errorEmbed = createBaseEmbed(
				"Briefing Generation Failed",
				`An error occurred while generating the director briefing: \`${errMessage}\``,
				EMBED_COLORS.DANGER,
			);
			await interaction.editReply({ embeds: [errorEmbed] });
		}
	},
};
