import {
	ensureTargetGuildConfigs,
	getTargetGuildIds,
	isTargetGuild,
	recordBootAlert,
} from "@sentinel/database";
import { ActivityType, type Client, Events } from "discord.js";
import { startBootAlertNotifier } from "../lib/boot-notifier";
import { updateElimsArmoryStorageChannel } from "../lib/elims-armory-storage";
import { updateElimsItemRequestsChannel } from "../lib/elims-item-requests";
import { startVerificationReminderScheduler } from "../lib/elims-verification-reminder";
import { updateFactionMapChannel } from "../lib/faction-map-channel";
import { updateFactionRevivesChannel } from "../lib/faction-monitoring-channel";
import {
	startGiveawayScheduler,
	updateGiveawayChannel,
} from "../lib/giveaways";
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

		// Auto-provision configs for all configured target guilds
		await ensureTargetGuildConfigs();

		// Ensure authorized target guilds cache is fully loaded on startup
		const targetIds = await getTargetGuildIds();
		for (const [id, guild] of client.guilds.cache) {
			if (!isTargetGuild(id)) {
				logger.info(
					`Bot connected to unconfigured guild ${guild.name} (${id}). Available for dashboard setup. Target guilds: ${targetIds.join(", ")}`,
				);
			}
		}

		// Record bot boot event
		await recordBootAlert("bot");

		// Start background notifier for process boot alerts (bot, worker, api)
		startBootAlertNotifier(client);

		// Synchronize and start background periodic loop for reaction role messages (every 15s)
		startReactionRoleSyncLoop(client, 15000);

		// Synchronize Faction Map / Directory Channels across target guilds
		await updateFactionMapChannel(client);

		// Synchronize Faction Monitoring Channels across target guilds
		await updateFactionRevivesChannel(client);

		// Synchronize Elims Item Requests Channel if configured
		await updateElimsItemRequestsChannel(client).catch((err) => {
			logger.warn("Failed to sync Elims Item Requests embed on boot:", err);
		});

		// Synchronize Elims Armory Storage Channel if configured
		await updateElimsArmoryStorageChannel(client).catch((err) => {
			logger.warn("Failed to sync Elims Armory Storage embed on boot:", err);
		});

		// Synchronize Giveaway Channel if configured
		await updateGiveawayChannel(client).catch((err) => {
			logger.warn("Failed to sync Giveaway embed on boot:", err);
		});

		// Start background giveaway scheduler (15s cadence)
		startGiveawayScheduler(client);

		// Start background 1-minute verification reminder loop for approvers
		startVerificationReminderScheduler(client);
	},
};
