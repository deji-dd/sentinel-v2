import { db, eq, guildConfigs } from "@sentinel/database";
import type { BulkVerificationProgressData } from "@sentinel/schemas";
import { type Client, type Message, TextChannel } from "discord.js";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

interface ActiveCronMessage {
	message: Message;
	lastEditTime: number;
	highestProcessed: number;
}

const activeCronMessages = new Map<string, ActiveCronMessage>();

function createProgressEmbed(
	processed: number,
	total: number,
	updated: number,
	errors: number,
) {
	const pct =
		total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
	const barLength = 16;
	const filled = Math.min(barLength, Math.round((pct / 100) * barLength));
	const empty = Math.max(0, barLength - filled);
	const progressBar = `[${"█".repeat(filled)}${"░".repeat(empty)}] ${pct}%`;

	return createBaseEmbed(
		"Scheduled Verification Sweep",
		`Running automated background verification check...\n\n\`${progressBar}\``,
		EMBED_COLORS.PRIMARY,
	).addFields(
		{ name: "Progress", value: `${processed} / ${total}`, inline: true },
		{ name: "Members Updated", value: `${updated}`, inline: true },
		{ name: "Errors / Skipped", value: `${errors}`, inline: true },
	);
}

function createCompleteEmbed(
	processed: number,
	total: number,
	updated: number,
	errors: number,
) {
	return createBaseEmbed(
		"Scheduled Verification Sweep Complete",
		"Automated background verification run completed for this server.",
		EMBED_COLORS.SUCCESS,
	).addFields(
		{ name: "Total Processed", value: `${processed} / ${total}`, inline: true },
		{ name: "Members Updated", value: `${updated}`, inline: true },
		{ name: "Errors / Skipped", value: `${errors}`, inline: true },
	);
}

export async function handleCronVerificationProgress(
	client: Client,
	requestId: string,
	progress: BulkVerificationProgressData,
): Promise<void> {
	try {
		const guildId = progress.guildId;
		if (!guildId) return;

		// Apply real-time Discord role additions/removals and nickname changes
		if (progress.actions && progress.actions.length > 0) {
			const guild =
				client.guilds.cache.get(guildId) ||
				(await client.guilds.fetch(guildId).catch(() => null));
			if (guild) {
				for (const action of progress.actions) {
					const member =
						guild.members.cache.get(action.discordId) ||
						(await guild.members.fetch(action.discordId).catch(() => null));
					if (member) {
						if (action.rolesToAdd && action.rolesToAdd.length > 0) {
							await member.roles.add(action.rolesToAdd).catch(() => {});
						}
						if (action.rolesToRemove && action.rolesToRemove.length > 0) {
							await member.roles.remove(action.rolesToRemove).catch(() => {});
						}
						if (action.newNickname !== null) {
							const nick = action.newNickname
								? action.newNickname.slice(0, 32)
								: null;
							await member.setNickname(nick).catch(() => {});
						}
					}
				}
			}
		}

		const active = activeCronMessages.get(requestId);

		if (progress.status === "failed") {
			const errorEmbed = createErrorEmbed(
				"Scheduled Verification Sweep Failed",
				progress.message || "An error occurred during scheduled verification.",
			);
			if (active) {
				await active.message.edit({ embeds: [errorEmbed] }).catch(() => {});
				activeCronMessages.delete(requestId);
			} else {
				const config = await db.query.guildConfigs.findFirst({
					where: eq(guildConfigs.guildId, guildId),
				});
				if (config?.logChannelId) {
					const channel = await client.channels
						.fetch(config.logChannelId)
						.catch(() => null);
					if (channel instanceof TextChannel) {
						await channel.send({ embeds: [errorEmbed] }).catch(() => {});
					}
				}
			}
			return;
		}

		if (progress.status === "completed") {
			const completeEmbed = createCompleteEmbed(
				progress.processed,
				progress.total,
				progress.updated,
				progress.errors,
			);
			if (active) {
				await active.message.edit({ embeds: [completeEmbed] }).catch(() => {});
				activeCronMessages.delete(requestId);
			} else {
				const config = await db.query.guildConfigs.findFirst({
					where: eq(guildConfigs.guildId, guildId),
				});
				if (config?.logChannelId) {
					const channel = await client.channels
						.fetch(config.logChannelId)
						.catch(() => null);
					if (channel instanceof TextChannel) {
						await channel.send({ embeds: [completeEmbed] }).catch(() => {});
					}
				}
			}
			return;
		}

		// Running state
		const now = Date.now();
		if (active) {
			if (progress.processed < active.highestProcessed) {
				return;
			}
			active.highestProcessed = progress.processed;

			const THROTTLE_MS = 2000;
			if (
				now - active.lastEditTime >= THROTTLE_MS ||
				progress.processed === progress.total
			) {
				active.lastEditTime = now;
				const embed = createProgressEmbed(
					progress.processed,
					progress.total,
					progress.updated,
					progress.errors,
				);
				await active.message.edit({ embeds: [embed] }).catch(() => {});
			}
		} else {
			// First progress update: send message to log channel and store in activeCronMessages
			const config = await db.query.guildConfigs.findFirst({
				where: eq(guildConfigs.guildId, guildId),
			});
			if (!config?.logChannelId) return;

			const channel = await client.channels
				.fetch(config.logChannelId)
				.catch(() => null);
			if (channel instanceof TextChannel) {
				const embed = createProgressEmbed(
					progress.processed,
					progress.total,
					progress.updated,
					progress.errors,
				);
				const sentMessage = await channel
					.send({ embeds: [embed] })
					.catch(() => null);
				if (sentMessage) {
					activeCronMessages.set(requestId, {
						message: sentMessage,
						lastEditTime: now,
						highestProcessed: progress.processed,
					});
				}
			}
		}
	} catch (err) {
		logger.warn(
			"Error handling cron verification live progress for Discord:",
			err,
		);
	}
}
