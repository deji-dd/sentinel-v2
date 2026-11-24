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
	CapitalBook,
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
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Client,
	type Interaction,
	MessageFlags,
} from "discord.js";

import { generateCapitalNavChartPng } from "./capital-nav-chart";
import { generateCapitalTradeChartPng } from "./capital-trade-chart";
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

/**
 * One gate for every capital alert. A book can be muted from its desk without
 * stopping its engine: trading and accounting keep running, only the Discord
 * delivery is skipped. The desk's "test alert" (kind `test`) always goes
 * through, so the scheduler → bot path stays verifiable while muted.
 *
 * Cached briefly because alerts arrive in bursts (e.g. a paper cycle emits
 * several) and a DB read per alert would be wasteful. Fail open on error:
 * a config lookup problem must never silently swallow live alerts.
 */
const alertGateCache = new Map<CapitalBook, { enabled: boolean; at: number }>();
const ALERT_GATE_TTL_MS = 30_000;

export async function isCapitalAlertsEnabled(
	book: CapitalBook,
): Promise<boolean> {
	const cached = alertGateCache.get(book);
	if (cached && Date.now() - cached.at < ALERT_GATE_TTL_MS) {
		return cached.enabled;
	}
	try {
		const config = await getCapitalConfig(book);
		alertGateCache.set(book, { enabled: config.alertsEnabled, at: Date.now() });
		return config.alertsEnabled;
	} catch (error) {
		logger.warn(
			`Could not read ${book} alert setting; delivering alert: ${error instanceof Error ? error.message : String(error)}`,
		);
		return true;
	}
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
	_payload: CapitalAlertPayload,
	embed: ReturnType<typeof createBaseEmbed>,
	components: ActionRowBuilder<ButtonBuilder>[],
	files: AttachmentBuilder[] = [],
): Promise<{ channelId: string | null; messageId: string | null }> {
	// Capital alerts are owner DMs by design. There is no per-book channel
	// setting: a channel shared by live and paper used to double-notify.
	const ownerId = process.env.DISCORD_USER_ID?.trim();
	if (!ownerId) {
		logger.warn("DISCORD_USER_ID is not set; capital alert was not delivered.");
		return { channelId: null, messageId: null };
	}
	const owner = await client.users.fetch(ownerId).catch(() => null);
	if (!owner) {
		logger.warn(`Could not fetch capital alert DM recipient ${ownerId}.`);
		return { channelId: null, messageId: null };
	}
	const message = await owner.send({ embeds: [embed], components, files });
	return { channelId: null, messageId: message.id };
}

/** Delivers one live capital alert (live only). */
export async function handleCapitalAlert(
	client: Client,
	payload: CapitalAlertPayload,
): Promise<void> {
	if (
		payload.kind !== "test" &&
		!(await isCapitalAlertsEnabled(payload.book))
	) {
		logger.info(`Suppressed muted ${payload.book} alert: ${payload.title}`);
		return;
	}
	const embed = createBaseEmbed(
		payload.title,
		payload.body,
		alertColor(payload),
	);
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

	// A chart is an enhancement, never a delivery precondition: if the native
	// renderer or the candle query fails, the owner still gets the full embed.
	const files: AttachmentBuilder[] = [];
	if (payload.trade && payload.stockId) {
		try {
			const png = await generateCapitalTradeChartPng({
				stockId: payload.stockId,
				title: payload.title,
				trade: payload.trade,
			});
			if (png) {
				files.push(new AttachmentBuilder(png, { name: "trade-chart.png" }));
				embed.setImage("attachment://trade-chart.png");
			}
		} catch (error) {
			logger.warn(
				`Could not generate trade chart for '${payload.title}': ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (!files.length && payload.chart) {
		try {
			const png = await generateCapitalNavChartPng(payload.chart);
			if (png) {
				files.push(
					new AttachmentBuilder(png, { name: "unit-price-chart.png" }),
				);
				embed.setImage("attachment://unit-price-chart.png");
			}
		} catch (error) {
			logger.warn(
				`Could not generate unit-price chart for '${payload.title}': ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	try {
		const sent = await sendToDestination(
			client,
			payload,
			embed,
			components,
			files,
		);
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
	if (!(await isCapitalAlertsEnabled("paper"))) {
		logger.info(`Suppressed muted paper report: ${payload.title}`);
		return;
	}
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
