import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	AttachmentBuilder,
	type ChatInputCommandInteraction,
	SlashCommandBuilder,
} from "discord.js";
import type { BotCommand } from "./index";

const REQUEST_CHANNEL_ID = "1546125572252504154";
const GUIDE_IMAGE_PATH = resolve(
	import.meta.dir,
	"../assets/item-request-guide.png",
);

export const itemRequestHelpCommand: BotCommand = {
	data: new SlashCommandBuilder()
		.setName("item-request-help")
		.setDescription(
			"Directs users to the item requests channel with visual guidance.",
		)
		.addUserOption((option) =>
			option
				.setName("user")
				.setDescription("Optional user to direct this message to")
				.setRequired(false),
		),
	scope: "elims",

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		const targetUser = interaction.options.getUser("user");
		const channelMention = `<#${REQUEST_CHANNEL_ID}>`;
		const message = targetUser
			? `${targetUser.toString()} Use ${channelMention}`
			: `Use ${channelMention}`;

		const files: AttachmentBuilder[] = [];
		if (existsSync(GUIDE_IMAGE_PATH)) {
			files.push(
				new AttachmentBuilder(GUIDE_IMAGE_PATH, {
					name: "item-request-guide.png",
				}),
			);
		}

		await interaction.reply({
			content: message,
			files,
		});
	},
};
