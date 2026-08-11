import { Logger } from "../../utils";

const logger = new Logger("UserRateLimiter");

/**
 * Sliding Window RAM rate limiter per user/key.
 * Enforces maxRequestsPerWindow (default: 50) requests per 60 seconds per user.
 * Features per-user request queuing and single-log pause locks to prevent thundering herd log spam.
 */
export class UserRateLimiter {
	private maxRequestsPerWindow: number;
	private windowMs: number;
	private userTimestamps = new Map<string, number[]>();
	private userPausePromises = new Map<string, Promise<void>>();
	private userQueueChains = new Map<string, Promise<void>>();

	constructor(maxRequestsPerWindow = 50, windowMs = 60000) {
		this.maxRequestsPerWindow = maxRequestsPerWindow;
		this.windowMs = windowMs;
	}

	/**
	 * Pauses execution if the user has reached maxRequestsPerWindow within the sliding window.
	 * Serializes checks per user to prevent duplicate log spam and thundering herd bursts.
	 */
	async waitIfNeeded(userId: string | number): Promise<void> {
		const key = String(userId);

		const currentChain = this.userQueueChains.get(key) ?? Promise.resolve();

		const nextPromise = currentChain.then(async () => {
			// If a rate limit pause is already active for this user, wait for it to expire
			const activePause = this.userPausePromises.get(key);
			if (activePause) {
				await activePause;
			}

			const now = Date.now();
			const cutoff = now - this.windowMs;

			const timestamps = (this.userTimestamps.get(key) ?? []).filter(
				(ts) => ts > cutoff,
			);

			if (timestamps.length >= this.maxRequestsPerWindow) {
				const oldestInWindow = timestamps[0];
				if (oldestInWindow !== undefined) {
					const delayNeeded = oldestInWindow + this.windowMs - now + 100; // +100ms safety buffer
					if (delayNeeded > 0) {
						logger.warn(
							`Rate limit reached for User ${userId} (${timestamps.length}/${this.maxRequestsPerWindow}). Pausing for ${(delayNeeded / 1000).toFixed(2)}s...`,
						);

						const pausePromise = new Promise<void>((resolve) => {
							setTimeout(() => {
								this.userPausePromises.delete(key);
								resolve();
							}, delayNeeded);
						});

						this.userPausePromises.set(key, pausePromise);
						await pausePromise;
					}
				}
			}

			// Record new request timestamp after wait completes
			const postWaitNow = Date.now();
			const freshCutoff = postWaitNow - this.windowMs;
			const cleanTimestamps = (this.userTimestamps.get(key) ?? []).filter(
				(ts) => ts > freshCutoff,
			);
			cleanTimestamps.push(postWaitNow);
			this.userTimestamps.set(key, cleanTimestamps);
		});

		this.userQueueChains.set(
			key,
			nextPromise.catch(() => {}),
		);

		return nextPromise;
	}

	/**
	 * Returns current number of active requests within the window for the user.
	 */
	getRequestCount(userId: string | number): number {
		const key = String(userId);
		const cutoff = Date.now() - this.windowMs;
		const timestamps = (this.userTimestamps.get(key) ?? []).filter(
			(ts) => ts > cutoff,
		);
		return timestamps.length;
	}
}
