import type {
	FactionMembersResponse,
	GuildMemberVerificationInput,
	IpcMessage,
} from "@sentinel/schemas";
import { tornApi } from "@sentinel/torn-api";
import { Logger } from "@sentinel/utils";
import type { IpcServer } from "@sentinel/utils/ipc";
import type { IpcActionHandler, IpcHandlerContext } from "../types";

const logger = new Logger("SchedulerIPC", "BotHandler");

type PendingGuildMembersRequest = {
	resolve: (members: GuildMemberVerificationInput[] | null) => void;
	timer: NodeJS.Timeout;
};

const pendingGuildMembersRequests = new Map<
	string,
	PendingGuildMembersRequest
>();

/**
 * Requests live guild member state (roles, nickname) from the Discord bot over IPC.
 * Includes configurable retries with backoff if the bot is temporarily unresponsive.
 */
export async function requestGuildMembersFromBot(
	ipcServer: IpcServer<IpcMessage> | null,
	guildId: string,
	options: { timeoutMs?: number; retries?: number } = {},
): Promise<GuildMemberVerificationInput[] | null> {
	if (!ipcServer) {
		logger.warn("Cannot request guild members: IPC server is not initialized.");
		return null;
	}

	const timeoutMs = options.timeoutMs ?? 10000;
	const retries = options.retries ?? 2;

	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt > 0) {
			logger.info(
				`[Guild ${guildId}] Retrying guild members fetch from bot (Attempt ${attempt + 1}/${retries + 1})...`,
			);
			await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
		}

		const requestId = `members-${guildId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

		const result = await new Promise<GuildMemberVerificationInput[] | null>(
			(resolve) => {
				const timer = setTimeout(() => {
					pendingGuildMembersRequests.delete(requestId);
					resolve(null);
				}, timeoutMs);

				pendingGuildMembersRequests.set(requestId, { resolve, timer });

				ipcServer.broadcast({
					action: "guild_members_request",
					requestId,
					data: { guildId },
				});
			},
		);

		if (result !== null) {
			return result;
		}
	}

	logger.warn(
		`[Guild ${guildId}] Failed to retrieve live guild members from bot after ${retries + 1} attempts. Bot may be offline.`,
	);
	return null;
}

/**
 * Handles incoming `guild_members_response` from the bot.
 */
export const handleGuildMembersResponse: IpcActionHandler = (
	ctx: IpcHandlerContext,
) => {
	const { message } = ctx;
	if (message.action !== "guild_members_response" || !message.requestId) {
		return;
	}

	const pending = pendingGuildMembersRequests.get(message.requestId);
	if (pending) {
		clearTimeout(pending.timer);
		pendingGuildMembersRequests.delete(message.requestId);
		if (message.data?.error) {
			logger.warn(
				`Error returned from bot for guild members request: ${message.data.error}`,
			);
			pending.resolve(null);
		} else {
			pending.resolve(message.data?.members ?? null);
		}
	}
};

/**
 * Handles incoming `fetch_faction_members_request` from the Discord bot.
 * Uses the Scheduler's TornApiManager instance (with key health management, rate limiting, and failover).
 */
export const handleFetchFactionMembersRequest: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const { message, server } = ctx;
	if (
		message.action !== "fetch_faction_members_request" ||
		!message.requestId ||
		!message.data
	) {
		return;
	}

	try {
		const res = (await tornApi.get("/faction/{id}/members", {
			pathParams: { id: message.data.factionId },
		})) as FactionMembersResponse;

		server.broadcast({
			action: "fetch_faction_members_response",
			requestId: message.requestId,
			data: {
				factionId: message.data.factionId,
				members: res.members ?? [],
			},
		});
	} catch (err) {
		logger.error(
			`Failed to fetch faction members for faction ${message.data.factionId}:`,
			err,
		);
		server.broadcast({
			action: "fetch_faction_members_response",
			requestId: message.requestId,
			data: {
				factionId: message.data.factionId,
				members: [],
				error:
					err instanceof Error
						? err.message
						: "Failed to fetch faction members",
			},
		});
	}
};
