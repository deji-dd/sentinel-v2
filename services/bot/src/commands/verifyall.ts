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
	guildId: string,
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
		`Running verification check for guild **${guildId}**...\n\n\`${progressBar}\``,
		EMBED_COLORS.PRIMARY,
	).addFields(
		{ name: "Progress", value: `${processed} / ${total}`, inline: true },
		{ name: "Members Updated", value: `${updated}`, inline: true },
		{ name: "Errors / Skipped", value: `${errors}`, inline: true },
	);
}

export const verifyallCommand = {
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

		// 1. Fetch guild configuration once via Drizzle ORM
		const config = await db.query.guildConfigs.findFirst({
			where: eq(guildConfigs.guildId, guildId),
		});

		if (!config?.enabledModules.includes("verification")) {
			await interaction.reply({
				embeds: [
					createErrorEmbed(
						"Module Disabled",
						"The Verification module is currently disabled for this server.",
					),
				],
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		// 2. Permission Check
		const executorMember = interaction.member as GuildMember;
		const hasAdminRole = executorMember.roles.cache.some((role) =>
			config.adminRoleIds.includes(role.id),
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

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			let lastDiscordUpdate = 0;
			const THROTTLE_MS = 2000;

			const onProgress = async (progress: BulkVerificationProgressData) => {
				const now = Date.now();
				if (
					progress.status === "running" &&
					now - lastDiscordUpdate < THROTTLE_MS
				) {
					return;
				}
				lastDiscordUpdate = now;

				try {
					const progressEmbed = createProgressEmbed(
						guildId,
						progress.processed,
						progress.total,
						progress.updated,
						progress.errors,
					);
					await interaction.editReply({ embeds: [progressEmbed] });
				} catch (err) {
					logger.warn("Failed to update verifyall live progress:", err);
				}
			};

			// Send streaming bulk verification IPC request to worker engine.
			// Worker engine streams real-time progress chunks and resets sliding heartbeat inactivity timer.
			const result = await streamBulkVerificationRequest(
				{
					guildId,
					channelId: interaction.channelId,
					triggeredBy: "admin",
				},
				onProgress,
				60000,
			);

			const embed = createBaseEmbed(
				"Bulk Verification Complete",
				`Bulk verification run completed for guild **${guildId}**.`,
				EMBED_COLORS.SUCCESS,
			).addFields(
				{
					name: "Total Processed",
					value: `${result.processed} / ${result.total}`,
					inline: true,
				},
				{ name: "Members Updated", value: `${result.updated}`, inline: true },
				{ name: "Errors / Skipped", value: `${result.errors}`, inline: true },
			);

			await interaction.editReply({ embeds: [embed] });
			await sendGuildAuditLog(interaction.client, guildId, embed);
		} catch (error) {
			logger.error("Error executing verifyall command:", error);
			const errMsg = error instanceof Error ? error.message : String(error);
			const errorEmbed = createErrorEmbed("Bulk Verification Error", errMsg);
			await interaction.editReply({ embeds: [errorEmbed] });
			await sendGuildAuditLog(interaction.client, guildId, errorEmbed);
		}
	},
};
