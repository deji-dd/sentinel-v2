import {
	type ChatInputCommandInteraction,
	SlashCommandBuilder,
} from "discord.js";
import { dashboardCommand } from "./dashboard";

export const configCommand = {
	data: new SlashCommandBuilder()
		.setName("config")
		.setDescription(
			"Open the interactive web dashboard to configure Sentinel for this server.",
		),

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		await dashboardCommand.execute(interaction);
	},
};
