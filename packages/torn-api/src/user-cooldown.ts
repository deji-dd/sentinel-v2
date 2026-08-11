import { Logger } from "../../utils";

const logger = new Logger("UserCooldownManager");

/**
 * In-memory manager that tracks temporary cooldown periods per user/key.
 */
export class UserCooldownManager {
	private cooldownUntilMap = new Map<string, number>();

	/**
	 * Sets a temporary cooldown for a specific user ID for the given duration in ms.
	 * Adds a randomized jitter (0 to 10% of duration) to prevent thundering herd requests.
	 */
	setCooldown(userId: string | number, baseDurationMs: number): void {
		const key = String(userId);
		const jitter = Math.floor(Math.random() * (baseDurationMs * 0.1));
		const totalMs = baseDurationMs + jitter;
		const until = Date.now() + totalMs;

		this.cooldownUntilMap.set(key, until);

		logger.warn(
			`User ${userId} put into cooldown for ${(totalMs / 1000).toFixed(1)}s (jitter: ${(jitter / 1000).toFixed(1)}s)`,
		);
	}

	/**
	 * Checks if the user is currently in cooldown.
	 */
	isInCooldown(userId: string | number): boolean {
		const key = String(userId);
		const until = this.cooldownUntilMap.get(key);
		if (!until) return false;

		if (Date.now() >= until) {
			this.cooldownUntilMap.delete(key);
			return false;
		}

		return true;
	}

	/**
	 * Waits asynchronously until the user's cooldown expires (if active).
	 */
	async waitIfInCooldown(userId: string | number): Promise<void> {
		const key = String(userId);
		const until = this.cooldownUntilMap.get(key);
		if (!until) return;

		const remaining = until - Date.now();
		if (remaining > 0) {
			logger.info(
				`Pausing request for User ${userId} (${(remaining / 1000).toFixed(1)}s cooldown remaining)...`,
			);
			await new Promise((resolve) => setTimeout(resolve, remaining));
		}

		this.cooldownUntilMap.delete(key);
	}
}
