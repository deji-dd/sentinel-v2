import {
	type IpcUserShopliftingAlertsPayload,
	USER_SHOPLIFTING_ALERT_CONDITION_LABELS,
	type UserShopliftingAlertCondition,
	type UserShopliftingAlertEvent,
} from "@sentinel/schemas";
import type { Client, EmbedBuilder } from "discord.js";

import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

/**
 * Deep link to Torn's shoplifting page.
 *
 * Torn does not expose a per-shop deep link for Crimes 2.0, so the alert opens
 * the crime page itself and lets the reader pick the shop.
 */
export const SHOPLIFTING_URL =
	"https://www.torn.com/page.php?sid=crimes#/shoplifting";

/** Discord's hard limit per message; batches are chunked to fit. */
const MAX_EMBEDS_PER_MESSAGE = 10;

/** Prefix on every personal-alert DM. */
const USER_ALERT_TITLE_PREFIX = "Your Shoplifting Alert";

function titleForCondition(
	condition: UserShopliftingAlertCondition,
	transition: UserShopliftingAlertEvent["transition"],
): string {
	if (transition === "up") {
		switch (condition) {
			case "cameras_down":
				return "Cameras Back Online";
			case "guards_down":
				return "Guards Back On Duty";
			case "all_down":
				return "Security Restored";
		}
	}

	switch (condition) {
		case "cameras_down":
			return "Cameras Disabled";
		case "guards_down":
			return "Guards On Break";
		case "all_down":
			return "All Security Disabled";
	}
}

/**
 * Builds the embed for one alert.
 *
 * The full security state is listed, not just the trigger, so the reader can see
 * whether the other measure is still active before heading to the shop. Down
 * transitions are green (the window has opened); recoveries are amber (it has
 * closed).
 */
export function buildShopliftingAlertEmbed(
	alert: UserShopliftingAlertEvent,
	prefix = USER_ALERT_TITLE_PREFIX,
): EmbedBuilder {
	const down = alert.transition === "down";
	const embed = createBaseEmbed(
		`${prefix} — ${titleForCondition(alert.condition, alert.transition)}`,
		alert.description,
		down ? EMBED_COLORS.SUCCESS : EMBED_COLORS.WARNING,
	);

	embed.addFields(
		{
			name: "Shop",
			value: `[${alert.shopName}](${SHOPLIFTING_URL})`,
			inline: true,
		},
		{
			name: "Trigger",
			value: USER_SHOPLIFTING_ALERT_CONDITION_LABELS[alert.condition],
			inline: true,
		},
		{
			name: "Security",
			value:
				alert.statuses
					.map((status) => {
						if (status.disabled) return `**Disabled** — ${status.title}`;
						return `${down ? "Active" : "Back online"} — ${status.title}`;
					})
					.join("\n")
					.slice(0, 1024) || "Unknown",
			inline: false,
		},
	);

	return embed;
}

function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

/**
 * Replies to a delivery failure caused by the user, not by us.
 *
 * Discord reports a closed DM channel as `50007`/`50278`, which is the expected
 * outcome for someone who has DMs disabled. It is a warning, never a retry.
 */
function isDmClosedError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = (error as { code?: unknown }).code;
	return code === 50007 || code === 50278;
}

/**
 * Delivers personal shoplifting alerts by DM.
 *
 * One message per user, batched across that user's alerts so several shops going
 * down in the same poll arrive as a single DM. Each user is delivered
 * independently: one member with DMs closed must not stop the rest.
 *
 * Returns the number of users successfully notified.
 */
export async function handleUserShopliftingAlerts(
	client: Client,
	payload: IpcUserShopliftingAlertsPayload,
): Promise<number> {
	const alerts = payload.alerts ?? [];
	if (alerts.length === 0) return 0;

	const byUser = new Map<string, UserShopliftingAlertEvent[]>();
	for (const alert of alerts) {
		if (!alert.discordUserId) continue;
		const bucket = byUser.get(alert.discordUserId);
		if (bucket) bucket.push(alert);
		else byUser.set(alert.discordUserId, [alert]);
	}

	let delivered = 0;

	for (const [discordUserId, userAlerts] of byUser) {
		try {
			const user = await client.users.fetch(discordUserId);
			for (const batch of chunk(userAlerts, MAX_EMBEDS_PER_MESSAGE)) {
				await user.send({
					embeds: batch.map((alert) => buildShopliftingAlertEmbed(alert)),
				});
			}
			delivered++;
		} catch (err) {
			if (isDmClosedError(err)) {
				logger.warn(
					`Could not DM shoplifting alert to ${discordUserId}: direct messages are closed.`,
				);
			} else {
				logger.error(
					`Failed to DM shoplifting alert to ${discordUserId}:`,
					err,
				);
			}
		}
	}

	return delivered;
}
