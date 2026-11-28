import { db, eq, guildConfigs } from "@sentinel/database";
import type { IpcYabaChartsMessage } from "@sentinel/schemas";
import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Client,
	TextChannel,
} from "discord.js";

import { createBaseEmbed } from "./embeds";
import { logger } from "./logger";
import { renderYabaTopTenChartPng } from "./yaba-chart";

/**
 * Publishes the scheduler's daily YABA top-10 report to the alliance guild.
 *
 * Each chart owns one persistent message per channel, edited in place on later
 * reports so the dedicated channels do not fill up with copies. Delivery is
 * deliberately best-effort: a broken channel must not stop the other chart or
 * throw back into the IPC listener.
 */

type YabaChartsData = IpcYabaChartsMessage["data"];
type ChartKind = "faction" | "player";

type YabaChartConfig = {
	guildId: string;
	yabaFactionChartChannelId: string | null;
	yabaFactionChartMessageId: string | null;
	yabaPlayerChartChannelId: string | null;
	yabaPlayerChartMessageId: string | null;
};

/** Last report per guild, reused when an admin moves a chart channel. */
const lastPayloads = new Map<string, YabaChartsData>();

function rowsForKind(
	payload: YabaChartsData,
	kind: ChartKind,
): Array<{ name: string; score: number }> {
	return kind === "faction" ? payload.factions : payload.players;
}

function chartTitle(payload: YabaChartsData, kind: ChartKind): string {
	return kind === "faction"
		? `YABA — Top 10 Factions (${payload.window})`
		: `YABA — Top 10 Players (${payload.window})`;
}

function buildDescription(payload: YabaChartsData, kind: ChartKind): string {
	const lines =
		kind === "faction"
			? payload.factions
					.slice(0, 10)
					.map((row) => `${row.rank}. ${row.name} — ${row.score}`)
			: payload.players
					.slice(0, 10)
					.map(
						(row) =>
							`${row.rank}. ${row.name} — ${row.score}${row.factionName ? ` · ${row.factionName}` : ""}`,
					);

	return [
		`Generated ${payload.generatedAt} · Window ${payload.window}`,
		"",
		...lines,
	].join("\n");
}

async function persistMessageId(
	guildId: string,
	kind: ChartKind,
	messageId: string,
): Promise<void> {
	await db
		.update(guildConfigs)
		.set(
			kind === "faction"
				? { yabaFactionChartMessageId: messageId, updatedAt: new Date() }
				: { yabaPlayerChartMessageId: messageId, updatedAt: new Date() },
		)
		.where(eq(guildConfigs.guildId, guildId));
}

async function clearStoredMessageId(
	guildId: string,
	kind: ChartKind,
): Promise<void> {
	await db
		.update(guildConfigs)
		.set(
			kind === "faction"
				? { yabaFactionChartMessageId: null, updatedAt: new Date() }
				: { yabaPlayerChartMessageId: null, updatedAt: new Date() },
		)
		.where(eq(guildConfigs.guildId, guildId));
}

async function publishChart(
	client: Client,
	guildId: string,
	channelId: string,
	messageId: string | null,
	kind: ChartKind,
	payload: YabaChartsData,
): Promise<void> {
	const channel = await client.channels.fetch(channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) {
		logger.warn(
			`YABA ${kind} chart channel ${channelId} for guild ${guildId} not found or not a text channel.`,
		);
		return;
	}

	const title = chartTitle(payload, kind);
	const png = renderYabaTopTenChartPng(rowsForKind(payload, kind), title);
	const file = new AttachmentBuilder(png, { name: "yaba-top10.png" });

	const embed = createBaseEmbed(title, buildDescription(payload, kind));
	embed.setImage("attachment://yaba-top10.png");

	const components = [
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setLabel("Full leaderboard")
				.setStyle(ButtonStyle.Link)
				.setURL(payload.uiUrl),
		),
	];

	const existing = messageId
		? await channel.messages.fetch(messageId).catch(() => null)
		: null;
	if (existing) {
		await existing.edit({ embeds: [embed], components, files: [file] });
		return;
	}

	const sent = await channel.send({
		embeds: [embed],
		components,
		files: [file],
	});
	await persistMessageId(guildId, kind, sent.id);
}

async function publishForConfig(
	client: Client,
	config: YabaChartConfig,
	payload: YabaChartsData,
): Promise<void> {
	const targets: Array<{
		channelId: string | null;
		messageId: string | null;
		kind: ChartKind;
	}> = [
		{
			channelId: config.yabaFactionChartChannelId,
			messageId: config.yabaFactionChartMessageId,
			kind: "faction",
		},
		{
			channelId: config.yabaPlayerChartChannelId,
			messageId: config.yabaPlayerChartMessageId,
			kind: "player",
		},
	];

	for (const target of targets) {
		if (!target.channelId) {
			logger.warn(
				`No YABA ${target.kind} chart channel configured for guild ${config.guildId}; skipping.`,
			);
			continue;
		}
		try {
			await publishChart(
				client,
				config.guildId,
				target.channelId,
				target.messageId,
				target.kind,
				payload,
			);
		} catch (err) {
			logger.warn(
				`Failed to publish YABA ${target.kind} chart for guild ${config.guildId}:`,
				err,
			);
		}
	}
}

/** Delivers a YABA charts IPC payload to both configured alliance channels. */
export async function handleYabaCharts(
	client: Client,
	payload: YabaChartsData,
): Promise<void> {
	try {
		lastPayloads.set(payload.guildId, payload);
		const [config] = await db
			.select()
			.from(guildConfigs)
			.where(eq(guildConfigs.guildId, payload.guildId))
			.limit(1);
		if (!config) {
			logger.warn(
				`No guild configuration found for YABA charts in guild ${payload.guildId}.`,
			);
			return;
		}
		await publishForConfig(client, config, payload);
	} catch (err) {
		logger.warn(
			`Failed to handle YABA charts for guild ${payload.guildId}:`,
			err,
		);
	}
}

async function syncOneChartChannel(
	client: Client,
	config: YabaChartConfig,
	kind: ChartKind,
	payload: YabaChartsData | undefined,
): Promise<void> {
	const channelId =
		kind === "faction"
			? config.yabaFactionChartChannelId
			: config.yabaPlayerChartChannelId;
	const messageId =
		kind === "faction"
			? config.yabaFactionChartMessageId
			: config.yabaPlayerChartMessageId;

	if (!channelId) {
		if (messageId) {
			await clearStoredMessageId(config.guildId, kind);
			logger.info(
				`Cleared stale YABA ${kind} chart message id for guild ${config.guildId}: no channel configured.`,
			);
		}
		return;
	}

	if (payload) {
		await publishChart(
			client,
			config.guildId,
			channelId,
			messageId,
			kind,
			payload,
		);
		return;
	}

	// No report has arrived in this process yet: only reconcile a tracked
	// message that no longer exists so the next report starts a fresh one.
	const channel = await client.channels.fetch(channelId).catch(() => null);
	if (!(channel instanceof TextChannel)) {
		logger.warn(
			`YABA ${kind} chart channel ${channelId} for guild ${config.guildId} not found or not a text channel.`,
		);
		return;
	}
	if (messageId) {
		const existing = await channel.messages.fetch(messageId).catch(() => null);
		if (!existing) {
			await clearStoredMessageId(config.guildId, kind);
			logger.info(
				`Cleared stale YABA ${kind} chart message id for guild ${config.guildId}.`,
			);
		}
	}
}

/**
 * Reconciles chart channels after an admin changes them in the API. With a
 * cached report the charts are republished immediately; cleared channels drop
 * their persisted message ids. Always safe to call without awaiting.
 */
export async function syncYabaChartChannels(
	client: Client,
	guildId?: string,
): Promise<void> {
	try {
		const configs: YabaChartConfig[] = guildId
			? await db
					.select()
					.from(guildConfigs)
					.where(eq(guildConfigs.guildId, guildId))
			: await db.select().from(guildConfigs);

		for (const config of configs) {
			try {
				const payload = lastPayloads.get(config.guildId);
				await syncOneChartChannel(client, config, "faction", payload);
				await syncOneChartChannel(client, config, "player", payload);
			} catch (err) {
				logger.warn(
					`Failed to sync YABA chart channels for guild ${config.guildId}:`,
					err,
				);
			}
		}
	} catch (err) {
		logger.warn("Failed to sync YABA chart channels:", err);
	}
}
