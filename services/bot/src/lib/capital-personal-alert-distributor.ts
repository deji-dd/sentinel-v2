import { recordCapitalAlertDelivery } from "@sentinel/database";
import type { CapitalPersonalAlertPayload } from "@sentinel/schemas";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Client,
} from "discord.js";

import { isCapitalAlertsEnabled } from "./capital-alert-distributor";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

/** Discord's code for a user whose DMs are closed or who blocked the bot. */
function isDmClosedError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = (error as { code?: unknown }).code;
	return code === 50007 || code === 50278;
}

function embedColor(kind: CapitalPersonalAlertPayload["kind"]): number {
	if (kind === "payout_paid" || kind === "apr") return EMBED_COLORS.SUCCESS;
	if (kind === "payout_due") return EMBED_COLORS.WARNING;
	return EMBED_COLORS.PRIMARY;
}

/**
 * Delivers one investor's portfolio alert to their Discord DM.
 *
 * A muted book silences these too: the desk's "Simulation alerts" switch is
 * the single gate for every capital message, owner or investor. The recipient
 * is explicit in the payload, so no investor identity is inferred here.
 */
export async function handleCapitalPersonalAlert(
	client: Client,
	payload: CapitalPersonalAlertPayload,
): Promise<void> {
	if (!(await isCapitalAlertsEnabled(payload.book))) {
		logger.info(
			`Suppressed muted ${payload.book} personal alert: ${payload.title}`,
		);
		return;
	}
	if (!payload.recipientDiscordId) {
		logger.warn(`Personal capital alert had no recipient: ${payload.title}`);
		return;
	}

	const embed = createBaseEmbed(
		payload.title,
		payload.body,
		embedColor(payload.kind),
	);
	for (const field of payload.fields ?? []) {
		embed.addFields({
			name: field.name,
			value: field.value,
			inline: field.inline,
		});
	}
	if (payload.book === "paper") {
		embed.addFields({
			name: "Mode",
			value: "SIMULATION — no real funds",
			inline: true,
		});
	}
	const link = payload.link || "https://stocks.blasted-labs.tech/portfolio";
	const components = [
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setLabel("Open portfolio")
				.setStyle(ButtonStyle.Link)
				.setURL(link),
		),
	];

	try {
		const user = await client.users.fetch(payload.recipientDiscordId);
		await user.send({ embeds: [embed], components });
		await recordCapitalAlertDelivery(payload.recipientDiscordId, {
			ok: true,
			dmClosed: false,
		});
	} catch (error) {
		const dmClosed = isDmClosedError(error);
		if (dmClosed) {
			logger.warn(
				`Could not DM capital alert to ${payload.recipientDiscordId}: direct messages are closed.`,
			);
		} else {
			logger.error(
				`Failed to DM capital alert to ${payload.recipientDiscordId}:`,
				error,
			);
		}
		await recordCapitalAlertDelivery(payload.recipientDiscordId, {
			ok: false,
			dmClosed,
		}).catch((dbError) => {
			logger.error("Could not record capital DM delivery result:", dbError);
		});
	}
}
