import type {
	IpcSubversiveStockAlertsPayload,
	StockAlertEvent,
} from "@sentinel/schemas";
import type { Client, EmbedBuilder, TextChannel } from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

/** Torn's stock market page — the only deep link guaranteed to stay valid. */
const STOCK_MARKET_URL = "https://www.torn.com/stockmarket.php";

/** Discord's hard limit per message; batches are chunked to fit. */
const MAX_EMBEDS_PER_MESSAGE = 10;

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

function titleForAlert(alert: StockAlertEvent): string {
	switch (alert.type) {
		case "high":
			return `Stock Alert — New ${alert.windowLabel} High`;
		case "low":
			return `Stock Alert — New ${alert.windowLabel} Low`;
		case "change":
			return `Stock Alert — Notable Move`;
	}
}

/** Builds the embed for a single alert event. */
export function buildStockAlertEmbed(alert: StockAlertEvent): EmbedBuilder {
	const embed = createBaseEmbed(
		titleForAlert(alert),
		undefined,
		colorForAlert(alert),
	);

	embed.addFields({
		name: "Stock",
		value: `[${alert.acronym} — ${alert.name}](${STOCK_MARKET_URL})`,
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

	embed.addFields(
		{
			name: "24h Range",
			value: `${formatPrice(alert.context.dayLow)} – ${formatPrice(alert.context.dayHigh)}`,
			inline: true,
		},
		{
			name: "All-Time Range",
			value: `${formatPrice(alert.context.allTimeLow)} – ${formatPrice(alert.context.allTimeHigh)}`,
			inline: true,
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
 * Posts a batch of stock alerts into the channel the faction configured.
 *
 * Every alert in the batch travels as one message (chunked at Discord's
 * ten-embed limit) so a market-wide move produces a single post instead of a
 * burst of individual ones. A delivery failure is logged and reported rather
 * than thrown: the caller has no retry, and dropping the batch is preferable to
 * taking down the IPC dispatch loop.
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
