import { Logger } from "@sentinel/utils";
import {
	runBulkGuildVerification,
	runVerificationJob,
} from "../../verification";
import type { IpcActionHandler, IpcHandlerContext } from "../types";

const logger = new Logger("SchedulerIPC", "VerificationHandler");

/**
 * Handles single member verification request.
 */
export const handleVerificationRequest: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const { message, server } = ctx;
	if (message.action !== "verification_request" || !message.data) return;

	try {
		const result = await runVerificationJob(message.data);
		server.broadcast({
			action: "verification_response",
			requestId: message.requestId,
			data: result,
		});
	} catch (err) {
		logger.error("Verification job failed via IPC:", err);
		server.broadcast({
			action: "verification_response",
			requestId: message.requestId,
			data: {
				guildId: message.data.guildId,
				channelId: message.data.channelId,
				discordId: message.data.discordId,
				error: {
					message:
						err instanceof Error ? err.message : "Internal worker error.",
				},
			},
		});
	}
};

/**
 * Handles bulk guild member verification request with live progress broadcasts.
 */
export const handleBulkVerificationRequest: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const { message, server } = ctx;
	if (
		message.action !== "bulk_verification_request" ||
		!message.data?.guildId
	) {
		return;
	}

	try {
		const result = await runBulkGuildVerification(
			message.data.guildId,
			message.data.triggeredBy || "admin",
			(progress) => {
				server.broadcast({
					action: "bulk_verification_progress",
					requestId: message.requestId,
					data: progress,
				});
			},
			message.data.members,
		);
		server.broadcast({
			action: "bulk_verification_response",
			requestId: message.requestId,
			data: {
				guildId: message.data.guildId,
				...result,
			},
		});
	} catch (err) {
		logger.error("Bulk verification job failed via IPC:", err);
		const errMsg =
			err instanceof Error ? err.message : "Internal worker error.";
		server.broadcast({
			action: "bulk_verification_progress",
			requestId: message.requestId,
			data: {
				guildId: message.data.guildId,
				processed: 0,
				total: 0,
				updated: 0,
				errors: 1,
				status: "failed",
				message: errMsg,
			},
		});
		server.broadcast({
			action: "bulk_verification_response",
			requestId: message.requestId,
			data: {
				guildId: message.data.guildId,
				processed: 0,
				total: 0,
				updated: 0,
				errors: 1,
			},
		});
	}
};
