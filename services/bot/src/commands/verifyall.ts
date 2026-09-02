import { db, eq, guildConfigs } from "@sentinel/database";
import type { BulkVerificationProgressData } from "@sentinel/schemas";
import {
	type ChatInputCommandInteraction,
	type GuildMember,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} from "discord.js";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "../lib/embeds";
import { sendGuildAuditLog } from "../lib/guild-logger";
import { streamBulkVerificationRequest } from "../lib/ipc";
import { logger } from "../lib/logger";

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
		"Bulk Verification In Progress",
		`Running verification check for all members...\n\n\`${progressBar}\``,
		EMBED_COLORS.PRIMARY,
	).addFields(
		{ name: "Progress", value: `${processed} / ${total}`, inline: true },
		{ name: "Members Updated", value: `${updated}`, inline: true },
		{ name: "Errors / Skipped", value: `${errors}`, inline: true },
	);
}

const activeGuildBulkVerifications = new Set<string>();

export const verifyallCommand = {
	module: "verification" as const,
	data: new SlashCommandBuilder()
		.setName("verifyall")
		.setDescription(
			"Runs bulk verification check on all members in the server (Admin only).",
		),

	async execute(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!interaction.guild || !interaction.guildId) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Error",
						"This command can only be used in a server.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const guildId = interaction.guildId;

		// 1. Concurrency Guard: Check if a bulk verification run is already active for this guild
		if (activeGuildBulkVerifications.has(guildId)) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Verification In Progress",
						"A bulk verification check is already currently running for this server. Please wait for it to complete.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 2. Fetch guild configuration once via Drizzle ORM
		const config = await db.query.guildConfigs.findFirst({
			where: eq(guildConfigs.guildId, guildId),
		});

		// 3. Permission Check
		const executorMember = interaction.member as GuildMember;
		const hasAdminRole = executorMember.roles.cache.some((role) =>
			(config?.adminRoleIds ?? []).includes(role.id),
		);
		const hasPermission =
			executorMember.permissions.has(PermissionFlagsBits.Administrator) ||
			executorMember.permissions.has(PermissionFlagsBits.ManageGuild);

		if (!hasAdminRole && !hasPermission) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Permission Denied",
						"You do not have administrator permissions to run bulk verification.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// Mark guild as actively running bulk verification
		activeGuildBulkVerifications.add(guildId);

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			// 4. Fetch all members in the Discord guild (excluding bot accounts)
			const guildMembers = await interaction.guild.members.fetch();
			const humanMembers = guildMembers.filter((m) => !m.user.bot);

			// Send initiation audit log to guild log channel if configured
			const startLogEmbed = createBaseEmbed(
				"Bulk Verification Started",
				`Bulk verification run initiated by <@${interaction.user.id}> for **${humanMembers.size}** members.`,
				EMBED_COLORS.PRIMARY,
			);

			await sendGuildAuditLog(interaction.client, guildId, startLogEmbed);

			const membersInput = humanMembers.map((member) => ({
				discordId: member.id,
				currentRoleIds: Array.from(member.roles.cache.keys()),
				currentNickname: member.nickname,
			}));

			const applyMemberActions = async (
				actions?: BulkVerificationProgressData["actions"],
			) => {
				if (!actions || actions.length === 0) return;
				for (const action of actions) {
					const member = guildMembers.get(action.discordId);
					if (!member) continue;

					if (action.rolesToAdd && action.rolesToAdd.length > 0) {
						try {
							await member.roles.add(action.rolesToAdd);
						} catch (err) {
							logger.warn(`Failed to add roles to member ${member.id}:`, err);
						}
					}

					if (action.rolesToRemove && action.rolesToRemove.length > 0) {
						try {
							await member.roles.remove(action.rolesToRemove);
						} catch (err) {
							logger.warn(
								`Failed to remove roles from member ${member.id}:`,
								err,
							);
						}
					}

					if (action.newNickname !== null) {
						try {
							const nick = action.newNickname
								? action.newNickname.slice(0, 32)
								: null;
							await member.setNickname(nick);
						} catch (err) {
							logger.warn(
								`Failed to update nickname for member ${member.id}:`,
								err,
							);
						}
					}
				}
			};

			let lastDiscordUpdate = 0;
			let isFinished = false;
			let highestProcessed = 0;
			let editQueue = Promise.resolve();
			const THROTTLE_MS = 2000;

			const onProgress = async (progress: BulkVerificationProgressData) => {
				// Apply real-time Discord role additions/removals and nickname changes
				if (progress.actions && progress.actions.length > 0) {
					await applyMemberActions(progress.actions);
				}

				// Only render progress embeds for active running chunks before completion
				if (isFinished || progress.status !== "running") {
					return;
				}

				// Monotonic progression: Never let progress bar regress to a lower count
				if (progress.processed < highestProcessed) {
					return;
				}
				highestProcessed = progress.processed;

				const now = Date.now();
				if (
					now - lastDiscordUpdate < THROTTLE_MS &&
					progress.processed < progress.total
				) {
					return;
				}
				lastDiscordUpdate = now;

				const progressEmbed = createProgressEmbed(
					progress.processed,
					progress.total,
					progress.updated,
					progress.errors,
				);

				// Serialize editReply calls in order to prevent network race conditions
				editQueue = editQueue.then(async () => {
					if (isFinished) return;
					try {
						await interaction.editReply({ embeds: [progressEmbed] });
					} catch (err) {
						logger.warn("Failed to update verifyall live progress:", err);
					}
				});
			};

			// Send streaming bulk verification IPC request to worker engine with full guild members list.
			// Worker engine streams real-time progress chunks and resets sliding heartbeat inactivity timer.
			const result = await streamBulkVerificationRequest(
				{
					guildId,
					channelId: interaction.channelId,
					triggeredBy: "admin",
					members: membersInput,
				},
				onProgress,
				60000,
			);

			// Mark as finished to discard any trailing progress callbacks
			isFinished = true;
			// Await all queued progress edits before rendering the final completion embed
			await editQueue;

			const embed = createBaseEmbed(
				"Bulk Verification Complete",
				"Bulk verification check completed successfully for all members.",
				EMBED_COLORS.SUCCESS,
			).addFields(
				{
					name: "Total Processed",
					value: `${result.processed} / ${result.total}`,
					inline: true,
				},
				{ name: "Members Updated", value: `${result.updated}`, inline: true },
				{ name: "Errors / Skipped", value: `${result.errors}`, inline: true },
				{
					name: "Triggered By",
					value: `<@${interaction.user.id}>`,
					inline: true,
				},
			);

			await interaction.editReply({ embeds: [embed] });
			await sendGuildAuditLog(interaction.client, guildId, embed);
		} catch (error) {
			logger.error("Error executing verifyall command:", error);
			const errMsg = error instanceof Error ? error.message : String(error);
			const errorEmbed = createErrorEmbed("Bulk Verification Error", errMsg);
			await interaction.editReply({ embeds: [errorEmbed] });
			await sendGuildAuditLog(interaction.client, guildId, errorEmbed);
		} finally {
			activeGuildBulkVerifications.delete(guildId);
		}
	},
};
