import { EmbedBuilder } from "discord.js";

export const EMBED_COLORS = {
	PRIMARY: 0x3b82f6, // Royal Blue
	SUCCESS: 0x10b981, // Emerald Green
	WARNING: 0xf59e0b, // Amber
	DANGER: 0xef4444, // Red
	DARK: 0x1e1e2e, // Slate Dark
};

/**
 * Hex representation of the danger red, used to tint embed titles and text via
 * Discord's inline markdown so stricken hits read as unmistakably red.
 */
export const EMBED_HEX_DANGER = "#ef4444";

/**
 * Full-block characters used to render a solid red banner inside an embed.
 * Discord has no native coloured inline text, so a red banner paired with a red
 * embed border is what actually communicates "danger" at a glance.
 */
const STRICKEN_BANNER_CHAR = "\u{1F534}"; // Large red circle
const STRICKEN_BANNER_WIDTH = 12;

/**
 * Builds a solid red banner line for stricken-hit embeds.
 */
export function buildStrickenBanner(): string {
	return STRICKEN_BANNER_CHAR.repeat(STRICKEN_BANNER_WIDTH);
}

/**
 * Wraps a label so it renders in red inside an embed description, followed by the
 * solid red banner. Used for the STRICKEN HIT marker.
 */
export function buildStrickenMarker(label = "STRICKEN HIT"): string {
	return `## ${EMBED_HEX_DANGER}**${label}**\n${buildStrickenBanner()}`;
}

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
