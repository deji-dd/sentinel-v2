import {
	type IpcSubversiveStockAlertsPayload,
	type IpcUserStockAlertsPayload,
	type StockAlertEvent,
	stockAlertPeriod,
	type UserStockAlertEvent,
} from "@sentinel/schemas";
import type { Client, EmbedBuilder, TextChannel } from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

/**
 * Deep link to one stock's price chart.
 *
 * Torn's own stock page takes the stock, the tab and the chart period, so an alert
 * can open on exactly the window it was raised for — a new 30-day low lands on the
 * monthly chart rather than the default view. `period` is Torn's spelling, which
 * `stockAlertPeriod` maps from our range vocabulary (`all_time` -> `alltime`).
 */
export function buildStockMarketUrl(
	stockId: number,
	range?: StockAlertEvent["range"],
): string {
	return `https://www.torn.com/page.php?sid=stocks&stockID=${stockId}&tab=price&period=${stockAlertPeriod(range)}`;
}

/** Discord's hard limit per message; batches are chunked to fit. */
const MAX_EMBEDS_PER_MESSAGE = 10;

/**
 * Prefix on every personal-alert DM, so a member who has several subscriptions
 * firing at once can tell the messages apart from the market-wide channel posts.
 */
const USER_ALERT_TITLE_PREFIX = "Your Stock Alert";

function formatPrice(value: number): string {
	return `$${value.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}

function formatSignedPrice(value: number): string {
	const sign = value > 0 ? "+" : value < 0 ? "-" : "";
	return `${sign}${formatPrice(Math.abs(value))}`;
}

function formatSignedPct(value: number): string {
	const sign = value > 0 ? "+" : "";
	return `${sign}${value.toFixed(2)}%`;
}

/**
 * Colour by direction, matching how the stock market reads at a glance: green for
 * strength (a new high, a gain), red for weakness (a new low, a drop).
 */
function colorForAlert(alert: StockAlertEvent): number {
	switch (alert.type) {
		case "high":
			return EMBED_COLORS.SUCCESS;
		case "low":
			return EMBED_COLORS.DANGER;
		case "change":
			return (alert.changePct ?? 0) >= 0
				? EMBED_COLORS.SUCCESS
				: EMBED_COLORS.DANGER;
	}
}

function titleForAlert(alert: StockAlertEvent, prefix = "Stock Alert"): string {
	switch (alert.type) {
		case "high":
			return `${prefix} — New ${alert.windowLabel} High`;
		case "low":
			return `${prefix} — New ${alert.windowLabel} Low`;
		case "change":
			return `${prefix} — Notable Move`;
	}
}

/**
 * Builds the embed for a single alert event.
 *
 * The range context lists exactly the ranges the guild tracks, so a server that
 * watches a month and a year never sees a "24h range" figure it never asked for.
 */
export function buildStockAlertEmbed(
	alert: StockAlertEvent,
	prefix = "Stock Alert",
): EmbedBuilder {
	const embed = createBaseEmbed(
		titleForAlert(alert, prefix),
		undefined,
		colorForAlert(alert),
	);

	embed.addFields({
		name: "Stock",
		value: `[${alert.acronym} — ${alert.name}](${buildStockMarketUrl(alert.stockId, alert.range)})`,
		inline: false,
	});

	if (alert.type === "change") {
		const reference =
			alert.referencePrice !== undefined
				? ` (from ${formatPrice(alert.referencePrice)} ${alert.windowLabel.toLowerCase()} ago)`
				: "";
		embed.addFields(
			{
				name: "Move",
				value: `**${formatSignedPct(alert.changePct ?? 0)}** in ${alert.windowLabel}${reference}`,
				inline: true,
			},
			{
				name: "Price",
				value: formatPrice(alert.price),
				inline: true,
			},
			{
				name: "Threshold",
				value: `${formatSignedPct(alert.thresholdPct ?? 0)}`,
				inline: true,
			},
		);
	} else {
		const extreme = alert.extreme ?? alert.price;
		const direction = alert.type === "high" ? "high" : "low";
		embed.addFields(
			{
				name: `New ${alert.windowLabel} ${direction}`,
				value: `**${formatPrice(extreme)}**`,
				inline: true,
			},
			{
				name: "Current Price",
				value: formatPrice(alert.price),
				inline: true,
			},
			{
				name: "Previous",
				value:
					alert.previousExtreme !== undefined
						? formatPrice(alert.previousExtreme)
						: "Unknown",
				inline: true,
			},
		);
	}

	if (alert.type === "high" || alert.type === "low") {
		const delta =
			alert.previousExtreme !== undefined
				? formatSignedPrice(
						(alert.extreme ?? alert.price) - alert.previousExtreme,
					)
				: null;
		if (delta) {
			embed.addFields({
				name: "Change vs Previous",
				value: delta,
				inline: true,
			});
		}
	}

	const ranges = alert.context?.ranges ?? [];
	if (ranges.length > 0) {
		embed.addFields({
			name: ranges.length === 1 ? `${ranges[0]?.label} Range` : "Ranges",
			value: ranges
				.map(
					(entry) =>
						`**${entry.label}:** ${formatPrice(entry.low)} – ${formatPrice(entry.high)}`,
				)
				.join("\n")
				.slice(0, 1024),
			inline: ranges.length === 1,
		});
	}

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
 * Posts a batch of stock alerts into the channel the guild configured.
 *
 * Every alert in the batch travels as one message (chunked at Discord's ten-embed
 * limit) so a market-wide move produces a single post instead of a burst of
 * individual ones. A delivery failure is logged and reported rather than thrown:
 * the caller has no retry, and dropping the batch is preferable to taking down the
 * IPC dispatch loop.
 */
export async function handleSubversiveStockAlerts(
	client: Client,
	payload: IpcSubversiveStockAlertsPayload,
): Promise<boolean> {
	const alerts = payload.alerts ?? [];
	if (!payload.notificationChannelId || alerts.length === 0) return false;

	try {
		const channel = await client.channels.fetch(payload.notificationChannelId);
		if (!channel?.isTextBased()) {
			logger.warn(
				`Stock alert channel ${payload.notificationChannelId} not found or not text-based.`,
			);
			return false;
		}

		const textChannel = channel as TextChannel;

		for (const batch of chunk(alerts, MAX_EMBEDS_PER_MESSAGE)) {
			await textChannel.send({
				embeds: batch.map((alert) => buildStockAlertEmbed(alert)),
			});
		}

		const channelLabel = textChannel.name
			? `#${textChannel.name}`
			: payload.notificationChannelId;
		logger.info(
			`Dispatched ${alerts.length} stock alert(s) to ${channelLabel}.`,
		);
		return true;
	} catch (err) {
		logger.error("Failed to send stock alerts to Discord:", err);
		return false;
	}
}

/**
 * Replies to a delivery failure caused by the user, not by us.
 *
 * Discord reports a closed DM channel as `50007`. That is the expected outcome for
 * someone who has DMs disabled or has never opened a conversation with the bot, so
 * it is reported as a warning rather than an error — and it must never be retried,
 * because nothing about the next cycle would change it.
 */
function isDmClosedError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const code = (error as { code?: unknown }).code;
	return code === 50007 || code === 50278;
}

/**
 * Delivers personal stock alerts by DM.
 *
 * One message per user, batched across that user's alerts so several conditions
 * firing on the same stock in one cycle arrive as a single DM rather than a burst.
 * Each user is delivered independently and failures are swallowed: one member with
 * DMs closed must not stop the rest of the batch.
 *
 * Returns the number of users successfully notified.
 */
export async function handleUserStockAlerts(
	client: Client,
	payload: IpcUserStockAlertsPayload,
): Promise<number> {
	const alerts = payload.alerts ?? [];
	if (alerts.length === 0) return 0;

	const byUser = new Map<string, UserStockAlertEvent[]>();
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
			await user.send({
				embeds: userAlerts
					.slice(0, MAX_EMBEDS_PER_MESSAGE)
					.map((alert) =>
						buildStockAlertEmbed(alert.event, USER_ALERT_TITLE_PREFIX),
					),
			});
			delivered++;
		} catch (err) {
			if (isDmClosedError(err)) {
				logger.warn(
					`Could not DM stock alert to ${discordUserId}: direct messages are closed.`,
				);
			} else {
				logger.error(`Failed to DM stock alert to ${discordUserId}:`, err);
			}
		}
	}

	return delivered;
}
