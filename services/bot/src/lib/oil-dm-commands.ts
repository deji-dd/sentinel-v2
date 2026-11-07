import type { Message } from "discord.js";

import { createBaseEmbed, createErrorEmbed, EMBED_COLORS } from "./embeds";
import { logger } from "./logger";

export type OilDmCommand = "brief" | "positions";

/**
 * The DM trigger words.
 *
 * These are deliberately the plain words the director types, with an optional
 * `!` prefix for people who still expect commands to look like commands. The
 * old `oil` and `briefing` aliases were removed: one feature should have one
 * name, and "brief" is the name used everywhere else.
 */
const TRIGGERS: Record<string, OilDmCommand> = {
	brief: "brief",
	"!brief": "brief",
	positions: "positions",
	"!positions": "positions",
};

/** Returns the command a DM body asks for, or null when it is just chat. */
export function parseOilDmCommand(content: string): OilDmCommand | null {
	return TRIGGERS[content.trim().toLowerCase()] ?? null;
}

async function fetchLiveCompanySnapshot() {
	const { tornApi } = await import("@sentinel/torn-api");
	const live = await tornApi.getPersonal("/company", {
		queryParams: { selections: ["profile", "employees", "stock"] },
	});
	return live as unknown as import("@sentinel/utils").CompanySnapshot;
}

/**
 * Handles the director's on-demand oil-rig DMs.
 *
 * Both reports are delivered by DM rather than in the reply, matching the
 * existing briefing behaviour: the content is long enough to need several
 * messages, and a DM is where the director already reads it.
 */
export async function handleOilDmCommand(
	message: Message,
	command: OilDmCommand,
): Promise<void> {
	const label =
		command === "brief" ? "Director Briefing" : "Employee Positioning";
	const standby = command === "brief" ? "briefing" : "positioning report";

	try {
		if ("sendTyping" in message.channel) {
			await message.channel.sendTyping();
		}
		await message.reply({
			embeds: [
				createBaseEmbed(
					label,
					`Analyzing... Stand by for your ${standby}.`,
					EMBED_COLORS.PRIMARY,
				),
			],
		});

		const {
			generateAndSendDirectorBriefing,
			generateAndSendEmployeePositioning,
		} = await import("@sentinel/utils");

		if (command === "brief") {
			await generateAndSendDirectorBriefing({
				useLiveData: true,
				fetchLiveData: fetchLiveCompanySnapshot,
			});
		} else {
			await generateAndSendEmployeePositioning({
				useLiveData: true,
				fetchLiveData: fetchLiveCompanySnapshot,
			});
		}
	} catch (err) {
		logger.error(`Failed to generate ${standby} in DM:`, err);
		await message.reply({
			embeds: [
				createErrorEmbed(
					`${label} Failed`,
					`Failed to generate ${standby}: ${err instanceof Error ? err.message : String(err)}`,
				),
			],
		});
	}
}
