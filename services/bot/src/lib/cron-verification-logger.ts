import { db, eq, guildConfigs } from "@sentinel/database";
import type { BulkVerificationProgressData } from "@sentinel/schemas";
import {
	type Client,
	type EmbedBuilder,
	type Message,
	TextChannel,
} from "discord.js";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

interface ActiveCronMessage {
	message?: Message;
	isSending?: boolean;
	completed?: boolean;
	pendingEmbed?: EmbedBuilder;
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
						// Only hit Discord API for roles the member does not already possess
						const actualRolesToAdd =
							action.rolesToAdd?.filter(
								(roleId) => !member.roles.cache.has(roleId),
							) ?? [];
						if (actualRolesToAdd.length > 0) {
							await member.roles.add(actualRolesToAdd).catch(() => {});
						}

						// Only hit Discord API for roles the member actually possesses
						const actualRolesToRemove =
							action.rolesToRemove?.filter((roleId) =>
								member.roles.cache.has(roleId),
							) ?? [];
						if (actualRolesToRemove.length > 0) {
							await member.roles.remove(actualRolesToRemove).catch(() => {});
						}

						// Only update nickname if it actually changed
						if (action.newNickname !== null) {
							const nick = action.newNickname
								? action.newNickname.slice(0, 32)
								: null;
							if (member.nickname !== nick) {
								await member.setNickname(nick).catch(() => {});
							}
						}
					}
				}
			}
		}

		const active = activeCronMessages.get(requestId);

		if (progress.status === "failed") {
			if (active?.completed) return;
			const errorEmbed = createErrorEmbed(
				"Scheduled Verification Sweep Failed",
				progress.message || "An error occurred during scheduled verification.",
			);
			if (active) {
				active.completed = true;
				if (active.message) {
					await active.message.edit({ embeds: [errorEmbed] }).catch(() => {});
				} else if (active.isSending) {
					active.pendingEmbed = errorEmbed;
				}
			} else {
				activeCronMessages.set(requestId, {
					lastEditTime: Date.now(),
					highestProcessed: progress.processed,
					completed: true,
				});
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
			setTimeout(() => activeCronMessages.delete(requestId), 5 * 60 * 1000);
			return;
		}

		if (progress.status === "completed") {
			if (active?.completed) return;
			const completeEmbed = createCompleteEmbed(
				progress.processed,
				progress.total,
				progress.updated,
				progress.errors,
			);
			if (active) {
				active.completed = true;
				if (active.message) {
					await active.message
						.edit({ embeds: [completeEmbed] })
						.catch(() => {});
				} else if (active.isSending) {
					active.pendingEmbed = completeEmbed;
				}
			} else {
				activeCronMessages.set(requestId, {
					lastEditTime: Date.now(),
					highestProcessed: progress.processed,
					completed: true,
				});
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
			setTimeout(() => activeCronMessages.delete(requestId), 5 * 60 * 1000);
			return;
		}

		// Running state — discard late progress chunks if sweep already completed
		if (active?.completed) {
			return;
		}

		const now = Date.now();
		if (active) {
			if (progress.processed < active.highestProcessed) {
				return;
			}
			active.highestProcessed = progress.processed;

			const THROTTLE_MS = 2000;
			if (
				active.message &&
				(now - active.lastEditTime >= THROTTLE_MS ||
					progress.processed === progress.total)
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
			// First progress update: reserve requestId immediately to prevent duplicate sends
			activeCronMessages.set(requestId, {
				lastEditTime: now,
				highestProcessed: progress.processed,
				isSending: true,
				completed: false,
			});

			const config = await db.query.guildConfigs.findFirst({
				where: eq(guildConfigs.guildId, guildId),
			});
			if (!config?.logChannelId) {
				activeCronMessages.delete(requestId);
				return;
			}

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

				const entry = activeCronMessages.get(requestId);
				if (entry) {
					entry.isSending = false;
					entry.message = sentMessage ?? undefined;
					if (entry.pendingEmbed && entry.message) {
						await entry.message
							.edit({ embeds: [entry.pendingEmbed] })
							.catch(() => {});
						entry.pendingEmbed = undefined;
					}
				}
			} else {
				activeCronMessages.delete(requestId);
			}
		}
	} catch (err) {
		logger.warn(
			"Error handling cron verification live progress for Discord:",
			err,
		);
	}
}
