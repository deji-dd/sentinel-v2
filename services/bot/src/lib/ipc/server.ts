import { randomUUID } from "node:crypto";
import type {
	BulkVerificationProgressData,
	GuildMemberVerificationInput,
	ResolvedElimsUser,
	VerificationRequest,
	VerificationResponse,
} from "@sentinel/schemas";
import { logger } from "../logger";
import {
	type BulkVerificationResult,
	pendingBulkRequests,
	pendingElimsResolveUserRequests,
	pendingElimsVerifyKeyRequests,
	pendingRequests,
	workerIpcClient,
} from "./listener";

/**
 * Sends a verification job request directly over Point-to-Point UDS to the worker process.
 */
export async function sendVerificationRequest(
	jobData: VerificationRequest,
	timeoutMs = 20000,
): Promise<VerificationResponse> {
	const requestId = randomUUID();

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(
				new Error(
					"Verification job timed out. Worker process did not respond in time.",
				),
			);
		}, timeoutMs);

		pendingRequests.set(requestId, { resolve, reject, timer });

		workerIpcClient.send({
			action: "verification_request",
			requestId,
			data: jobData,
		});
	});
}

export type BulkVerificationProgressCallback = (
	progress: BulkVerificationProgressData,
) => void | Promise<void>;

/**
 * Sends a bulk guild verification request directly over UDS to the worker engine,
 * streaming progress updates back to the caller and resetting the heartbeat timeout on each progress event.
 */
export async function streamBulkVerificationRequest(
	data: {
		guildId: string;
		channelId?: string;
		triggeredBy?: "admin" | "cron" | "user";
		members?: GuildMemberVerificationInput[];
	},
	onProgress?: BulkVerificationProgressCallback,
	inactivityTimeoutMs = 60000,
): Promise<BulkVerificationResult> {
	const requestId = randomUUID();

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingBulkRequests.delete(requestId);
			reject(
				new Error(
					"Bulk verification timed out. Worker engine did not respond in time.",
				),
			);
		}, inactivityTimeoutMs);

		pendingBulkRequests.set(requestId, {
			resolve,
			reject,
			onProgress,
			inactivityTimeoutMs,
			timer,
		});

		workerIpcClient.send({
			action: "bulk_verification_request",
			requestId,
			data,
		});
	});
}

/**
 * Sends a bulk guild verification request directly over UDS to the worker engine.
 */
export async function sendBulkVerificationRequest(
	data: {
		guildId: string;
		channelId?: string;
		triggeredBy?: "admin" | "cron";
		members?: GuildMemberVerificationInput[];
	},
	timeoutMs = 60000,
): Promise<BulkVerificationResult> {
	return streamBulkVerificationRequest(data, undefined, timeoutMs);
}

/**
 * Sends an IPC request to the scheduler worker to resolve a Discord user's live Torn identity
 * using tournament guild keys.
 */
export async function sendElimsUserResolutionRequest(
	discordId: string,
	guildId: string,
	timeoutMs = 15000,
): Promise<ResolvedElimsUser | null> {
	const requestId = randomUUID();

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingElimsResolveUserRequests.delete(requestId);
			logger.warn(
				`Elims user resolution timed out for ${discordId} in guild ${guildId}.`,
			);
			resolve(null);
		}, timeoutMs);

		pendingElimsResolveUserRequests.set(requestId, { resolve, reject, timer });

		workerIpcClient.send({
			action: "elims_resolve_user_request",
			requestId,
			data: {
				discordId,
				guildId,
			},
		});
	});
}

/**
 * Sends an IPC request to the scheduler worker to verify a candidate Torn API key.
 */
export async function sendElimsKeyVerificationRequest(
	apiKey: string,
	timeoutMs = 15000,
): Promise<{ tornId: number; tornName: string }> {
	const requestId = randomUUID();

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingElimsVerifyKeyRequests.delete(requestId);
			reject(
				new Error(
					"Elims key verification timed out. Scheduler process did not respond in time.",
				),
			);
		}, timeoutMs);

		pendingElimsVerifyKeyRequests.set(requestId, { resolve, reject, timer });

		workerIpcClient.send({
			action: "elims_verify_key_request",
			requestId,
			data: {
				apiKey,
			},
		});
	});
}
