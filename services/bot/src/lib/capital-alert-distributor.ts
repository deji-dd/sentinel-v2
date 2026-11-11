import {
	applyCapitalFill,
	capitalFills,
	capitalReconciliationIssues,
	db,
	eq,
	getCapitalConfig,
	resolveCapitalIssue,
	withCapitalTransaction,
} from "@sentinel/database";
import type {
	CapitalAlertPayload,
	CapitalPaperAlertPayload,
} from "@sentinel/schemas";
import { tornStockUrl } from "@sentinel/schemas";
import {
	formatMoney,
	moneyFromPriceShares,
	mulBps,
	parseMoney,
} from "@sentinel/utils";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Client,
	type Interaction,
	MessageFlags,
} from "discord.js";

import { isDirectorUser } from "./director-auth";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

const DESK_URL = "https://stocks.blasted-labs.tech/desk";
const PAPER_DESK_URL = "https://stocks.blasted-labs.tech/desk/paper";

function alertColor(payload: CapitalAlertPayload): number {
	if (payload.book === "paper") return EMBED_COLORS.WARNING;
	if (payload.kind === "risk" || payload.kind === "key_failure") {
		return EMBED_COLORS.DANGER;
	}
	if (payload.kind === "payout_due" || payload.kind === "payment") {
		return EMBED_COLORS.SUCCESS;
	}
	return EMBED_COLORS.PRIMARY;
}

function buildDecisionRow(
	payload: CapitalAlertPayload,
): ActionRowBuilder<ButtonBuilder> | null {
	if (!payload.decision) return null;
	const row = new ActionRowBuilder<ButtonBuilder>();
	if (payload.decision.type === "unmatched_buy") {
		row.addComponents(
			new ButtonBuilder()
				.setCustomId(`capital_trade:${payload.decision.id}:personal`)
				.setLabel("Personal — ignore")
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`capital_trade:${payload.decision.id}:fund`)
				.setLabel("Record as error trade")
				.setStyle(ButtonStyle.Success),
		);
		return row;
	}

	row.addComponents(
		new ButtonBuilder()
			.setCustomId(`capital_payment:${payload.decision.id}:ignore`)
			.setLabel("Ignore")
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setLabel("Open desk")
			.setStyle(ButtonStyle.Link)
			.setURL(DESK_URL),
	);
	return row;
}

async function sendToDestination(
	client: Client,
	payload: CapitalAlertPayload,
	embed: ReturnType<typeof createBaseEmbed>,
	components: ActionRowBuilder<ButtonBuilder>[],
): Promise<{ channelId: string | null; messageId: string | null }> {
	const config = await getCapitalConfig(payload.book).catch(() => null);
	const channelId =
		payload.book === "paper"
			? config?.paperAlertChannelId
			: config?.liveAlertChannelId;

	if (channelId) {
		try {
			const channel = await client.channels.fetch(channelId);
			if (channel && channel.isTextBased() && "send" in channel) {
				const message = await channel.send({ embeds: [embed], components });
				return { channelId, messageId: message.id };
			}
		} catch (error) {
			logger.warn(
				`Capital alert channel ${channelId} failed; falling back to owner DM: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const ownerId = process.env.DISCORD_USER_ID?.trim();
	if (!ownerId) return { channelId: null, messageId: null };
	const owner = await client.users.fetch(ownerId).catch(() => null);
	if (!owner) return { channelId: null, messageId: null };
	const message = await owner.send({ embeds: [embed], components });
	return { channelId: null, messageId: message.id };
}

/** Delivers one live capital alert (live only). */
export async function handleCapitalAlert(
	client: Client,
	payload: CapitalAlertPayload,
): Promise<void> {
	const embed = createBaseEmbed(
		payload.book === "paper" ? `[PAPER] ${payload.title}` : payload.title,
		payload.body,
		alertColor(payload),
	);
	if (payload.book === "paper") {
		embed.addFields({
			name: "Mode",
			value: "SIMULATION — no real funds",
			inline: true,
		});
	}
	for (const field of payload.fields ?? []) {
		embed.addFields({
			name: field.name,
			value: field.value,
			inline: field.inline,
		});
	}
	if (payload.link) {
		embed.setURL(payload.link);
	}
	const components: ActionRowBuilder<ButtonBuilder>[] = [];
	const decisionRow = buildDecisionRow(payload);
	if (decisionRow) components.push(decisionRow);
	if (payload.stockId) {
		components.push(
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setLabel("Open stock in Torn")
					.setStyle(ButtonStyle.Link)
					.setURL(tornStockUrl(payload.stockId)),
			),
		);
	}

	try {
		const sent = await sendToDestination(client, payload, embed, components);
		if (payload.decision && payload.decision.id) {
			await db
				.update(capitalReconciliationIssues)
				.set({
					discordChannelId: sent.channelId,
					discordMessageId: sent.messageId,
					updatedAt: new Date(),
				})
				.where(eq(capitalReconciliationIssues.id, payload.decision.id));
		}
	} catch (error) {
		logger.error(
			`Failed to deliver capital ${payload.book} alert '${payload.title}': ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Delivers a paper/smoke-test alert with a visually distinct presentation. */
export async function handleCapitalPaperAlert(
	client: Client,
	payload: CapitalPaperAlertPayload,
): Promise<void> {
	const embed = createBaseEmbed(
		payload.title,
		payload.summary,
		payload.success ? EMBED_COLORS.WARNING : EMBED_COLORS.DANGER,
	).addFields(
		{ name: "Mode", value: "SIMULATION — no real funds", inline: true },
		{ name: "Report", value: payload.reportId, inline: true },
	);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setLabel("Open paper desk")
			.setStyle(ButtonStyle.Link)
			.setURL(payload.link || PAPER_DESK_URL),
	);

	try {
		await sendToDestination(
			client,
			{
				kind: "risk",
				book: "paper",
				title: payload.title,
				body: payload.summary,
			},
			embed,
			[row],
		);
	} catch (error) {
		logger.error(
			`Failed to deliver paper smoke alert: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Handles a Personal/Record decision for an unmatched stock trade.
 *
 * Recording uses the original Torn log id as the ledger's idempotency key.
 * Selecting Personal resolves the issue without touching the book.
 */
export async function handleCapitalTradeButton(
	interaction: Interaction,
): Promise<void> {
	if (!interaction.isButton()) return;
	if (!isDirectorUser(interaction.user.id)) {
		await interaction.reply({
			content: "Only the fund owner can resolve this trade.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}
	const parts = interaction.customId.split(":");
	const issueId = parts[1];
	const action = parts[2];
	if (!issueId || (action !== "personal" && action !== "fund")) return;

	const [issue] = await db
		.select()
		.from(capitalReconciliationIssues)
		.where(eq(capitalReconciliationIssues.id, issueId))
		.limit(1);
	if (!issue) {
		await interaction.reply({
			content: "That issue no longer exists.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}
	if (issue.status !== "open") {
		await interaction.reply({
			content: "That issue has already been resolved.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (action === "personal") {
		await resolveCapitalIssue(
			issue.id,
			"ignored",
			interaction.user.id,
			"Marked personal from the Discord decision.",
		);
		await interaction.update({ components: [] }).catch(() => {});
		await interaction
			.followUp({
				content: "Marked personal; the fund book was not changed.",
				flags: MessageFlags.Ephemeral,
			})
			.catch(() => {});
		return;
	}

	const details = issue.details;
	const stockId = Number(details.stockId ?? issue.stockId);
	const shares = Number(details.shares);
	const price = Number(details.price);
	const side = details.side === "sell" ? "sell" : "buy";
	const logId = typeof details.logId === "string" ? details.logId : null;
	if (
		!Number.isInteger(stockId) ||
		stockId <= 0 ||
		!Number.isFinite(shares) ||
		shares <= 0 ||
		!Number.isFinite(price) ||
		price <= 0
	) {
		await interaction.reply({
			content:
				"The issue is missing the trade details; open the desk to resolve it.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const notional = moneyFromPriceShares(price.toFixed(6), shares);
	const fees = side === "sell" ? mulBps(notional, 10) : parseMoney("0");
	const cashDelta = side === "buy" ? -(notional + fees) : notional - fees;

	try {
		await withCapitalTransaction("live", async (tx) => {
			await applyCapitalFill(tx, {
				book: "live",
				stockId,
				side,
				shares,
				price: price.toFixed(6),
				notional: formatMoney(notional),
				fees: formatMoney(fees),
				cashDelta: formatMoney(cashDelta),
				totalCost: formatMoney(notional + fees),
				source: "decision",
				unplanned: true,
				occurredAt: new Date(),
			});
			await tx.insert(capitalFills).values({
				book: "live",
				stockId,
				side,
				shares,
				price: price.toFixed(6),
				notional: formatMoney(notional),
				fees: formatMoney(fees),
				source: "decision",
				sourceLogId: logId,
				occurredAt: new Date(),
				decisionIssueId: issue.id,
			});
		});
		await resolveCapitalIssue(
			issue.id,
			"resolved",
			interaction.user.id,
			"Recorded as a fund trade from the Discord decision.",
		);
		await interaction.update({ components: [] }).catch(() => {});
		await interaction
			.followUp({
				content: `Recorded as a fund error ${side} of ${shares.toLocaleString()} shares. The engine will manage it with a tighter stop.`,
				flags: MessageFlags.Ephemeral,
			})
			.catch(() => {});
	} catch (error) {
		logger.error("Failed to record capital decision fill:", error);
		await interaction.reply({
			content: "Recording failed; open the desk to resolve it manually.",
			flags: MessageFlags.Ephemeral,
		});
	}
}

/** Handles the Ignore button on an unmatched payment issue. */
export async function handleCapitalPaymentButton(
	interaction: Interaction,
): Promise<void> {
	if (!interaction.isButton()) return;
	if (!isDirectorUser(interaction.user.id)) {
		await interaction.reply({
			content: "Only the fund owner can resolve this payment.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}
	const parts = interaction.customId.split(":");
	const issueId = parts[1];
	const action = parts[2];
	if (!issueId || action !== "ignore") return;

	await resolveCapitalIssue(
		issueId,
		"ignored",
		interaction.user.id,
		"Ignored from the Discord decision.",
	);
	await interaction.update({ components: [] }).catch(() => {});
	await interaction
		.followUp({
			content: "Ignored. Nothing was added to the ledger.",
			flags: MessageFlags.Ephemeral,
		})
		.catch(() => {});
}
