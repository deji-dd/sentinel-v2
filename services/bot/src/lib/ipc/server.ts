import { randomUUID } from "node:crypto";
import type {
	BulkVerificationProgressData,
	VerificationRequest,
	VerificationResponse,
} from "@sentinel/schemas";
import {
	type BulkVerificationResult,
	pendingBulkRequests,
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
	data: { guildId: string; channelId?: string; triggeredBy?: "admin" | "cron" },
	timeoutMs = 60000,
): Promise<BulkVerificationResult> {
	return streamBulkVerificationRequest(data, undefined, timeoutMs);
}
