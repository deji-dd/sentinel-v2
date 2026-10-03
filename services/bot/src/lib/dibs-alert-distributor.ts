import type { DibsRecord } from "@sentinel/schemas";
import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type Client,
	ComponentType,
	type Message,
	MessageFlags,
	type TextChannel,
} from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

const API_BASE_URL =
	process.env.API_URL ||
	(process.env.API_PORT
		? `http://127.0.0.1:${process.env.API_PORT}`
		: "http://127.0.0.1:3002");

function formatStats(num: number | null | undefined): string {
	if (!num || !Number.isFinite(num)) return "Unknown";
	if (num >= 1e15) return `${(num / 1e15).toFixed(2)}Q`;
	if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
	if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
	if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
	if (num >= 1e3) return `${(num / 1e3).toFixed(1)}k`;
	return Math.round(num).toLocaleString();
}

/**
 * Builds the ActionRow containing interactive buttons for a Dibs embed (strictly zero emojis).
 */
function buildDibsActionRow(
	targetId: number,
	status: "open" | "claimed",
): ActionRowBuilder<ButtonBuilder> {
	const row = new ActionRowBuilder<ButtonBuilder>();

	if (status === "open") {
		row.addComponents(
			new ButtonBuilder()
				.setCustomId(`dibs_claim:${targetId}`)
				.setLabel("Claim Dibs")
				.setStyle(ButtonStyle.Primary),
		);
	} else {
		row.addComponents(
			new ButtonBuilder()
				.setCustomId(`dibs_release:${targetId}`)
				.setLabel("Release Dibs")
				.setStyle(ButtonStyle.Secondary),
		);
	}

	row.addComponents(
		new ButtonBuilder()
			.setStyle(ButtonStyle.Link)
			.setLabel("Profile")
			.setURL(`https://www.torn.com/profiles.php?XID=${targetId}`),
		new ButtonBuilder()
			.setStyle(ButtonStyle.Link)
			.setLabel("Attack")
			.setURL(`https://www.torn.com/page.php?sid=attack&user2ID=${targetId}`),
	);

	return row;
}

/**
 * Posts a new Dibs callout embed to the specified Discord channel when target enters lead time.
 */
export async function postDibsAlert(
	client: Client,
	channelId: string,
	dibs: DibsRecord,
): Promise<void> {
	try {
		const channel = (await client.channels
			.fetch(channelId)
			.catch(() => null)) as TextChannel | null;
		if (!channel || !("send" in channel)) {
			logger.warn(`Dibs channel not found or not sendable: ${channelId}`);
			return;
		}

		const targetProfileUrl = `https://www.torn.com/profiles.php?XID=${dibs.targetId}`;
		const embed = createBaseEmbed(
			`${dibs.targetName} [${dibs.targetId}]`,
			`Target: [${dibs.targetName} [${dibs.targetId}]](${targetProfileUrl})\nLevel ${dibs.targetLevel} | Estimated BS: ${formatStats(dibs.estimatedBs)}`,
			EMBED_COLORS.PRIMARY,
		);

		embed.addFields(
			{
				name: "Hospital Exit",
				value: `<t:${dibs.hospitalUntil}:R> (<t:${dibs.hospitalUntil}:T>)`,
				inline: true,
			},
			{
				name: "Status",
				value: "Available for Claim",
				inline: true,
			},
		);

		const row = buildDibsActionRow(dibs.targetId, "open");
		const msg = await channel.send({ embeds: [embed], components: [row] });

		// Notify API of messageId so future edits/deletes know the exact Discord message
		await fetch(`${API_BASE_URL}/v2/subversive/dibs/record-message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				targetId: dibs.targetId,
				channelId,
				messageId: msg.id,
			}),
		}).catch((err) => {
			logger.warn("Failed recording dibs message ID with Sentinel API:", err);
		});
	} catch (err) {
		logger.error("Failed to post dibs alert to Discord:", err);
	}
}

/**
 * Updates an existing Dibs alert message when claimed, released, or lock expired.
 */
export async function updateDibsAlert(
	client: Client,
	channelId: string,
	messageId: string,
	dibs: DibsRecord,
	status: "open" | "claimed",
): Promise<void> {
	try {
		const channel = (await client.channels
			.fetch(channelId)
			.catch(() => null)) as TextChannel | null;
		if (!channel || !("messages" in channel)) return;

		const message = await channel.messages.fetch(messageId).catch(() => null);
		if (!message) return;

		const isClaimed = status === "claimed";
		const claimantDisplay =
			dibs.claimedBy?.tornId && dibs.claimedBy?.tornName
				? `[${dibs.claimedBy.tornName} [${dibs.claimedBy.tornId}]](https://www.torn.com/profiles.php?XID=${dibs.claimedBy.tornId})`
				: (dibs.claimedBy?.tornName ??
					dibs.claimedBy?.discordTag ??
					"Teammate");

		const statusText = isClaimed
			? `Claimed by ${claimantDisplay} (<t:${Math.floor((dibs.claimedAt || Date.now()) / 1000)}:R>)`
			: "Available for Claim (Lock released)";

		const targetProfileUrl = `https://www.torn.com/profiles.php?XID=${dibs.targetId}`;
		const embed = createBaseEmbed(
			`${dibs.targetName} [${dibs.targetId}]`,
			`Target: [${dibs.targetName} [${dibs.targetId}]](${targetProfileUrl})\nLevel ${dibs.targetLevel} | Estimated BS: ${formatStats(dibs.estimatedBs)}`,
			isClaimed ? EMBED_COLORS.WARNING : EMBED_COLORS.PRIMARY,
		);

		embed.addFields(
			{
				name: "Hospital Exit",
				value: `<t:${dibs.hospitalUntil}:R> (<t:${dibs.hospitalUntil}:T>)`,
				inline: true,
			},
			{
				name: "Status",
				value: statusText,
				inline: true,
			},
		);

		const row = buildDibsActionRow(dibs.targetId, status);
		await message.edit({ embeds: [embed], components: [row] });
	} catch (err) {
		logger.warn("Failed to update dibs alert in Discord:", err);
	}
}

/**
 * Deletes a Dibs message when the target has been downed in hospital.
 */
export async function deleteDibsAlert(
	client: Client,
	channelId: string,
	messageId: string,
): Promise<void> {
	try {
		const channel = (await client.channels
			.fetch(channelId)
			.catch(() => null)) as TextChannel | null;
		if (!channel || !("messages" in channel)) return;

		const message = await channel.messages.fetch(messageId).catch(() => null);
		if (message) {
			await message.delete().catch(() => {});
		}
	} catch (err) {
		logger.warn("Failed deleting downed target dibs alert:", err);
	}
}

/**
 * Identifies whether a message is one of our dibs callouts.
 *
 * The claim/release button customIds are the discriminator: only this bot posts
 * `dibs_claim:` / `dibs_release:` components, and it authorises deletion on that
 * basis alone. We never delete anything we cannot prove we created.
 */
function isDibsCalloutMessage(message: Message): boolean {
	return message.components.some((row) => {
		// TopLevelComponent may be a FileComponent, which has no sub-components.
		if (row.type !== ComponentType.ActionRow) return false;

		return row.components.some((component) => {
			const data = component.toJSON() as { custom_id?: string };
			const customId = data.custom_id;
			return (
				typeof customId === "string" &&
				(customId.startsWith("dibs_claim:") ||
					customId.startsWith("dibs_release:"))
			);
		});
	});
}

export interface DibsSweepResult {
	deleted: number;
	skippedNotOurs: number;
	deletedTooOld: number;
	deletedOrphaned: number;
}

/**
 * Reconciles a dibs channel by deleting our own dibs messages that are either
 * past the configured max age or no longer present in the API's live set.
 *
 * This is the safety net for orphans the normal lifecycle cannot clean:
 * wars that were termed, API restarts that lost in-memory state, and IPC
 * deliveries that failed. Messages are only ever deleted when this bot authored
 * them, so unrelated channel content is never touched.
 */
export async function sweepDibsChannel(
	client: Client,
	channelId: string,
	options: {
		liveMessageIds: string[];
		trackedMessageIds: string[];
		maxAgeHours: number;
		scanLimit?: number;
	},
): Promise<DibsSweepResult> {
	const result: DibsSweepResult = {
		deleted: 0,
		skippedNotOurs: 0,
		deletedTooOld: 0,
		deletedOrphaned: 0,
	};

	try {
		const channel = (await client.channels
			.fetch(channelId)
			.catch(() => null)) as TextChannel | null;
		if (!channel || !("messages" in channel)) return result;

		const live = new Set(options.liveMessageIds);
		const tracked = new Set(options.trackedMessageIds);
		const scanLimit = options.scanLimit ?? 100;

		// Only look back as far as the configured max age plus a margin, so a long
		// channel does not turn every sweep into a full-history scan.
		const maxAgeMs = Math.max(1, options.maxAgeHours) * 60 * 60 * 1000;
		const oldestRelevant = Date.now() - maxAgeMs * 2;

		const messages = await channel.messages
			.fetch({ limit: scanLimit })
			.catch(() => null);
		if (!messages) return result;

		const toDelete: Message[] = [];

		for (const message of messages.values()) {
			// Never delete a live dibs, regardless of age.
			if (live.has(message.id)) continue;

			// Author gate: only delete messages this bot posted.
			if (
				message.author?.bot !== true ||
				message.author.id !== client.user?.id ||
				!isDibsCalloutMessage(message)
			) {
				if (tracked.has(message.id)) result.skippedNotOurs++;
				continue;
			}

			if (message.createdTimestamp < oldestRelevant) continue;

			const tooOld = Date.now() - message.createdTimestamp >= maxAgeMs * 1000;

			// Orphan = ours, not live, and still tracked (so the API knows about it
			// but no longer considers it active). Older ones are removed purely on age.
			const orphaned = tracked.has(message.id);

			if (tooOld || orphaned) {
				toDelete.push(message);
				if (tooOld) result.deletedTooOld++;
				if (orphaned) result.deletedOrphaned++;
			}
		}

		if (toDelete.length > 0) {
			// bulkDelete only accepts messages younger than 14 days.
			const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
			const bulkDeleteable = toDelete.filter(
				(m) => m.createdTimestamp > cutoff,
			);

			if (bulkDeleteable.length > 0) {
				await channel.bulkDelete(bulkDeleteable, true).catch(() => {});
				result.deleted += bulkDeleteable.length;
			}

			for (const message of toDelete) {
				if (message.createdTimestamp <= cutoff) {
					await message.delete().catch(() => {});
					result.deleted++;
				}
			}
		}

		logger.info(
			`Dibs sweep ${channelId}: removed ${result.deleted} message(s) ` +
				`(${result.deletedOrphaned} orphaned, ${result.deletedTooOld} expired).`,
		);
	} catch (err) {
		logger.warn("Failed sweeping dibs channel:", err);
	}

	return result;
}

/**
 * Handles a Discord button interaction for claiming dibs.
 */
export async function handleDibsClaimButton(
	interaction: ButtonInteraction,
): Promise<void> {
	const targetIdStr = interaction.customId.split(":")[1];
	const targetId = Number.parseInt(targetIdStr ?? "", 10);
	if (!targetId || Number.isNaN(targetId)) return;

	try {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const res = await fetch(
			`${API_BASE_URL}/v2/subversive/dibs/claim-discord`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					targetId,
					discordUserId: interaction.user.id,
					discordUsername: interaction.user.tag || interaction.user.username,
				}),
			},
		);

		let json: {
			success?: boolean;
			error?: string;
			dibs?: DibsRecord;
			postHospTimeoutSeconds?: number;
		} = {};

		try {
			json = (await res.json()) as typeof json;
		} catch {
			json = { error: `Server response error (${res.status})` };
		}

		if (json.success && json.dibs) {
			const claimant =
				json.dibs.claimedBy?.tornName && json.dibs.claimedBy?.tornId
					? `${json.dibs.claimedBy.tornName} [${json.dibs.claimedBy.tornId}]`
					: "You";

			const timeout = json.postHospTimeoutSeconds ?? 20;
			await interaction.editReply({
				content: `Dibs confirmed for ${json.dibs.targetName} [${json.dibs.targetId}] by ${claimant}. You have ${timeout} seconds after hospital exit to initiate attack.`,
			});
		} else {
			await interaction.editReply({
				content: json.error || "Unable to claim dibs.",
			});
		}
	} catch (err) {
		logger.error("Error claiming dibs via Discord button:", err);
		if (interaction.deferred || interaction.replied) {
			await interaction
				.editReply({
					content: "Internal error processing claim. Please try again.",
				})
				.catch(() => {});
		} else {
			await interaction
				.reply({
					content: "Internal error processing claim. Please try again.",
					flags: MessageFlags.Ephemeral,
				})
				.catch(() => {});
		}
	}
}

/**
 * Handles a Discord button interaction for releasing dibs.
 */
export async function handleDibsReleaseButton(
	interaction: ButtonInteraction,
): Promise<void> {
	const targetIdStr = interaction.customId.split(":")[1];
	const targetId = Number.parseInt(targetIdStr ?? "", 10);
	if (!targetId || Number.isNaN(targetId)) return;

	try {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const res = await fetch(
			`${API_BASE_URL}/v2/subversive/dibs/release-discord`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					targetId,
					discordUserId: interaction.user.id,
				}),
			},
		);

		let json: {
			success?: boolean;
			error?: string;
		} = {};

		try {
			json = (await res.json()) as typeof json;
		} catch {
			json = { error: `Server response error (${res.status})` };
		}

		if (json.success) {
			await interaction.editReply({
				content: "Dibs claim released.",
			});
		} else {
			await interaction.editReply({
				content: json.error || "Unable to release dibs.",
			});
		}
	} catch (err) {
		logger.error("Error releasing dibs via Discord button:", err);
		if (interaction.deferred || interaction.replied) {
			await interaction
				.editReply({
					content: "Internal error releasing claim. Please try again.",
				})
				.catch(() => {});
		} else {
			await interaction
				.reply({
					content: "Internal error releasing claim. Please try again.",
					flags: MessageFlags.Ephemeral,
				})
				.catch(() => {});
		}
	}
}
