import { Logger } from "@sentinel/utils";
import {
	type MercClaimant,
	mercTargetManager,
} from "../../../workers/merc/merc-contract-worker";
import type { IpcActionHandler, IpcHandlerContext } from "../types";

const logger = new Logger("SchedulerIPC", "MercHandler");

export const handleMercTargetMessageRecorded: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const { message } = ctx;
	if (message.action !== "merc_target_message_recorded" || !message.data) {
		return;
	}

	const contractId = message.data.contractId as string;
	const targetId = Number(message.data.targetId);
	const messageId = message.data.messageId as string;
	const channelName = message.data.channelName as string;

	if (contractId && targetId && messageId) {
		mercTargetManager.recordMessageId(
			contractId,
			targetId,
			messageId,
			channelName,
		);
	}
};

export const handleMercClaimTarget: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const { message, server } = ctx;
	if (message.action !== "merc_claim_target_request" || !message.data) {
		return;
	}

	const contractId = message.data.contractId as string;
	const targetId = Number(message.data.targetId);
	const claimant = message.data.claimant as MercClaimant;

	try {
		const result = await mercTargetManager.claimTarget(
			contractId,
			targetId,
			claimant,
		);

		if (message.requestId) {
			server.broadcast({
				action: "merc_claim_target_response",
				requestId: message.requestId,
				data: {
					success: result.success,
					reason: result.reason,
				},
			});
		}
	} catch (err) {
		logger.error("Error processing merc claim request:", err);
		if (message.requestId) {
			server.broadcast({
				action: "merc_claim_target_response",
				requestId: message.requestId,
				data: {
					success: false,
					reason: err instanceof Error ? err.message : "Internal worker error",
				},
			});
		}
	}
};

export const handleMercReleaseTarget: IpcActionHandler = async (
	ctx: IpcHandlerContext,
) => {
	const { message, server } = ctx;
	if (message.action !== "merc_release_target_request" || !message.data) {
		return;
	}

	const contractId = message.data.contractId as string;
	const targetId = Number(message.data.targetId);
	const discordUserId = message.data.discordUserId as string | undefined;

	try {
		const result = await mercTargetManager.releaseTarget(
			contractId,
			targetId,
			discordUserId,
		);

		if (message.requestId) {
			server.broadcast({
				action: "merc_release_target_response",
				requestId: message.requestId,
				data: {
					success: result.success,
					reason: result.reason,
				},
			});
		}
	} catch (err) {
		logger.error("Error processing merc release request:", err);
		if (message.requestId) {
			server.broadcast({
				action: "merc_release_target_response",
				requestId: message.requestId,
				data: {
					success: false,
					reason: err instanceof Error ? err.message : "Internal worker error",
				},
			});
		}
	}
};
