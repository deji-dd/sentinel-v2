import {
	db,
	eq,
	guildConfigs,
	reactionRoleMappings,
	reactionRoleMessages,
} from "@sentinel/database";
import { isModuleEnabled, Logger } from "@sentinel/utils";
import type {
	Client,
	Guild,
	MessageReaction,
	PartialMessageReaction,
	PartialUser,
	TextChannel,
	User,
} from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { sendGuildAuditLog } from "./guild-logger";

const logger = new Logger("ReactionRoles");

const REACTION_EVENT_LOCK_MS = 4000;
const reactionProcessingLock = new Map<string, number>();

function normalizeEmojiForKey(emoji: string): string {
	return emoji.normalize("NFKC").replace(/\uFE0F/g, "");
}

function getReactionKey(
	messageId: string,
	userId: string,
	emoji: string,
): string {
	return `${messageId}:${userId}:${normalizeEmojiForKey(emoji)}`;
}

function beginReactionProcessing(key: string): boolean {
	const now = Date.now();
	const existing = reactionProcessingLock.get(key);

	if (existing && now - existing < REACTION_EVENT_LOCK_MS) {
		return false;
	}

	reactionProcessingLock.set(key, now);

	setTimeout(() => {
		const current = reactionProcessingLock.get(key);
		if (current === now) {
			reactionProcessingLock.delete(key);
		}
	}, REACTION_EVENT_LOCK_MS * 2);

	return true;
}

function isEmojiMatch(
	mappingEmoji: string,
	reactionEmoji: MessageReaction["emoji"],
): boolean {
	if (!mappingEmoji) return false;
	const mapStr = mappingEmoji.trim();
	const reactStr = reactionEmoji.toString();
	const reactName = reactionEmoji.name || "";
	const reactId = reactionEmoji.id || "";

	if (mapStr === reactStr) return true;
	if (reactName && mapStr === reactName) return true;
	if (reactId && (mapStr === reactId || mapStr.includes(reactId))) return true;
	if (normalizeEmojiForKey(mapStr) === normalizeEmojiForKey(reactStr))
		return true;

	return false;
}

/**
 * Sends feedback to the user regarding reaction role changes.
 * Attempts DM with human-readable role/guild names first; falls back to an auto-deleting channel message if DMs are disabled.
 */
async function sendReactionFeedback(
	user: User | PartialUser,
	channel: TextChannel,
	_guild: Guild,
	type: "added" | "removed" | "denied" | "invalid",
	title: string,
	description: string,
): Promise<void> {
	try {
		const targetUser = user.partial
			? await user.fetch().catch(() => null)
			: user;
		if (!targetUser) return;

		const color =
			type === "added"
				? EMBED_COLORS.SUCCESS
				: type === "removed"
					? EMBED_COLORS.WARNING
					: EMBED_COLORS.DANGER;

		const embed = createBaseEmbed(title, description, color);

		let dmSent = false;
		try {
			await targetUser.send({ embeds: [embed] });
			dmSent = true;
		} catch (_err) {
			dmSent = false;
		}

		if (!dmSent && channel) {
			const channelEmbed = createBaseEmbed(
				title,
				`<@${targetUser.id}> ${description}`,
				color,
			);
			const tempMsg = await channel
				.send({ embeds: [channelEmbed] })
				.catch(() => null);
			if (tempMsg) {
				setTimeout(() => {
					tempMsg.delete().catch(() => {});
				}, 5000);
			}
		}
	} catch (err) {
		logger.warn("Failed to send reaction feedback message:", err);
	}
}

/**
 * Handles incoming emoji reactions for role assignment / unassignment.
 */
export async function handleReactionRoleAdd(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
): Promise<void> {
	try {
		if (user.bot) return;

		const fullReaction = reaction.partial
			? await reaction.fetch().catch(() => null)
			: reaction;
		if (!fullReaction) return;

		if (fullReaction.message.partial) {
			await fullReaction.message.fetch().catch(() => null);
		}

		const guildId = fullReaction.message.guildId;
		if (!guildId) return;

		const messageId = fullReaction.message.id;
		const emoji = fullReaction.emoji.toString();
		const reactionKey = getReactionKey(messageId, user.id, emoji);

		// Fetch GuildConfig via Drizzle ORM
		const config = await db.query.guildConfigs.findFirst({
			where: eq(guildConfigs.guildId, guildId),
		});

		const enabled = isModuleEnabled(config?.enabledModules, "reaction_role");
		if (!enabled) return;

		if (!beginReactionProcessing(reactionKey)) return;

		const channel = fullReaction.message.channel as TextChannel;

		// Fetch matching ReactionRoleMessage record & mappings from Drizzle DB
		const rrMsg = await db.query.reactionRoleMessages.findFirst({
			where: eq(reactionRoleMessages.messageId, messageId),
		});

		if (!rrMsg) return;

		const mappings = await db.query.reactionRoleMappings.findMany({
			where: eq(reactionRoleMappings.messageId, rrMsg.id),
		});

		// Check optional required role constraint
		const member = await fullReaction.message.guild?.members.fetch(user.id);
		if (!member) return;

		if (rrMsg.requiredRoleId) {
			const requiredRoleIds = rrMsg.requiredRoleId.split(",");
			const hasRequired = requiredRoleIds.some((id) =>
				member.roles.cache.has(id.trim()),
			);

			if (!hasRequired) {
				await fullReaction.users.remove(user.id).catch(() => {});
				const reqRoleNames = requiredRoleIds
					.map((rid) => {
						const r = member.guild.roles.cache.get(rid.trim());
						return r ? `@${r.name}` : `Role ${rid.trim()}`;
					})
					.join(", ");

				await sendReactionFeedback(
					user,
					channel,
					member.guild,
					"denied",
					"Reaction Role Access Denied",
					`You must have at least one of the required roles in **${member.guild.name}** to react: ${reqRoleNames}`,
				);

				// Audit Log
				const auditEmbed = createBaseEmbed(
					"Reaction Role Denied",
					`<@${user.id}> attempted to react on **${rrMsg.title}** without required role.`,
					EMBED_COLORS.DANGER,
				);
				await sendGuildAuditLog(
					clientFromChannel(channel),
					guildId,
					auditEmbed,
				);
				return;
			}
		}

		// Find emoji mapping
		const mapping = mappings.find((m) =>
			isEmojiMatch(m.emoji, fullReaction.emoji),
		);

		if (!mapping) {
			await fullReaction.users.remove(user.id).catch(() => {});
			return;
		}

		// Toggle Role
		const roleId = mapping.roleId;
		const hasRole = member.roles.cache.has(roleId);
		const targetRole = member.guild.roles.cache.get(roleId);
		const roleDisplayName = targetRole ? `@${targetRole.name}` : "role";

		if (hasRole) {
			await member.roles.remove(roleId, `Reaction Role: ${emoji}`);
			await fullReaction.users.remove(user.id).catch(() => {});

			await sendReactionFeedback(
				user,
				channel,
				member.guild,
				"removed",
				"Reaction Role Removed",
				`Removed **${roleDisplayName}** in **${member.guild.name}**.`,
			);

			const auditEmbed = createBaseEmbed(
				"Reaction Role Removed",
				`Removed <@&${roleId}> from <@${user.id}> via **${rrMsg.title}**.`,
				EMBED_COLORS.WARNING,
			);
			await sendGuildAuditLog(clientFromChannel(channel), guildId, auditEmbed);
		} else {
			await member.roles.add(roleId, `Reaction Role: ${emoji}`);
			await fullReaction.users.remove(user.id).catch(() => {});

			await sendReactionFeedback(
				user,
				channel,
				member.guild,
				"added",
				"Reaction Role Assigned",
				`Assigned **${roleDisplayName}** in **${member.guild.name}**.`,
			);

			const auditEmbed = createBaseEmbed(
				"Reaction Role Assigned",
				`Assigned <@&${roleId}> to <@${user.id}> via **${rrMsg.title}**.`,
				EMBED_COLORS.SUCCESS,
			);
			await sendGuildAuditLog(clientFromChannel(channel), guildId, auditEmbed);
		}
	} catch (err) {
		logger.error("Error handling reaction role add:", err);
	}
}

function clientFromChannel(channel: TextChannel): Client {
	return channel.client;
}

/**
 * Removes orphan or duplicate bot embed messages in the channel matching a specific title.
 */
async function cleanupDuplicateReactionRoleEmbeds(
	channel: TextChannel,
	title: string,
	keepMessageId: string,
): Promise<void> {
	try {
		const fetched = await channel.messages
			.fetch({ limit: 50 })
			.catch(() => null);
		if (!fetched || fetched.size === 0) return;

		const duplicates = fetched.filter((m) => {
			if (m.id === keepMessageId) return false;
			if (m.author.id !== channel.client.user?.id) return false;
			return m.embeds.some((e) => e.title === title);
		});

		for (const [, dupMsg] of duplicates) {
			await dupMsg.delete().catch(() => {});
		}
	} catch (err) {
		logger.warn(
			`Failed to cleanup duplicate reaction role embeds for title "${title}" in channel ${channel.id}:`,
			err,
		);
	}
}

/**
 * Synchronizes reaction role messages with Discord channels.
 * Posts new messages, updates existing embeds, and manages reactions.
 */
export async function syncReactionRoleMessages(
	client: Client,
	guildId?: string,
): Promise<void> {
	try {
		const rrMessages = await db.query.reactionRoleMessages.findMany({
			where: guildId ? eq(reactionRoleMessages.guildId, guildId) : undefined,
		});

		for (const msgRecord of rrMessages) {
			const guildConfig = await db.query.guildConfigs.findFirst({
				where: eq(guildConfigs.guildId, msgRecord.guildId),
			});

			const enabled = isModuleEnabled(
				guildConfig?.enabledModules,
				"reaction_role",
			);

			if (!enabled || !msgRecord.channelId) continue;

			try {
				const channel = (await client.channels
					.fetch(msgRecord.channelId)
					.catch(() => null)) as TextChannel | null;

				if (!channel?.isTextBased()) continue;

				const mappings = await db.query.reactionRoleMappings.findMany({
					where: eq(reactionRoleMappings.messageId, msgRecord.id),
				});

				// Build description with mapped emojis & roles
				const mappingLines = mappings.map((m) => {
					const desc = m.description ? ` — ${m.description}` : "";
					return `${m.emoji} — <@&${m.roleId}>${desc}`;
				});

				const description =
					mappingLines.length > 0
						? mappingLines.join("\n")
						: "No reaction roles configured yet.";

				const embed = createBaseEmbed(
					msgRecord.title,
					description,
					EMBED_COLORS.PRIMARY,
				);

				if (msgRecord.requiredRoleId) {
					const reqRoles = msgRecord.requiredRoleId
						.split(",")
						.map((r) => `<@&${r.trim()}>`)
						.join(", ");
					embed.addFields({
						name: "Required Role",
						value: reqRoles,
						inline: false,
					});
				}

				let discordMsg = msgRecord.messageId
					? await channel.messages.fetch(msgRecord.messageId).catch(() => null)
					: null;

				if (discordMsg) {
					await discordMsg.edit({ embeds: [embed] });
				} else {
					discordMsg = await channel.send({ embeds: [embed] });
					await db
						.update(reactionRoleMessages)
						.set({ messageId: discordMsg.id, updatedAt: new Date() })
						.where(eq(reactionRoleMessages.id, msgRecord.id));
				}

				// Clean up any orphan historical bot embeds matching this title in the channel
				await cleanupDuplicateReactionRoleEmbeds(
					channel,
					msgRecord.title,
					discordMsg.id,
				);

				// Add mapped reaction emojis to message
				for (const mapping of mappings) {
					try {
						await discordMsg.react(mapping.emoji);
					} catch (reactErr) {
						logger.warn(
							`Failed to add reaction ${mapping.emoji} to message ${discordMsg.id}:`,
							reactErr,
						);
					}
				}
			} catch (msgErr) {
				logger.warn(
					`Error syncing reaction role message ${msgRecord.id}:`,
					msgErr,
				);
			}
		}
	} catch (err) {
		logger.error("Error in syncReactionRoleMessages:", err);
	}
}

/**
 * Starts periodic sync loop for reaction role messages across all guilds.
 * Ensures newly created or edited reaction role menus in DB are continuously updated in Discord.
 */
export function startReactionRoleSyncLoop(
	client: Client,
	intervalMs = 15000,
): NodeJS.Timeout {
	void syncReactionRoleMessages(client);

	return setInterval(() => {
		void syncReactionRoleMessages(client);
	}, intervalMs);
}
