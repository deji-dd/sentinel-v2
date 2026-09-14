import { db, eq, workerSchedules } from "@sentinel/database";
import { Logger } from "@sentinel/utils";
import { Cron } from "croner";

/**
 * Calculates the next upcoming UTC target epoch timestamp for a given hour and minute (e.g. 3, 0 for 03:00 UTC).
 * @deprecated Use `{ type: 'cron', pattern: 'M H * * *', timezone: 'Etc/UTC' }` schedule instead.
 */
export function getNextUtcTargetTimestamp(hour: number, minute = 0): number {
	const now = new Date();
	const target = new Date(
		Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth(),
			now.getUTCDate(),
			hour,
			minute,
			0,
			0,
		),
	);

	if (now.getTime() >= target.getTime()) {
		target.setUTCDate(target.getUTCDate() + 1);
	}

	return target.getTime();
}

export type RunnerSchedule =
	| { type: "interval"; seconds: number }
	| { type: "cron"; pattern: string; timezone?: string };

export type RetryPolicy = {
	/** Maximum consecutive retry attempts on failure. Defaults to 5 for cron, 3 for interval. */
	maxRetries?: number;
	/** Initial retry backoff in ms. Defaults to 60,000ms (1m) for cron, 10,000ms (10s) for interval. */
	initialBackoffMs?: number;
	/** Maximum backoff ceiling in ms. Defaults to 3,600,000ms (1 hour) for cron, 300,000ms (5m) for interval. */
	maxBackoffMs?: number;
};

export type RunnerStatus = {
	worker: string;
	schedule:
		| { type: "interval"; seconds: number }
		| { type: "cron"; pattern: string; timezone: string };
	isExecuting: boolean;
	isStopped: boolean;
	consecutiveFailures: number;
	lastError: string | null;
	lastRunAt: number | null;
	lastSuccessAt: number | null;
	nextRunAt: number | null;
};

export type EventRunnerConfig = {
	/** Unique string ID / name of the worker job (e.g. 'torn_territory_blueprints_sync') */
	worker: string;
	/**
	 * Execution schedule: interval (in seconds) or cron expression (e.g. '0 3 * * *').
	 * Defaults to timezone 'Etc/UTC' for cron schedules if unspecified.
	 */
	schedule?: RunnerSchedule;
	/**
	 * Default execution cadence in seconds.
	 * Backward-compatible shorthand for `{ type: 'interval', seconds }`.
	 */
	defaultCadenceSeconds?: number;
	/** Optional initial delay in milliseconds to stagger boot executions */
	initialDelayMs?: number;
	/**
	 * Maximum execution time in milliseconds before the cycle is aborted.
	 * If omitted for interval workers with cadence <= 60s, defaults to 85% of interval.
	 * If omitted for cron / long workers, defaults to 5 minutes (300,000ms).
	 * Set to 0 to disable timeout.
	 */
	timeoutMs?: number;
	/** Optional custom retry and failure backoff policy */
	retryPolicy?: RetryPolicy;
	// biome-ignore lint/suspicious/noConfusingVoidType: void is required to support async handlers returning void
	handler: (signal?: AbortSignal) => Promise<number | boolean | void>;
};

export class ScheduledRunner {
	private config: EventRunnerConfig;
	private logger: Logger;
	private activeTimer: NodeJS.Timeout | null = null;
	private isExecuting = false;
	private isStopped = false;
	/** Set when triggerNow() fires while a cycle is already executing. */
	private forceRunQueued = false;
	private schedule:
		| { type: "interval"; seconds: number }
		| { type: "cron"; pattern: string; timezone: string };
	private cronInstance: Cron | null = null;

	private lastPersistedAt = 0;
	private consecutiveFailures = 0;
	private lastError: string | null = null;
	private lastSuccessAt: number | null = null;
	private lastRunAt: number | null = null;
	private nextRunAt: number | null = null;
	private retryPolicy: Required<RetryPolicy>;

	constructor(config: EventRunnerConfig) {
		this.config = config;
		this.logger = new Logger(config.worker);

		if (config.schedule) {
			if (config.schedule.type === "cron") {
				const timezone = config.schedule.timezone ?? "Etc/UTC";
				this.schedule = {
					type: "cron",
					pattern: config.schedule.pattern,
					timezone,
				};
				this.cronInstance = new Cron(config.schedule.pattern, { timezone });
			} else {
				this.schedule = {
					type: "interval",
					seconds: Math.max(1, config.schedule.seconds),
				};
			}
		} else if (config.defaultCadenceSeconds !== undefined) {
			this.schedule = {
				type: "interval",
				seconds: Math.max(1, config.defaultCadenceSeconds),
			};
		} else {
			this.schedule = {
				type: "interval",
				seconds: 86400,
			};
		}

		const isCron = this.schedule.type === "cron";
		this.retryPolicy = {
			maxRetries: config.retryPolicy?.maxRetries ?? (isCron ? 5 : 3),
			initialBackoffMs:
				config.retryPolicy?.initialBackoffMs ?? (isCron ? 60_000 : 10_000),
			maxBackoffMs:
				config.retryPolicy?.maxBackoffMs ?? (isCron ? 3_600_000 : 300_000),
		};
	}

	/**
	 * Effective execution timeout in milliseconds.
	 */
	private get effectiveTimeoutMs(): number {
		if (this.config.timeoutMs !== undefined) {
			return this.config.timeoutMs;
		}
		if (this.schedule.type === "interval" && this.schedule.seconds <= 60) {
			return Math.max(5_000, Math.floor(this.schedule.seconds * 1000 * 0.85));
		}
		return 300_000;
	}

	/**
	 * Returns the calculated next run epoch in milliseconds.
	 */
	private getNextScheduledTimeMs(): number {
		if (this.schedule.type === "cron") {
			const nextDate = this.cronInstance?.nextRun();
			return nextDate ? nextDate.getTime() : Date.now() + 86400000;
		}
		return Date.now() + this.schedule.seconds * 1000;
	}

	/**
	 * Effective cadence in seconds for DB recording.
	 */
	private get effectiveCadenceSeconds(): number {
		if (this.schedule.type === "interval") {
			return this.schedule.seconds;
		}
		return this.config.defaultCadenceSeconds ?? 86400;
	}

	/**
	 * Starts the scheduled execution loop with persistent DB state check.
	 */
	async start(): Promise<void> {
		if (this.isStopped) this.isStopped = false;

		try {
			// 1. Query persistent schedule state from database
			let schedule = await db.query.workerSchedules.findFirst({
				where: eq(workerSchedules.id, this.config.worker),
			});

			const now = Date.now();

			if (!schedule) {
				const initialNextRunAt =
					this.schedule.type === "cron" && this.cronInstance
						? (this.cronInstance.nextRun() ?? new Date(now))
						: new Date(now);

				const [createdSchedule] = await db
					.insert(workerSchedules)
					.values({
						id: this.config.worker,
						cadenceSeconds: this.effectiveCadenceSeconds,
						nextRunAt: initialNextRunAt,
					})
					.onConflictDoUpdate({
						target: workerSchedules.id,
						set: {
							cadenceSeconds: this.effectiveCadenceSeconds,
							updatedAt: new Date(),
						},
					})
					.returning();
				schedule = createdSchedule;
			}

			if (!schedule) {
				this.logger.error("Failed to initialize worker schedule state.");
				this.scheduleNext(0);
				return;
			}

			let delayMs = 0;

			// 2. Check if we have a valid future nextRunAt target and no forceRun flag
			if (
				schedule.nextRunAt &&
				schedule.nextRunAt.getTime() > now &&
				!schedule.forceRun
			) {
				delayMs = schedule.nextRunAt.getTime() - now;
			} else if (
				this.config.initialDelayMs &&
				this.config.initialDelayMs > 0 &&
				!schedule.forceRun
			) {
				delayMs = this.config.initialDelayMs;
				this.logger.info(`Staggering boot execution by ${delayMs}ms`);
			}

			this.scheduleNext(delayMs);
		} catch (err) {
			this.logger.error("Failed to load schedule from database:", err);
			// Fallback to immediate execution on DB error
			this.scheduleNext(0);
		}
	}

	private scheduleNext(delayMs: number): void {
		if (this.isStopped) return;
		if (this.activeTimer) clearTimeout(this.activeTimer);

		const safeDelay = Math.max(0, delayMs);
		this.activeTimer = setTimeout(() => this.executeAndReschedule(), safeDelay);
	}

	private async executeAndReschedule(): Promise<void> {
		if (this.isExecuting || this.isStopped) return;
		this.isExecuting = true;

		let customNextRunMs: number | undefined;
		let executionFailed = false;
		const startTime = Date.now();

		const timeoutMs = this.effectiveTimeoutMs;
		const controller = new AbortController();
		let timeoutTimer: NodeJS.Timeout | null = null;

		const timeoutPromise =
			timeoutMs > 0
				? new Promise<never>((_, reject) => {
						timeoutTimer = setTimeout(() => {
							const timeoutErr = new Error(
								`Worker '${this.config.worker}' execution timed out after ${timeoutMs}ms`,
							);
							controller.abort(timeoutErr);
							reject(timeoutErr);
						}, timeoutMs);
					})
				: null;

		try {
			const handlerPromise = this.config.handler(controller.signal);
			const result = timeoutPromise
				? await Promise.race([handlerPromise, timeoutPromise])
				: await handlerPromise;

			if (typeof result === "number") {
				customNextRunMs = result;
			}
			this.consecutiveFailures = 0;
			this.lastError = null;
			this.lastSuccessAt = Date.now();
		} catch (err) {
			executionFailed = true;
			this.consecutiveFailures++;
			this.lastError = err instanceof Error ? err.message : String(err);
			this.logger.error(
				`Worker execution failed (failure #${this.consecutiveFailures}):`,
				err,
			);
		} finally {
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
			}
			this.isExecuting = false;
			this.lastRunAt = startTime;

			if (!this.isStopped) {
				let nextRunTimeMs: number;

				if (customNextRunMs !== undefined) {
					nextRunTimeMs = customNextRunMs;
				} else if (executionFailed) {
					// Exponential backoff calculation
					const attempt = Math.min(
						this.consecutiveFailures,
						this.retryPolicy.maxRetries,
					);
					const backoffMs = Math.min(
						this.retryPolicy.initialBackoffMs * 2 ** (attempt - 1),
						this.retryPolicy.maxBackoffMs,
					);

					if (this.schedule.type === "cron") {
						const standardNext = this.getNextScheduledTimeMs();
						// Run at backoff time or next scheduled cron tick, whichever is sooner
						nextRunTimeMs = Math.min(Date.now() + backoffMs, standardNext);
						this.logger.warn(
							`Scheduling retry #${this.consecutiveFailures} in ${Math.round(backoffMs / 1000)}s (target: ${new Date(nextRunTimeMs).toISOString()})`,
						);
					} else {
						const standardCadenceMs = this.schedule.seconds * 1000;
						const effectiveBackoff = Math.max(standardCadenceMs, backoffMs);
						nextRunTimeMs = Date.now() + effectiveBackoff;
						if (this.consecutiveFailures >= 2) {
							this.logger.warn(
								`Backing off interval worker (failure #${this.consecutiveFailures}): next run in ${Math.round(effectiveBackoff / 1000)}s`,
							);
						}
					}
				} else {
					nextRunTimeMs = this.getNextScheduledTimeMs();
				}

				// A force-run arrived while this cycle was executing: re-run
				// immediately instead of waiting out the full cadence.
				if (this.forceRunQueued) {
					this.forceRunQueued = false;
					nextRunTimeMs = Date.now();
					this.logger.info(
						"Force-run was queued during execution; re-running immediately.",
					);
				}

				this.nextRunAt = nextRunTimeMs;

				const isCron = this.schedule.type === "cron";
				const shouldPersist =
					isCron ||
					executionFailed ||
					!this.lastPersistedAt ||
					startTime - this.lastPersistedAt >= 60000;

				if (shouldPersist) {
					this.lastPersistedAt = startTime;
					try {
						await db
							.insert(workerSchedules)
							.values({
								id: this.config.worker,
								cadenceSeconds: this.effectiveCadenceSeconds,
								lastRunAt: new Date(startTime),
								nextRunAt: new Date(nextRunTimeMs),
								forceRun: false,
								createdAt: new Date(),
								updatedAt: new Date(),
							})
							.onConflictDoUpdate({
								target: workerSchedules.id,
								set: {
									cadenceSeconds: this.effectiveCadenceSeconds,
									lastRunAt: new Date(startTime),
									nextRunAt: new Date(nextRunTimeMs),
									forceRun: false,
									updatedAt: new Date(),
								},
							});
					} catch (dbErr) {
						this.logger.error("Failed to persist schedule to database:", dbErr);
					}
				}

				const nextDelayMs = Math.max(0, nextRunTimeMs - Date.now());
				this.scheduleNext(nextDelayMs);
			}
		}
	}

	/**
	 * Immediately triggers execution of the worker handler, clearing any pending schedule timer.
	 * If a cycle is already executing, the trigger is queued and consumed right
	 * after the in-flight cycle finishes instead of being silently dropped
	 * (which previously also cancelled the pending schedule timer).
	 */
	triggerNow(): void {
		if (this.isExecuting) {
			this.forceRunQueued = true;
			return;
		}
		this.scheduleNext(0);
	}

	/**
	 * Flushes current in-memory schedule and execution timestamps to PostgreSQL.
	 */
	async flushPersistence(): Promise<void> {
		if (!this.lastRunAt && !this.nextRunAt) return;
		try {
			await db
				.insert(workerSchedules)
				.values({
					id: this.config.worker,
					cadenceSeconds: this.effectiveCadenceSeconds,
					lastRunAt: this.lastRunAt ? new Date(this.lastRunAt) : new Date(),
					nextRunAt: this.nextRunAt ? new Date(this.nextRunAt) : new Date(),
					forceRun: false,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.onConflictDoUpdate({
					target: workerSchedules.id,
					set: {
						cadenceSeconds: this.effectiveCadenceSeconds,
						lastRunAt: this.lastRunAt ? new Date(this.lastRunAt) : undefined,
						nextRunAt: this.nextRunAt ? new Date(this.nextRunAt) : undefined,
						forceRun: false,
						updatedAt: new Date(),
					},
				});
		} catch (dbErr) {
			this.logger.error("Failed to flush worker schedule to database:", dbErr);
		}
	}

	/**
	 * Returns current execution telemetry and health status of this runner.
	 */
	getStatus(): RunnerStatus {
		return {
			worker: this.config.worker,
			schedule: this.schedule,
			isExecuting: this.isExecuting,
			isStopped: this.isStopped,
			consecutiveFailures: this.consecutiveFailures,
			lastError: this.lastError,
			lastRunAt: this.lastRunAt,
			lastSuccessAt: this.lastSuccessAt,
			nextRunAt: this.nextRunAt,
		};
	}

	/**
	 * Stops the scheduled runner and clears pending timers.
	 */
	stop(): void {
		this.isStopped = true;
		if (this.activeTimer) {
			clearTimeout(this.activeTimer);
			this.activeTimer = null;
		}
		activeRunners.delete(this.config.worker);
	}
}

const activeRunners = new Map<string, ScheduledRunner>();

/**
 * Helper function to instantiate and start a scheduled runner.
 */
export function startEventDrivenRunner(
	config: EventRunnerConfig,
): ScheduledRunner {
	const runner = new ScheduledRunner(config);
	activeRunners.set(config.worker, runner);
	runner.start();
	return runner;
}

/**
 * Immediately triggers an active in-memory worker runner by its worker name.
 */
export function triggerWorkerByName(workerName: string): boolean {
	const runner = activeRunners.get(workerName);
	if (runner) {
		runner.triggerNow();
		return true;
	}
	return false;
}

/**
 * Stops and unregisters an active in-memory worker runner by its worker name.
 */
export function stopWorkerByName(workerName: string): boolean {
	const runner = activeRunners.get(workerName);
	if (runner) {
		runner.stop();
		return true;
	}
	return false;
}

/**
 * Stops all active runners and flushes their persistent schedule states.
 */
export async function stopAllRunners(): Promise<void> {
	const runners = Array.from(activeRunners.values());
	const promises: Promise<void>[] = [];
	for (const runner of runners) {
		runner.stop();
		promises.push(runner.flushPersistence());
	}
	await Promise.allSettled(promises);
	activeRunners.clear();
}

/**
 * Returns telemetry and status for all active in-memory runners.
 */
export function getAllRunnerStatuses(): RunnerStatus[] {
	return Array.from(activeRunners.values()).map((runner) => runner.getStatus());
}
