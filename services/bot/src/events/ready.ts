import {
	ensureTargetGuildConfigs,
	getTargetGuildIds,
	isTargetGuild,
	recordBootAlert,
} from "@sentinel/database";
import { ActivityType, type Client, Events } from "discord.js";
import { startBootAlertNotifier } from "../lib/boot-notifier";
import { updateFactionMapChannel } from "../lib/faction-map-channel";
import { updateFactionRevivesChannel } from "../lib/faction-monitoring-channel";
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

		// Auto-leave any unauthorized guilds
		const targetIds = await getTargetGuildIds();
		if (targetIds.length > 0) {
			for (const [id, guild] of client.guilds.cache) {
				if (!isTargetGuild(id)) {
					logger.warn(
						`Leaving unauthorized guild ${guild.name} (${id}). Target guilds: ${targetIds.join(", ")}`,
					);
					await guild.leave().catch((err) => {
						logger.error(`Failed to leave unauthorized guild ${id}:`, err);
					});
				}
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
	},
} as const;
