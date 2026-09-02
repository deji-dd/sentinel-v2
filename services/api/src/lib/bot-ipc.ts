import net from "node:net";
import { Logger } from "@sentinel/utils";
import { IPC_SOCKET_PATHS } from "@sentinel/utils/ipc";

const logger = new Logger("API", "BotIPC");

/**
 * Sends a fire-and-forget IPC message to the Discord Bot over its Unix domain socket.
 * Resolves `true` if the message was delivered, `false` if the bot is offline.
 */
export function notifyBotAction(
	action: string,
	data?: Record<string, unknown>,
	timeoutMs = 1500,
): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const client = net.createConnection(IPC_SOCKET_PATHS.bot);

		const finish = (delivered: boolean) => {
			if (settled) return;
			settled = true;
			client.destroy();
			resolve(delivered);
		};

		const timeout = setTimeout(() => finish(false), timeoutMs);

		client.on("connect", () => {
			client.write(
				`${JSON.stringify({ action, ...(data ? { data } : {}) })}\n`,
				() => {
					clearTimeout(timeout);
					finish(true);
				},
			);
		});

		client.on("error", (err) => {
			clearTimeout(timeout);
			logger.warn(`Could not reach bot via IPC (${action}):`, err.message);
			finish(false);
		});
	});
}

/**
 * Dispatches an IPC signal to the Bot to re-synchronize its registered slash commands
 * for the given guild.
 */
export async function syncGuildCommandsViaIpc(
	guildId: string,
): Promise<boolean> {
	return notifyBotAction("sync_guild_commands", { guildId });
}

/**
 * Dispatches an IPC signal to the Bot to update or refresh faction monitoring embeds
 * for the given guild.
 */
export async function syncFactionMonitoringViaIpc(
	guildId: string,
	monitorId?: string,
): Promise<boolean> {
	return notifyBotAction("sync_faction_monitoring", { guildId, monitorId });
}
