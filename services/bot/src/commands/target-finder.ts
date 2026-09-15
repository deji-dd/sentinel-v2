import { isSubversiveGuildAsync } from "@sentinel/database";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "../lib/embeds";
import type { BotCommand } from "./index";

export const getTargetFinderScriptUrl = (): string => {
	if (process.env.TARGET_FINDER_SCRIPT_URL) {
		return process.env.TARGET_FINDER_SCRIPT_URL;
	}
	return process.env.NODE_ENV === "production"
		? "https://subversive.blasted-labs.tech/api/v1/target-finder/script.user.js"
		: "http://localhost:3000/api/v1/target-finder/script.user.js?env=dev";
};

export const targetFinderCommand: BotCommand = {
	data: new SlashCommandBuilder()
		.setName("target-finder")
		.setDescription(
			"Get the Subversive Alliance Target Finder userscript install link.",
		),
	scope: "normal",

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		const guildId = interaction.guildId;
		const isSubversive = await isSubversiveGuildAsync(guildId);

		// Subversive Alliance Discord Exclusive Guard
		if (!isSubversive && process.env.NODE_ENV === "production") {
			const errorEmbed = createErrorEmbed(
				"Unauthorized Server",
				"The `/target-finder` command is restricted to the **Subversive Alliance** Discord server.",
			);
			await interaction.reply({
				embeds: [errorEmbed],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const scriptUrl = getTargetFinderScriptUrl();

		const embed = createBaseEmbed(
			"Subversive Alliance — Target Finder Script",
			`[**Direct Install Link**](${scriptUrl})\n\nClick below to install or update the Subversive Alliance Target Finder userscript.`,
			EMBED_COLORS.PRIMARY,
		);

		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setLabel("Install Script")
				.setStyle(ButtonStyle.Link)
				.setURL(scriptUrl),
		);

		await interaction.reply({
			embeds: [embed],
			components: [row],
			flags: MessageFlags.Ephemeral,
		});
	},
};
