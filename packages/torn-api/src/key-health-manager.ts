import { apiKeys, db, eq } from "../../database";
import { Logger } from "../../utils";
import { hashApiKey } from "./crypto";

const logger = new Logger("KeyHealthManager");
const INVALIDATION_THRESHOLD = 3;
export const TEMP_DISABLE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
export const TEMPORARY_DISABLE_ERROR_CODES = new Set([10, 13, 18]);

/**
 * KeyHealthManager tracks invalidation counts and temporary cooldowns for active API keys in-memory.
 * - Error Code 2 ("Incorrect key"): Marks isValid = false in SQLite after 3 consecutive failures.
 * - Error Code 13 ("Key temporarily disabled") and codes 10/18: Suppressed in-memory for 5 minutes without touching SQLite.
 */
export class KeyHealthManager {
	private invalidCounts = new Map<string, number>();
	private tempDisabledKeys = new Map<string, number>();
	private pepper: string;
	private tempCooldownMs: number;

	constructor(pepper: string, tempCooldownMs = TEMP_DISABLE_COOLDOWN_MS) {
		this.pepper = pepper;
		this.tempCooldownMs = tempCooldownMs;
	}

	/**
	 * Checks if a key is currently in temporary disable cooldown.
	 * Lazily removes expired entries.
	 */
	isKeyTemporarilyDisabled(apiKey: string): boolean {
		const expiresAt = this.tempDisabledKeys.get(apiKey);
		if (expiresAt === undefined) return false;
		if (Date.now() < expiresAt) return true;
		this.tempDisabledKeys.delete(apiKey);
		return false;
	}

	/**
	 * Marks an API key as temporarily disabled in-memory for the specified duration.
	 */
	markTemporarilyDisabled(
		apiKey: string,
		durationMs = this.tempCooldownMs,
	): void {
		this.tempDisabledKeys.set(apiKey, Date.now() + durationMs);
	}

	/**
	 * Called when Torn API returns an error response.
	 */
	async handleInvalidKey(apiKey: string, errorCode: number): Promise<void> {
		if (TEMPORARY_DISABLE_ERROR_CODES.has(errorCode)) {
			this.markTemporarilyDisabled(apiKey);
			logger.warn(
				`API Key ending in '...${apiKey.slice(-4)}' is temporarily disabled by Torn (Error Code ${errorCode}). Skipping in-memory for ${Math.round(this.tempCooldownMs / 60000)}m.`,
			);
			return;
		}

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
		if (this.tempDisabledKeys.has(apiKey)) {
			this.tempDisabledKeys.delete(apiKey);
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
