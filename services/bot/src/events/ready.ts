import { recordBootAlert } from "@sentinel/database";
import { ActivityType, type Client, Events } from "discord.js";
import { startBootAlertNotifier } from "../lib/boot-notifier";
import { updateFactionMapChannel } from "../lib/faction-map-channel";
import { logger } from "../lib/logger";
import { startReactionRoleSyncLoop } from "../lib/reaction-roles";

export const readyEvent = {
	name: Events.ClientReady,
	once: true,
	async execute(client: Client): Promise<void> {
		if (!client.user) return;

		logger.info(`Discord Bot logged in as ${client.user.tag}`);
		client.user.setActivity("Sentinel", {
			type: ActivityType.Watching,
		});

		// Record bot boot event
		await recordBootAlert("bot");

		// Start background notifier for process boot alerts (bot, worker, api)
		startBootAlertNotifier(client);

		// Synchronize and start background periodic loop for reaction role messages (every 15s)
		startReactionRoleSyncLoop(client, 15000);

		// Synchronize Faction Map / Directory Channels across all guilds
		await updateFactionMapChannel(client);
	},
} as const;
