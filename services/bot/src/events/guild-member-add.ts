import { db, eq, guildConfigs, isTargetGuild } from "@sentinel/database";
import { Events, type GuildMember } from "discord.js";
import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "../lib/embeds";
import { sendGuildAuditLog } from "../lib/guild-logger";
import { sendVerificationRequest } from "../lib/ipc";
import { logger } from "../lib/logger";

export const guildMemberAddEvent = {
	name: Events.GuildMemberAdd,
	async execute(member: GuildMember): Promise<void> {
		if (member.user.bot) return;

		try {
			const guildId = member.guild.id;
			if (!isTargetGuild(guildId)) return;

			const config = await db.query.guildConfigs.findFirst({
				where: eq(guildConfigs.guildId, guildId),
			});

			if (!config?.verifyOnJoin || !config?.moduleVerification) {
				return;
			}

			logger.info(
				`Auto-verifying joining member ${member.user.tag} [${member.id}] in guild ${guildId}...`,
			);

			const jobData = {
				guildId,
				channelId: "",
				discordId: member.id,
				currentRoleIds: Array.from(member.roles.cache.keys()),
				currentNickname: member.nickname,
				triggeredBy: "user" as const,
			};

			const result = await sendVerificationRequest(jobData);

			if ("error" in result) {
				logger.warn(
					`Auto-verify failed for joining member ${member.id}:`,
					result.error.message,
				);
				const errorEmbed = createErrorEmbed(
					"Auto-Verification Failed",
					`Auto-verification on join failed for <@${member.id}>: ${result.error.message}`,
				);
				await sendGuildAuditLog(member.client, guildId, errorEmbed);
				return;
			}

			const rolesAdded: string[] = [];
			const rolesRemoved: string[] = [];
			const failures: string[] = [];

			if (result.rolesToAdd && result.rolesToAdd.length > 0) {
				for (const roleId of result.rolesToAdd) {
					try {
						await member.roles.add(roleId);
						rolesAdded.push(`<@&${roleId}>`);
					} catch (_err) {
						failures.push(`Failed to add <@&${roleId}>`);
					}
				}
			}

			if (result.rolesToRemove && result.rolesToRemove.length > 0) {
				for (const roleId of result.rolesToRemove) {
					try {
						await member.roles.remove(roleId);
						rolesRemoved.push(`<@&${roleId}>`);
					} catch (_err) {
						failures.push(`Failed to remove <@&${roleId}>`);
					}
				}
			}

			let nicknameChanged = false;
			if (result.newNickname !== null) {
				try {
					const nick = result.newNickname
						? result.newNickname.slice(0, 32)
						: null;
					await member.setNickname(nick);
					nicknameChanged = true;
				} catch (_err) {
					failures.push("Failed to update nickname");
				}
			}

			const auditEmbed = createBaseEmbed(
				"Auto-Verification (Join)",
				`Auto-verification processed for new member <@${member.id}>`,
				failures.length > 0 ? EMBED_COLORS.WARNING : EMBED_COLORS.SUCCESS,
			);

			if (rolesAdded.length > 0) {
				auditEmbed.addFields({
					name: "Roles Added",
					value: rolesAdded.join(", "),
				});
			}
			if (rolesRemoved.length > 0) {
				auditEmbed.addFields({
					name: "Roles Removed",
					value: rolesRemoved.join(", "),
				});
			}
			if (nicknameChanged && result.newNickname !== null) {
				auditEmbed.addFields({
					name: "Nickname Updated",
					value: result.newNickname ? `\`${result.newNickname}\`` : "*Cleared*",
				});
			}
			if (failures.length > 0) {
				auditEmbed.addFields({
					name: "Failures / Warnings",
					value: failures.join("\n"),
				});
			}

			await sendGuildAuditLog(member.client, guildId, auditEmbed);
		} catch (error) {
			logger.error(
				`Error in guildMemberAdd auto-verification for member ${member.id}:`,
				error,
			);
		}
	},
};
