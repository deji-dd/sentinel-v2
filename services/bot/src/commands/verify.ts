import { db, eq, guildConfigs } from "@sentinel/database";
import type { VerificationRequest } from "@sentinel/schemas";
import {
	type ChatInputCommandInteraction,
	type GuildMember,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} from "discord.js";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "../lib/embeds";
import { sendGuildAuditLog } from "../lib/guild-logger";
import { sendVerificationRequest } from "../lib/ipc";
import { logger } from "../lib/logger";

export const verifyCommand = {
	data: new SlashCommandBuilder()
		.setName("verify")
		.setDescription(
			"Verifies a Discord user against Torn profile and faction role mappings.",
		)
		.addUserOption((option) =>
			option
				.setName("user")
				.setDescription("Optional user to verify (requires admin permissions)")
				.setRequired(false),
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

		// 1. Check if Verification module is enabled for guild via Drizzle ORM
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

		const targetUserOption = interaction.options.getUser("user");
		const executorMember = interaction.member as GuildMember;
		const targetUserId = targetUserOption
			? targetUserOption.id
			: interaction.user.id;

		// 2. Permission check if verifying another user
		if (targetUserOption && targetUserOption.id !== interaction.user.id) {
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
							"You do not have permission to verify other members in this server.",
						),
					],
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
		}

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			const targetMember = await interaction.guild.members.fetch(targetUserId);

			// 3. Send IPC job request to worker engine
			const jobData: VerificationRequest = {
				guildId,
				channelId: interaction.channelId,
				discordId: targetUserId,
				currentRoleIds: Array.from(targetMember.roles.cache.keys()),
				currentNickname: targetMember.nickname,
				triggeredBy: "user",
			};

			const result = await sendVerificationRequest(jobData);

			if ("error" in result) {
				await interaction.editReply({
					embeds: [
						createErrorEmbed("Verification Failed", result.error.message),
					],
				});
				return;
			}

			// 4. Apply role additions/removals and nickname update
			const rolesAdded: string[] = [];
			const rolesRemoved: string[] = [];
			const failures: string[] = [];

			if (result.rolesToAdd && result.rolesToAdd.length > 0) {
				for (const roleId of result.rolesToAdd) {
					try {
						await targetMember.roles.add(roleId);
						rolesAdded.push(`<@&${roleId}>`);
					} catch (err) {
						failures.push(
							`Failed to add <@&${roleId}> (hierarchy or missing permission)`,
						);
						logger.warn(
							`Failed to add role ${roleId} to user ${targetUserId}:`,
							err,
						);
					}
				}
			}

			if (result.rolesToRemove && result.rolesToRemove.length > 0) {
				for (const roleId of result.rolesToRemove) {
					try {
						await targetMember.roles.remove(roleId);
						rolesRemoved.push(`<@&${roleId}>`);
					} catch (err) {
						failures.push(`Failed to remove <@&${roleId}>`);
						logger.warn(
							`Failed to remove role ${roleId} from user ${targetUserId}:`,
							err,
						);
					}
				}
			}

			let nicknameChanged = false;
			if (result.newNickname !== null) {
				try {
					await targetMember.setNickname(result.newNickname);
					nicknameChanged = true;
				} catch (err) {
					failures.push("Failed to set nickname (hierarchy or bot permission)");
					logger.warn(
						`Failed to update nickname for user ${targetUserId}:`,
						err,
					);
				}
			}

			// 5. Construct success response embed
			const embed = createBaseEmbed(
				"Verification Complete",
				`Verification updated for <@${targetUserId}>`,
				failures.length > 0 ? EMBED_COLORS.WARNING : EMBED_COLORS.SUCCESS,
			);

			if (rolesAdded.length > 0) {
				embed.addFields({ name: "Roles Added", value: rolesAdded.join(", ") });
			}
			if (rolesRemoved.length > 0) {
				embed.addFields({
					name: "Roles Removed",
					value: rolesRemoved.join(", "),
				});
			}
			if (nicknameChanged && result.newNickname !== null) {
				embed.addFields({
					name: "Nickname Updated",
					value: result.newNickname ? `\`${result.newNickname}\`` : "*Cleared*",
				});
			}
			if (failures.length > 0) {
				embed.addFields({
					name: "Failures / Warnings",
					value: failures.join("\n"),
				});
			}
			if (
				rolesAdded.length === 0 &&
				rolesRemoved.length === 0 &&
				!nicknameChanged &&
				failures.length === 0
			) {
				embed.addFields({
					name: "Status",
					value: "Roles and nickname are already up to date.",
				});
			}

			await interaction.editReply({ embeds: [embed] });

			// 6. Send audit log to guild log channel
			await sendGuildAuditLog(interaction.client, guildId, embed);
		} catch (error) {
			logger.error("Error executing verify command:", error);
			const errMsg = error instanceof Error ? error.message : String(error);
			const errorEmbed = createErrorEmbed("Verification Error", errMsg);
			await interaction.editReply({ embeds: [errorEmbed] });
			await sendGuildAuditLog(interaction.client, guildId, errorEmbed);
		}
	},
};
