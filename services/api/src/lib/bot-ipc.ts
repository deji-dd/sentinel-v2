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
 * Sends a request-response IPC message to the Scheduler worker over its Unix domain socket.
 */
export function requestSchedulerAction<T = unknown>(
	action: string,
	data?: Record<string, unknown>,
	timeoutMs = 60000,
): Promise<T | null> {
	return new Promise((resolve) => {
		let settled = false;
		const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const client = net.createConnection(IPC_SOCKET_PATHS.worker);
		let buffer = "";

		const finish = (result: T | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.destroy();
			resolve(result);
		};

		const timer = setTimeout(() => {
			logger.warn(`Scheduler IPC request timed out for action ${action}`);
			finish(null);
		}, timeoutMs);

		client.on("connect", () => {
			client.write(
				`${JSON.stringify({ action, requestId, ...(data ? { data } : {}) })}\n`,
			);
		});

		client.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let idx = buffer.indexOf("\n");
			while (idx !== -1) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line) {
					try {
						const msg = JSON.parse(line) as {
							requestId?: string;
							data?: T;
						};
						if (msg.requestId === requestId) {
							finish(msg.data ?? null);
							return;
						}
					} catch {}
				}
				idx = buffer.indexOf("\n");
			}
		});

		client.on("error", (err) => {
			logger.warn(
				`Could not reach scheduler via IPC (${action}):`,
				err.message,
			);
			finish(null);
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

/**
 * Dispatches an IPC signal to the Bot to update reaction roles for the given guild.
 */
export async function syncReactionRolesViaIpc(
	guildId: string,
): Promise<boolean> {
	return notifyBotAction("sync_reaction_roles", { guildId });
}

/**
 * Dispatches an IPC signal to the Bot to refresh the faction territory map channel for the given guild.
 */
export async function syncFactionMapViaIpc(guildId: string): Promise<boolean> {
	return notifyBotAction("sync_faction_map", { guildId });
}

/**
 * Dispatches an IPC signal to the Bot when the Elims tournament guild configuration
 * (active server or admin roles) is set up or updated.
 */
export async function syncElimsGuildViaIpc(
	guildId: string,
	data?: Record<string, unknown>,
): Promise<boolean> {
	return notifyBotAction("sync_elims_guild", { guildId, ...data });
}

/**
 * Dispatches an IPC signal to the Bot when the Elims guild configuration is reset.
 */
export async function resetElimsGuildViaIpc(): Promise<boolean> {
	return notifyBotAction("reset_elims_guild");
}

/**
 * Dispatches an IPC signal to the Bot to synchronize the Elims Item Requests module
 * (channels, roles, allowed items, or embed maintenance).
 */
export async function syncElimsItemRequestsViaIpc(
	guildId: string,
	config?: Record<string, unknown>,
): Promise<boolean> {
	return notifyBotAction("sync_elims_item_requests", { guildId, config });
}

/**
 * Dispatches an IPC signal to the Bot to synchronize the Elims Giveaways module
 * (channels, roles, or persistent embed maintenance).
 */
export async function syncElimsGiveawaysViaIpc(
	guildId: string,
): Promise<boolean> {
	return notifyBotAction("sync_elims_giveaways", { guildId });
}

/**
 * Dispatches an IPC signal to the Bot to synchronize the Elims API Key Donation module
 * (persistent channel embed maintenance).
 */
export async function syncElimsKeyDonationViaIpc(
	guildId: string,
): Promise<boolean> {
	return notifyBotAction("sync_elims_key_donation", { guildId });
}

/**
 * Dispatches an IPC signal to the Bot to synchronize the Elims Live Data module
 * (persistent standings embed maintenance).
 */
export async function syncElimsLiveDataViaIpc(
	guildId: string,
	options?: {
		previousChannelId?: string | null;
		previousMessageId?: string | null;
	},
): Promise<boolean> {
	return notifyBotAction("sync_elims_live_data", {
		guildId,
		previousChannelId: options?.previousChannelId,
		previousMessageId: options?.previousMessageId,
	});
}

/**
 * Dispatches an IPC signal to the Bot when a guild is authorized in Sentinel.
 */
export async function syncAuthorizedGuildsViaIpc(
	guildId: string,
): Promise<boolean> {
	return notifyBotAction("sync_authorized_guilds", { guildId });
}

/**
 * Dispatches an IPC signal to the Bot when a guild is deauthorized.
 */
export async function deauthorizeGuildViaIpc(
	guildId: string,
): Promise<boolean> {
	return notifyBotAction("deauthorize_guild", { guildId });
}

/**
 * Dispatches an IPC signal to the Bot to auto-assign roles to guild members based on stat distribution.
 */
export async function assignElimsStatRolesViaIpc(
	guildId: string,
	roleMappings: Record<string, string>,
): Promise<boolean> {
	return notifyBotAction("elims_assign_stat_roles", { guildId, roleMappings });
}
