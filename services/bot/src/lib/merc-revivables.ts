import {
	getMercContractById,
	updateMercContractRevivablesMessageId,
} from "@sentinel/database";
import type { Client } from "discord.js";
import { createBaseEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";
import { resolveChannelByName } from "./merc-alert-distributor";

export interface RevivableMemberPayload {
	id: number;
	name: string;
	level: number;
	statusState: string;
	statusDescription: string;
	statusUntil?: number | null;
	lastActionRelative?: string | null;
}

export interface UpdateMercRevivablesListData {
	guildId: string;
	contractId: string;
	channelName: string;
	factionName: string;
	factionId: number;
	members: RevivableMemberPayload[];
}

/**
 * Builds the embed for the persistent live list of revivable members for a contract.
 * Follows Sentinel standards: strictly zero emojis.
 */
export function buildMercRevivablesEmbed(
	factionName: string,
	factionId: number,
	members: RevivableMemberPayload[],
	contractId?: string,
) {
	const embed = createBaseEmbed(
		`REVIVABLE MEMBERS - ${factionName.toUpperCase()} [${factionId}]`,
		undefined,
		EMBED_COLORS.PRIMARY,
	);

	if (members.length === 0) {
		embed.setDescription(
			"No revivable members currently identified. This list refreshes automatically on every scan cycle.",
		);
		embed.setFooter({
			text: `Sentinel Mercenaries${contractId ? ` • Contract: ${contractId.slice(0, 8)}` : ""} | Auto-updated`,
		});
		return embed;
	}

	// Sort by level DESC, then name
	const sorted = [...members].sort(
		(a, b) => b.level - a.level || a.name.localeCompare(b.name),
	);

	const lines = sorted.slice(0, 50).map((m) => {
		const hospTimer =
			m.statusUntil && m.statusUntil > Date.now() / 1000
				? ` (<t:${Math.floor(m.statusUntil)}:R>)`
				: "";
		const hospDesc = m.statusDescription
			? ` | ${m.statusDescription}${hospTimer}`
			: "";
		const lastAction = m.lastActionRelative
			? ` | Last: ${m.lastActionRelative}`
			: "";
		return `• [${m.name} [${m.id}]](https://www.torn.com/profiles.php?XID=${m.id}) — Lvl ${m.level}${hospDesc}${lastAction}`;
	});

	if (sorted.length > 50) {
		lines.push(`\n...and ${sorted.length - 50} more revivable member(s).`);
	}

	embed.setDescription(lines.join("\n"));
	embed.setFooter({
		text: `Sentinel Mercenaries | Total: ${members.length}${contractId ? ` • Contract: ${contractId.slice(0, 8)}` : ""} | Auto-updated`,
	});

	return embed;
}

/**
 * Updates the persistent revivables list message in the designated Discord channel for a specific contract.
 * If the contract's message exists, edits it in place; otherwise creates a new message and saves revivablesMessageId to the contract.
 */
export async function updateMercRevivablesList(
	client: Client,
	data: UpdateMercRevivablesListData,
): Promise<void> {
	const { guildId, contractId, channelName, factionName, factionId, members } =
		data;

	const channel = await resolveChannelByName(client, guildId, channelName);
	if (!channel) {
		logger.warn(
			`Could not resolve revivables channel "${channelName}" in guild ${guildId}`,
		);
		return;
	}

	const contract = await getMercContractById(contractId);
	const embed = buildMercRevivablesEmbed(
		factionName,
		factionId,
		members,
		contractId,
	);

	let messageEdited = false;
	if (contract?.revivablesMessageId) {
		try {
			const existingMessage = await channel.messages.fetch(
				contract.revivablesMessageId,
			);
			if (existingMessage) {
				await existingMessage.edit({ embeds: [embed] });
				messageEdited = true;
			}
		} catch {
			// Message was deleted or unreachable, will post a new one below
		}
	}

	if (!messageEdited) {
		try {
			const newMessage = await channel.send({ embeds: [embed] });
			await updateMercContractRevivablesMessageId(contractId, newMessage.id);
		} catch (err) {
			logger.error(
				`Failed posting new revivables list message for contract ${contractId} in guild ${guildId} #${channel.name}:`,
				err,
			);
		}
	}
}

/**
 * Deletes the revivables embed when a contract concludes or is cancelled.
 */
export async function deleteMercRevivablesEmbed(
	client: Client,
	guildId: string,
	contractId: string,
	channelName?: string,
): Promise<void> {
	const contract = await getMercContractById(contractId);
	if (!contract?.revivablesMessageId) return;

	const targetChannelName = channelName || "revivables";
	const channel = await resolveChannelByName(
		client,
		guildId,
		targetChannelName,
	);
	if (!channel) return;

	try {
		const message = await channel.messages.fetch(contract.revivablesMessageId);
		if (message) {
			await message.delete();
		}
	} catch {}
}
