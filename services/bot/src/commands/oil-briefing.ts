import { db, desc, oilRigSnapshots } from "@sentinel/database";
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
			await generateAndSendDirectorBriefing({
				useLiveData: true,
				fetchLiveData: async () => {
					const { tornApi } = await import("@sentinel/torn-api");
					const live = await tornApi.getPersonal("/company", {
						queryParams: { selections: ["profile", "employees", "stock"] },
					});
					return live as unknown as import("@sentinel/utils").CompanySnapshot;
				},
				fetchHistory: async () => {
					const rows = await db
						.select()
						.from(oilRigSnapshots)
						.orderBy(desc(oilRigSnapshots.timestamp))
						.limit(14);
					const chronological = rows.reverse();
					return chronological.map((r, idx) => {
						const rawEmps = (
							Array.isArray(r.employees) ? r.employees : []
						) as Array<Record<string, unknown>>;
						const dailyWages = rawEmps.reduce(
							(sum, e) => sum + Number(e.wage ?? 0),
							0,
						);
						const dailyProfit = r.dailyRevenue - dailyWages - (r.adBudget ?? 0);

						let dailyProduced: number | undefined;
						const prev = idx > 0 ? chronological[idx - 1] : undefined;
						if (prev && r.barrelsSold >= 0) {
							const delta = r.barrelsInStock - prev.barrelsInStock;
							const est = delta + r.barrelsSold;
							if (est >= 0) {
								dailyProduced = est;
							}
						}

						return {
							timestamp: Math.floor(r.timestamp.getTime() / 1000),
							isoDate: r.timestamp.toISOString().slice(0, 10),
							stars: r.rating,
							dailyIncome: r.dailyRevenue,
							weeklyIncome: r.weeklyRevenue,
							dailyWages,
							dailyProfit,
							dailyProduced,
							efficiency: r.efficiency,
							environment: r.environment,
							popularity: r.popularity,
							adBudget: r.adBudget,
							stock: {
								barrelPrice: r.barrelPrice,
								inStock: r.barrelsInStock,
								soldAmount: r.barrelsSold,
								fillPct:
									r.storageCapacity > 0
										? Number(
												((r.barrelsInStock / r.storageCapacity) * 100).toFixed(
													1,
												),
											)
										: 0,
							},
							metrics: {
								totalAddictionPenalty: Number(
									(r.metrics as { totalAddictionPenalty?: number })
										?.totalAddictionPenalty ?? 0,
								),
								employeesWithAddiction: Number(
									(r.metrics as { employeesWithAddiction?: number })
										?.employeesWithAddiction ?? 0,
								),
							},
						};
					});
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
