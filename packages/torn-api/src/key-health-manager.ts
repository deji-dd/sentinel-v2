import { apiKeys, db, eq } from "../../database";
import { Logger } from "../../utils";
import { hashApiKey } from "./crypto";

const logger = new Logger("KeyHealthManager");
const INVALIDATION_THRESHOLD = 3;

/**
 * KeyHealthManager tracks invalidation counts for active API keys in-memory.
 * When a key receives 3 consecutive Error Code 2 ("Incorrect key") responses,
 * it marks isValid = false in SQLite.
 */
export class KeyHealthManager {
	private invalidCounts = new Map<string, number>();
	private pepper: string;

	constructor(pepper: string) {
		this.pepper = pepper;
	}

	/**
	 * Called when Torn API returns an error response.
	 */
	async handleInvalidKey(apiKey: string, errorCode: number): Promise<void> {
		if (errorCode !== 2) return;

		const currentCount = (this.invalidCounts.get(apiKey) ?? 0) + 1;
		this.invalidCounts.set(apiKey, currentCount);

		logger.warn(
			`API Key ending in '...${apiKey.slice(-4)}' received Error Code 2 (${currentCount}/${INVALIDATION_THRESHOLD}).`,
		);

		if (currentCount >= INVALIDATION_THRESHOLD) {
			await this.disableKey(apiKey);
		}
	}

	/**
	 * Called when a key completes a successful request.
	 */
	async recordSuccessfulUse(apiKey: string): Promise<void> {
		if (this.invalidCounts.has(apiKey)) {
			this.invalidCounts.delete(apiKey);
		}
	}

	/**
	 * Marks the key as invalid in SQLite database.
	 */
	private async disableKey(apiKey: string): Promise<void> {
		try {
			const keyHash = hashApiKey(apiKey, this.pepper);
			const updated = await db
				.update(apiKeys)
				.set({
					isValid: false,
					updatedAt: new Date(),
				})
				.where(eq(apiKeys.apiKeyHash, keyHash))
				.returning({ userId: apiKeys.userId });

			const userId = updated[0]?.userId ?? "Unknown";
			logger.warn(
				`API Key for User ${userId} disabled after ${INVALIDATION_THRESHOLD} consecutive Error Code 2 failures.`,
			);
		} catch (err) {
			logger.error("Failed to disable invalid key in SQLite:", err);
		}
	}
}
