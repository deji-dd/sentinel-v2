import { EmbedBuilder } from "discord.js";

export const EMBED_COLORS = {
	PRIMARY: 0x3b82f6, // Royal Blue
	SUCCESS: 0x10b981, // Emerald Green
	WARNING: 0xf59e0b, // Amber
	DANGER: 0xef4444, // Red
	DARK: 0x1e1e2e, // Slate Dark
};

/**
 * Standardized base embed frame with zero emojis, "Sentinel" footer, and current timestamp.
 */
export function createBaseEmbed(
	title: string,
	description?: string,
	color: number = EMBED_COLORS.PRIMARY,
): EmbedBuilder {
	const embed = new EmbedBuilder()
		.setTitle(title)
		.setColor(color)
		.setTimestamp()
		.setFooter({ text: "Sentinel" });

	if (description) {
		embed.setDescription(description);
	}

	return embed;
}

/**
 * Standardized success embed helper.
 */
export function createSuccessEmbed(
	title: string,
	description?: string,
): EmbedBuilder {
	return createBaseEmbed(title, description, EMBED_COLORS.SUCCESS);
}

/**
 * Standardized error/warning embed helper.
 */
export function createErrorEmbed(
	title: string,
	description?: string,
): EmbedBuilder {
	return createBaseEmbed(title, description, EMBED_COLORS.DANGER);
}
